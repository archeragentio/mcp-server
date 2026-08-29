import type { ProviderEnvelope, ServiceDefinition, ServiceInput } from "../catalog/types.js";
import { providerEnvelopeSchema } from "../catalog/schemas.js";
import type { GatewayConfig } from "../config.js";
import { GatewayError } from "../middleware/errors.js";
import type { Metrics } from "../observability/metrics.js";
import type { ProviderClient } from "../provider/client.js";
import { assertPublicDataBoundary } from "../provider/public-boundary.js";
import type { StateStore } from "../state/index.js";
import { hashCanonical, requestFingerprint } from "./fingerprint.js";

export interface ExecutionContext { requestId: string; idempotencyKey?: string }

export class ServiceExecutor {
  constructor(readonly provider: ProviderClient, readonly state: StateStore, readonly metrics: Metrics, readonly config: GatewayConfig) {}

  async preflightIdempotency(service: ServiceDefinition, input: ServiceInput, idempotencyKey?: string): Promise<void> {
    if (service.http.method !== "POST" || idempotencyKey === undefined) return;
    const parsed = service.inputSchema.parse(input);
    const existing = await this.#stateDependency(() => this.state.get(this.#idempotencyKey(service, idempotencyKey)));
    if (!existing) return;
    const record = this.#parseIdempotencyRecord(existing);
    if (record.fingerprint !== requestFingerprint(service, parsed, this.config)) {
      throw new GatewayError(409, "conflict", "Idempotency-Key was already used with a different normalized request");
    }
    if (record.response === undefined) {
      throw new GatewayError(409, "conflict", "An identical request with this Idempotency-Key is still in progress");
    }
    this.#validatedCachedResponse(service, record.response);
  }

  async execute(service: ServiceDefinition, input: ServiceInput, context: ExecutionContext): Promise<ProviderEnvelope> {
    const parsed = service.inputSchema.parse(input);
    if (service.http.method !== "POST" || context.idempotencyKey === undefined) {
      return this.#executeProvider(service, parsed, context);
    }
    const key = this.#idempotencyKey(service, context.idempotencyKey);
    const fingerprint = requestFingerprint(service, parsed, this.config);
    const existing = await this.#stateDependency(() => this.state.get(key));
    if (existing) {
      const record = this.#parseIdempotencyRecord(existing);
      if (record.fingerprint !== fingerprint) throw new GatewayError(409, "conflict", "Idempotency-Key was already used with a different request");
      if (record.response !== undefined) return this.#validatedCachedResponse(service, record.response);
      throw new GatewayError(409, "conflict", "An identical request with this Idempotency-Key is still in progress");
    }
    if (!await this.#stateDependency(() => this.state.setIfAbsent(key, JSON.stringify({ fingerprint }), 86_400))) {
      return this.execute(service, parsed, context);
    }
    try {
      const response = await this.#executeProvider(service, parsed, context);
      await this.#stateDependency(() => this.state.set(key, JSON.stringify({ fingerprint, response }), 86_400));
      return response;
    } catch (error) {
      await this.state.delete(key).catch(() => undefined);
      throw error;
    }
  }

  #parseIdempotencyRecord(serialized: string): { fingerprint: string; response?: ProviderEnvelope } {
    try {
      const record = JSON.parse(serialized) as { fingerprint?: unknown; response?: unknown };
      if (typeof record.fingerprint !== "string") throw new Error("Invalid idempotency record");
      return {
        fingerprint: record.fingerprint,
        ...(record.response === undefined ? {} : { response: record.response as ProviderEnvelope }),
      };
    } catch {
      throw new GatewayError(503, "dependency_unavailable", "Gateway state is unavailable");
    }
  }

  #validatedCachedResponse(service: ServiceDefinition, response: ProviderEnvelope): ProviderEnvelope {
    try {
      assertPublicDataBoundary(response);
      const parsed = providerEnvelopeSchema(service.outputSchema).safeParse(response);
      if (!parsed.success) throw new Error("Invalid cached provider response");
      return parsed.data as ProviderEnvelope;
    } catch {
      throw new GatewayError(503, "dependency_unavailable", "Gateway state is unavailable");
    }
  }

  async #stateDependency<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(503, "dependency_unavailable", "Gateway state is unavailable");
    }
  }

  #idempotencyKey(service: ServiceDefinition, idempotencyKey: string): string {
    return `idempotency:${service.id}:${hashCanonical(idempotencyKey)}`;
  }

  async #executeProvider(service: ServiceDefinition, input: ServiceInput, context: ExecutionContext): Promise<ProviderEnvelope> {
    const started = performance.now();
    try { return await this.provider.execute(service, input, context.requestId, context.idempotencyKey); }
    finally { this.metrics.observe("archer_service_execution_duration_seconds", (performance.now() - started) / 1_000, { service: service.id }); }
  }
}

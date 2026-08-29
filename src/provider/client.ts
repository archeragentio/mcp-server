import type { Logger } from "pino";
import { z } from "zod";
import type { GatewayConfig } from "../config.js";
import { providerEnvelopeSchema } from "../catalog/schemas.js";
import type { ProviderEnvelope, ServiceDefinition, ServiceInput } from "../catalog/types.js";
import { GatewayError } from "../middleware/errors.js";
import type { Metrics } from "../observability/metrics.js";
import { mintProviderToken } from "./jwt.js";
import { assertPublicDataBoundary } from "./public-boundary.js";

export interface ProviderClientOptions {
  config: GatewayConfig;
  key: CryptoKey;
  logger: Logger;
  metrics: Metrics;
  fetch?: typeof globalThis.fetch;
}

export class ProviderClient {
  readonly #base: URL;
  readonly #fetch: typeof globalThis.fetch;
  constructor(readonly options: ProviderClientOptions) {
    this.#base = new URL(options.config.ARCHER_PROVIDER_BASE_URL.endsWith("/") ? options.config.ARCHER_PROVIDER_BASE_URL : `${options.config.ARCHER_PROVIDER_BASE_URL}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async execute(service: ServiceDefinition, input: ServiceInput, requestId: string, idempotencyKey?: string): Promise<ProviderEnvelope> {
    const relative = service.provider.path(input).replace(/^\/+/, "");
    const url = new URL(relative, this.#base);
    if (url.origin !== this.#base.origin || !url.pathname.startsWith(this.#base.pathname)) {
      throw new GatewayError(500, "internal_error", "Provider route escaped configured base URL");
    }
    const token = await mintProviderToken(this.options.key, this.options.config, service.scope, requestId);
    const attempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = performance.now();
      try {
        const response = await this.#fetch(url, {
          method: service.provider.method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-request-id": requestId,
            ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
          },
          ...(service.provider.method === "POST" ? { body: JSON.stringify(input) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(service.timeoutMs, this.options.config.ARCHER_PROVIDER_TIMEOUT_MS)),
        });
        this.options.metrics.increment("archer_provider_requests_total", { service: service.id, status: String(response.status) });
        this.options.metrics.observe("archer_provider_latency_ms", performance.now() - started, { service: service.id });
        const body = await readBoundedBody(response, Math.min(service.maxOutputBytes, this.options.config.ARCHER_PROVIDER_MAX_RESPONSE_BYTES));
        if (!response.ok) {
          if (response.status >= 500 && attempt < attempts) continue;
          if (response.status === 404) throw new GatewayError(404, "not_found", "Canonical resource was not found");
          if (response.status >= 500) throw new GatewayError(502, "provider_unavailable", "Archer provider is unavailable");
          throw new GatewayError(502, "provider_unavailable", "Archer provider rejected the gateway request");
        }
        if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
          throw new GatewayError(502, "provider_contract_invalid", "Provider response was not JSON");
        }
        let decoded: unknown;
        try { decoded = JSON.parse(new TextDecoder().decode(body)); }
        catch { throw new GatewayError(502, "provider_contract_invalid", "Provider returned malformed JSON"); }
        assertPublicDataBoundary(decoded);
        const parsed = providerEnvelopeSchema(service.outputSchema).safeParse(decoded);
        if (!parsed.success) {
          this.options.logger.error({ requestId, service: service.id, issues: parsed.error.issues }, "provider contract validation failed");
          throw new GatewayError(502, "provider_contract_invalid", "Provider response did not match its contract");
        }
        return parsed.data as ProviderEnvelope;
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        lastError = error;
        if (attempt === attempts) break;
      }
    }
    this.options.logger.warn({ requestId, service: service.id, errorType: lastError instanceof Error ? lastError.name : typeof lastError }, "provider unavailable");
    throw new GatewayError(502, "provider_unavailable", "Archer provider is unavailable");
  }

  async checkContract(requestId: string): Promise<void> {
    const envelope = await this.execute(PROVIDER_CONTRACT_SERVICE, {}, requestId);
    providerContractSchema.parse(envelope.data);
  }
}

const providerContractSchema = z.object({
  provider: z.literal("archer-agent"),
  apiVersion: z.literal("v1"),
  schemaVersion: z.literal(1),
});

const PROVIDER_CONTRACT_SERVICE: ServiceDefinition = {
  id: "provider.contract",
  title: "Provider contract",
  description: "Private provider contract negotiation",
  inputSchema: z.object({}),
  outputSchema: providerContractSchema,
  http: { method: "GET", path: "/internal/provider-contract" },
  mcp: { name: "internal_provider_contract", readOnly: true },
  provider: { method: "GET", path: () => "/meta/contract" },
  pricing: "cached_lookup",
  scope: "market:read",
  timeoutMs: 2_000,
  maxOutputBytes: 16_384,
};

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    throw new GatewayError(502, "response_too_large", "Provider response exceeded the configured maximum");
  }
  const responseBody = response.body as ReadableStream<Uint8Array> | null;
  if (responseBody === null) return new Uint8Array();
  const reader = responseBody.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (!done) {
    const item = await reader.read();
    if (item.done) {
      done = true;
      continue;
    }
    length += item.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new GatewayError(502, "response_too_large", "Provider response exceeded the configured maximum");
    }
    chunks.push(item.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

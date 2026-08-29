import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./app-env.js";
import type { GatewayConfig } from "./config.js";
import { parseTrustedResellers } from "./config.js";
import { publicCatalog, publicPricing } from "./discovery/catalog.js";
import { generateLlmsTxt } from "./discovery/llms.js";
import { generateOpenApi } from "./discovery/openapi.js";
import { ServiceExecutor } from "./executor/service-executor.js";
import { createArcherMcpHandler } from "./mcp/server.js";
import { errorResponse, GatewayError } from "./middleware/errors.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requestContext } from "./middleware/request-context.js";
import { createLogger } from "./observability/logger.js";
import { Metrics } from "./observability/metrics.js";
import { PaymentAudit } from "./observability/payment-audit.js";
import { installPaymentLifecycleHooks } from "./payments/lifecycle.js";
import { createPaymentStack, type PaymentStack } from "./payments/stack.js";
import { ProviderClient } from "./provider/client.js";
import { importProviderPrivateKey } from "./provider/jwt.js";
import { registerRestRoutes } from "./rest/routes.js";
import { createStateStore, type StateStore } from "./state/index.js";

export interface GatewayRuntime {
  app: Hono<AppEnv>;
  config: GatewayConfig;
  executor: ServiceExecutor;
  logger: Logger;
  metrics: Metrics;
  payment: PaymentStack;
  provider: ProviderClient;
  state: StateStore;
}

export interface CreateGatewayOptions {
  config: GatewayConfig;
  providerKey?: CryptoKey;
  providerFetch?: typeof globalThis.fetch;
  state?: StateStore;
  logger?: Logger;
  metrics?: Metrics;
  payment?: PaymentStack;
}

export async function createGateway(options: CreateGatewayOptions): Promise<GatewayRuntime> {
  const { config } = options;
  const state = options.state ?? createStateStore(config);
  const logger = options.logger ?? createLogger(config);
  const metrics = options.metrics ?? new Metrics();
  const audit = new PaymentAudit(state, logger, config);
  const payment = options.payment ?? createPaymentStack(config);
  const providerKey = options.providerKey ?? await importProviderPrivateKey(config);
  const provider = new ProviderClient({ config, key: providerKey, logger, metrics, ...(options.providerFetch === undefined ? {} : { fetch: options.providerFetch }) });
  const executor = new ServiceExecutor(provider, state, metrics, config);
  installPaymentLifecycleHooks(payment, metrics, state, config);
  await payment.initialize();

  const app = new Hono<AppEnv>();
  app.use("*", requestContext(logger, metrics, audit));
  const boundedBody = bodyLimit({
    maxSize: config.MAX_REQUEST_BODY_BYTES,
    onError: () => {
      throw new GatewayError(413, "request_too_large", "Request body is too large");
    },
  });
  app.use("/v1/*", boundedBody);
  app.use("/upstream/v1/*", boundedBody);
  app.use("/mcp", boundedBody);
  app.use("/v1/*", rateLimit(state, config.RATE_LIMIT_PER_MINUTE, "http-transport"));
  app.use("/upstream/v1/*", rateLimit(state, config.RATE_LIMIT_PER_MINUTE, "reseller-transport"));
  app.use("/mcp", rateLimit(state, config.RATE_LIMIT_PER_MINUTE, "mcp-transport"));

  const catalog = publicCatalog(config);
  const pricing = publicPricing(config);
  const openapi = generateOpenApi(config);
  const llms = generateLlmsTxt(config);
  let providerReadiness: { ready: boolean; error?: string } = { ready: false, error: "Provider contract has not been checked" };
  let stateReadiness: { ready: boolean; error?: string } = { ready: false, error: "State store has not been checked" };
  let readinessCheckedAt = Number.NEGATIVE_INFINITY;
  let readinessRefresh: Promise<void> | undefined;
  const refreshReadiness = async (): Promise<void> => {
    if (performance.now() - readinessCheckedAt < config.READINESS_CACHE_MS) return;
    if (readinessRefresh) return readinessRefresh;
    readinessRefresh = (async () => {
      await payment.initialize();
      try {
        await state.get("health:readiness");
        stateReadiness = { ready: true };
      } catch {
        stateReadiness = { ready: false, error: "State store readiness check failed" };
      }
      try {
        await provider.checkContract(randomUUID());
        providerReadiness = { ready: true };
      } catch {
        providerReadiness = { ready: false, error: "Provider contract readiness check failed" };
      } finally {
        readinessCheckedAt = performance.now();
        readinessRefresh = undefined;
      }
    })();
    return readinessRefresh;
  };

  app.get("/", (context) => context.json({
    name: "Archer Protocol Gateway",
    status: "ok",
    version: "1.0.0",
    endpoints: { mcp: "/mcp", openapi: "/openapi.json", llms: "/llms.txt", catalog: "/service-catalog.json", pricing: "/pricing.json" },
  }, 200, { "cache-control": "public, max-age=300" }));
  app.get("/service-catalog.json", (context) => context.json(catalog, 200, { "cache-control": "public, max-age=300" }));
  app.get("/pricing.json", (context) => context.json(pricing, 200, { "cache-control": "public, max-age=300" }));
  app.get("/openapi.json", (context) => context.json(openapi, 200, { "cache-control": "public, max-age=300" }));
  app.get("/llms.txt", (context) => context.text(llms, 200, { "cache-control": "public, max-age=300", "content-type": "text/plain; charset=utf-8" }));
  app.get("/health/live", (context) => context.json({ status: "live", checkedAt: new Date().toISOString() }, 200, { "cache-control": "no-store" }));
  app.get("/health/ready", async (context) => {
    await refreshReadiness();
    const ready = payment.readiness.ready && providerReadiness.ready && stateReadiness.ready;
    return context.json({
      status: ready ? "ready" : "not_ready",
      checks: {
        configuration: { ready: true },
        state: stateReadiness,
        provider: providerReadiness,
        facilitator: payment.readiness,
      },
    }, ready ? 200 : 503, { "cache-control": "no-store" });
  });
  app.get("/metrics", (context) => context.text(metrics.render(), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }));

  registerRestRoutes(app, { config, executor, payment, resellers: parseTrustedResellers(config.TRUSTED_RESELLERS_JSON), state, metrics, logger });

  const mcp = createArcherMcpHandler(config, payment, executor, metrics, state, audit);
  app.all("/mcp", async (context) => {
    const request = await prepareMcpRequest(context.req.raw, config, context.get("requestId"));
    const response = await mcp.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-request-id", context.get("requestId"));
    headers.set("cache-control", "private, no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });

  app.notFound((context) => errorResponse(new GatewayError(404, "not_found", "Route not found"), context.get("requestId")));
  app.onError((error, context) => errorResponse(error, context.get("requestId")));
  return { app, config, executor, logger, metrics, payment, provider, state };
}

async function prepareMcpRequest(request: Request, config: GatewayConfig, requestId: string): Promise<Request> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > config.MAX_REQUEST_BODY_BYTES) throw new GatewayError(413, "request_too_large", "MCP request body is too large");
  const expected = new URL(config.PUBLIC_ORIGIN);
  const host = request.headers.get("host");
  const developmentHost = config.NODE_ENV !== "production" && (host?.startsWith("localhost:") || host?.startsWith("127.0.0.1:"));
  if (host && host !== expected.host && !developmentHost) throw new GatewayError(403, "bad_request", "Host is not allowed for this MCP endpoint");
  const origin = request.headers.get("origin");
  if (origin && origin !== expected.origin && !(config.NODE_ENV !== "production" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))) {
    throw new GatewayError(403, "bad_request", "Origin is not allowed for this MCP endpoint");
  }
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  if (request.method === "GET" || request.method === "DELETE") return new Request(request, { headers });
  const requestBody = request.body as ReadableStream<Uint8Array> | null;
  if (requestBody === null) return new Request(request, { headers });
  const reader = requestBody.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      continue;
    }
    length += chunk.value.byteLength;
    if (length > config.MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new GatewayError(413, "request_too_large", "MCP request body is too large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  headers.set("content-length", String(length));
  return new Request(request.url, { method: request.method, headers, body, redirect: request.redirect });
}

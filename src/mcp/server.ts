import { randomUUID } from "node:crypto";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { GatewayConfig } from "../config.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import { providerEnvelopeSchema } from "../catalog/schemas.js";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceInput } from "../catalog/types.js";
import { publicCatalog, publicPricing } from "../discovery/catalog.js";
import { hashCanonical } from "../executor/fingerprint.js";
import type { ServiceExecutor } from "../executor/service-executor.js";
import { GatewayError, normalizeError } from "../middleware/errors.js";
import { incrementRateBucket } from "../middleware/rate-limit.js";
import type { Metrics } from "../observability/metrics.js";
import type { PaymentAudit } from "../observability/payment-audit.js";
import type { PaymentStack } from "../payments/stack.js";
import type { StateStore } from "../state/index.js";
import { McpPaymentAdapter } from "./payment-adapter.js";

export function createArcherMcpHandler(
  config: GatewayConfig,
  payment: PaymentStack,
  executor: ServiceExecutor,
  metrics: Metrics,
  state: StateStore,
  audit: PaymentAudit,
) {
  const payments = new McpPaymentAdapter(config, payment.resourceServer, metrics, state, audit, payment.fixtureLifecycleEvents);
  return createMcpHandler((requestContext) => {
    const requestId = requestContext.requestInfo?.headers.get("x-request-id") ?? randomUUID();
    const headers = requestContext.requestInfo?.headers;
    const clientIdentity = headers?.get("x-real-ip") ?? headers?.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? "unknown";
    const server = new McpServer({ name: "archer-protocol-gateway", version: "1.0.0" });

    for (const service of SERVICE_CATALOG) {
      server.registerTool(
        service.mcp.name,
        {
          title: service.title,
          description: `${service.description} Price: $${configuredPrice(config, service.pricing).usd} per call.`,
          inputSchema: service.inputSchema,
          outputSchema: providerEnvelopeSchema(service.outputSchema),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          _meta: {
            "archer/service-id": service.id,
            "archer/price-usd": configuredPrice(config, service.pricing).usd,
            "archer/payment-protocols": ["mpp", "x402"],
          },
        },
        async (args, toolContext): Promise<CallToolResult> => {
          metrics.increment("archer_mcp_tool_calls_total", { service: service.id });
          const minute = Math.floor(Date.now() / 60_000);
          const count = await incrementRateBucket(state, `rate:mcp-tool:${hashCanonical(clientIdentity)}:${String(minute)}`);
          if (count > config.MCP_TOOL_RATE_LIMIT_PER_MINUTE) {
            return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "rate_limited", message: "MCP tool rate limit exceeded", requestId } }) }] };
          }
          const input: ServiceInput = args;
          const idempotency = toolContext.mcpReq._meta?.["archer/idempotency-key"];
          try {
            if (idempotency !== undefined && (typeof idempotency !== "string" || !/^[\x21-\x7e]{1,200}$/.test(idempotency) || idempotency.includes(" "))) {
              throw new GatewayError(400, "bad_request", "archer/idempotency-key must contain 1-200 visible non-space ASCII characters");
            }
            await executor.preflightIdempotency(service, input, typeof idempotency === "string" ? idempotency : undefined);
            return await payments.invoke(service, input, toolContext.mcpReq._meta, requestId, clientIdentity, async () => executor.execute(service, input, {
              requestId,
              ...(typeof idempotency === "string" ? { idempotencyKey: idempotency } : {}),
            }));
          } catch (error) {
            const normalized = normalizeError(error);
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: { code: normalized.code, message: normalized.message, requestId } }) }],
            };
          }
        },
      );
    }

    registerJsonResource(server, "service-catalog", "archer://service-catalog", "Service Catalog", publicCatalog(config));
    registerJsonResource(server, "pricing", "archer://pricing", "Pricing and payment networks", publicPricing(config));
    registerTextResource(server, "stock-token-price-methodology", "archer://methodology/stock-token-prices", "Stock Token price methodology", "RHJ bid/ask data is an underlying-equity reference value. stockTokenEquivalent applies the current multiplier. Chart data is sampled Stock Token/USDG DEX execution-market data and must never be described as Robinhood historical equity prices.");
    registerTextResource(server, "equity-research-methodology", "archer://methodology/equity-research", "Equity research methodology", "Archer normalizes public issuer, filing, price, metric, financial, and event data. Consumers must inspect coverage tier, freshness, data gaps, warnings, and source records before relying on a result.");
    registerTextResource(server, "provenance", "archer://provenance", "Data provenance", "Each paid result is wrapped in ProviderEnvelope metadata with schemaVersion, generatedAt, and—when available—dataVersion, freshestSourceAt, sources, and warnings. Source URLs identify public upstream material; generated or inferred values remain labeled by Archer's domain schemas.");
    return server;
  });
}

function registerJsonResource(server: McpServer, name: string, uri: string, title: string, value: unknown): void {
  server.registerResource(name, uri, { title, description: title, mimeType: "application/json" }, (resourceUri) => Promise.resolve({
    contents: [{ uri: resourceUri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  }));
}

function registerTextResource(server: McpServer, name: string, uri: string, title: string, value: string): void {
  server.registerResource(name, uri, { title, description: title, mimeType: "text/plain" }, (resourceUri) => Promise.resolve({
    contents: [{ uri: resourceUri.href, mimeType: "text/plain", text: value }],
  }));
}

import { z } from "zod";
import { configuredPrice } from "../catalog/pricing.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import type { GatewayConfig } from "../config.js";
import { requirementsForDiscovery } from "../payments/offers.js";

export function generateOpenApi(config: GatewayConfig): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const service of SERVICE_CATALOG) {
    const method = service.http.method.toLowerCase();
    const input = z.toJSONSchema(service.inputSchema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, unknown>; required?: string[] };
    const pathKeys = new Set([...service.http.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((value): value is string => value !== undefined));
    const operation: Record<string, unknown> = {
      operationId: service.id.replaceAll(".", "_"),
      summary: service.title,
      description: service.description,
      tags: [service.id.split(".")[0]],
      responses: {
        "200": { description: "Paid service result", content: { "application/json": { schema: providerEnvelopeJsonSchema(service.outputSchema) } } },
        "400": { description: "Invalid input; no payment is attempted" },
        "402": { description: "MPP/x402 payment required or invalid", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } }, "WWW-Authenticate": { schema: { type: "string" } } } },
        "404": { description: "Canonical resource not found" },
        "409": { description: "Idempotency conflict" },
        "413": { description: "Request body too large" },
        "429": { description: "Rate limit exceeded" },
        "502": { description: "Private provider contract failure" },
        "503": { description: "Dependency unavailable" },
      },
      "x-payment-info": {
        priceUsd: configuredPrice(config, service.pricing).usd,
        offers: requirementsForDiscovery(service, config).flatMap((offer) => offer.network === "eip155:8453"
          ? [{ protocol: "mpp", ...offer }, { protocol: "x402", ...offer }]
          : [{ protocol: "x402", ...offer }]),
      },
    };
    if (service.http.method === "POST") {
      operation.requestBody = { required: true, content: { "application/json": { schema: input } } };
      operation.parameters = [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 200 } }];
    } else {
      operation.parameters = Object.entries(input.properties ?? {}).map(([name, schema]) => ({
        name,
        in: pathKeys.has(name) ? "path" : "query",
        required: pathKeys.has(name) || (input.required ?? []).includes(name),
        schema,
      }));
    }
    (paths[service.http.path] ??= {})[method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Archer Protocol Gateway", version: "1.0.0", description: "Paid, read-only Stock Token, equity research, and Robinhood Chain data over REST and MCP." },
    servers: [{ url: config.PUBLIC_ORIGIN }],
    paths,
    components: {
      schemas: {
        ProviderMeta: {
          type: "object",
          required: ["schemaVersion", "generatedAt"],
          properties: { schemaVersion: { const: 1 }, dataVersion: { type: "string" }, generatedAt: { type: "string", format: "date-time" }, freshestSourceAt: { type: ["string", "null"], format: "date-time" }, coverageTier: { type: "string" }, stale: { type: "boolean" }, sources: { type: "array", items: {} }, warnings: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };
}

function providerEnvelopeJsonSchema(output: z.ZodType): Record<string, unknown> {
  return {
    type: "object",
    required: ["data", "meta"],
    properties: { data: z.toJSONSchema(output, { io: "output", unrepresentable: "any" }), meta: { $ref: "#/components/schemas/ProviderMeta" } },
  };
}

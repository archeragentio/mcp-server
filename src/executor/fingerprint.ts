import { createHash } from "node:crypto";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceDefinition, ServiceInput } from "../catalog/types.js";
import type { GatewayConfig } from "../config.js";

export function requestFingerprint(service: ServiceDefinition, input: ServiceInput, config: GatewayConfig): string {
  const price = configuredPrice(config, service.pricing);
  return hashCanonical({
    serviceId: service.id,
    arguments: input,
    selectedPrice: {
      tier: service.pricing,
      usd: price.usd,
      atomic: price.atomic,
    },
  });
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

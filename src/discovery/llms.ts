import { configuredPrice } from "../catalog/pricing.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import type { GatewayConfig } from "../config.js";

export function generateLlmsTxt(config: GatewayConfig): string {
  const lines = [
    "# Archer Protocol Gateway",
    "",
    "Read-only paid access to canonical Robinhood Stock Token metadata and reference quotes, normalized public equity research, and bounded Robinhood Chain status.",
    "",
    `- MCP: ${new URL("/mcp", config.PUBLIC_ORIGIN)}`,
    `- OpenAPI 3.1: ${new URL("/openapi.json", config.PUBLIC_ORIGIN)}`,
    "- Payments: MPP Payment Auth and x402 v2",
    `- Base USDC: eip155:8453, ${config.BASE_USDC_ADDRESS}, MPP + x402, EIP-3009`,
    `- Robinhood USDG: eip155:4663, ${config.ROBINHOOD_USDG_ADDRESS}, x402 only, Permit2`,
    "",
    "## Important semantics",
    "",
    "RHJ quotes are underlying-equity reference bid/ask values. Stock Token chart data is sampled Stock Token/USDG DEX execution-market history and is never Robinhood historical equity pricing. Every research response includes freshness, sources, warnings, and version metadata when available.",
    "",
    "## Services",
    "",
    ...SERVICE_CATALOG.map((service) => `- ${service.mcp.name} | ${service.http.method} ${service.http.path} | $${configuredPrice(config, service.pricing).usd} | ${service.description}`),
    "",
    "## Free MCP resources",
    "",
    "archer://service-catalog, archer://pricing, archer://methodology/stock-token-prices, archer://methodology/equity-research, archer://provenance",
  ];
  return `${lines.join("\n")}\n`;
}

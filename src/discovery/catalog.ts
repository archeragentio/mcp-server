import { z } from "zod";
import { configuredPrice, configuredPrices } from "../catalog/pricing.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import type { GatewayConfig } from "../config.js";
import { requirementsForDiscovery } from "../payments/offers.js";

export function publicCatalog(config: GatewayConfig) {
  return {
    name: "Archer Protocol Gateway",
    version: "v1",
    transports: { rest: "/v1", mcp: "/mcp" },
    services: SERVICE_CATALOG.map((service) => ({
      id: service.id,
      title: service.title,
      description: service.description,
      http: service.http,
      mcp: service.mcp,
      priceTier: service.pricing,
      priceUsd: configuredPrice(config, service.pricing).usd,
      inputSchema: z.toJSONSchema(service.inputSchema, { io: "input", unrepresentable: "any" }),
      outputSchema: z.toJSONSchema(service.outputSchema, { io: "output", unrepresentable: "any" }),
      offers: requirementsForDiscovery(service, config).flatMap((offer) => offer.network === "eip155:8453"
        ? [{ protocol: "mpp", ...offer }, { protocol: "x402", ...offer }]
        : [{ protocol: "x402", ...offer }]),
    })),
  };
}

export function publicPricing(config: GatewayConfig) {
  return {
    currencyDecimals: 6,
    tiers: configuredPrices(config),
    networks: [
      { network: "eip155:8453", asset: config.BASE_USDC_ADDRESS, symbol: "USDC", protocols: ["mpp", "x402"], transfer: "EIP-3009" },
      { network: "eip155:4663", asset: config.ROBINHOOD_USDG_ADDRESS, symbol: "USDG", protocols: ["x402"], transfer: "Permit2" },
    ],
  };
}

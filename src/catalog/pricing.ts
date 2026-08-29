import type { GatewayConfig } from "../config.js";
import { PRICE_TIERS, type PriceTier } from "./types.js";

export interface ResolvedPrice { usd: string; atomic: string }
export type ResolvedPrices = Record<PriceTier, ResolvedPrice>;

export function configuredPrices(config: GatewayConfig): ResolvedPrices {
  return {
    free: PRICE_TIERS.free,
    cached_lookup: price(config.PRICE_CACHED_LOOKUP_USD),
    research_basic: price(config.PRICE_RESEARCH_BASIC_USD),
    research_rich: price(config.PRICE_RESEARCH_RICH_USD),
    research_heavy: price(config.PRICE_RESEARCH_HEAVY_USD),
  };
}

export function configuredPrice(config: GatewayConfig, tier: PriceTier): ResolvedPrice {
  return configuredPrices(config)[tier];
}

function price(usd: string): ResolvedPrice {
  const [whole = "0", fraction = ""] = usd.split(".");
  return { usd, atomic: `${whole}${fraction.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "") };
}

import { z } from "zod";

export const emptyInputSchema = z.object({}).strict();
export const symbolSchema = z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|[.-](?=[A-Za-z0-9])){0,15}$/).transform((value) => value.toUpperCase());
export const uuidSchema = z.uuid();
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const openOutputSchema = z.union([jsonObjectSchema, z.array(z.unknown())]);
const objectItemSchema = z.looseObject({});
const coverageTierSchema = z.enum(["full", "fundamentals_partial", "filings_only", "fund", "market_only", "unsupported"]);
const securityTypeSchema = z.enum(["common_stock", "preferred_stock", "adr", "etf", "fund", "unit", "private", "other"]);
const nonNegativeDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const signedDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);

export const stockListOutputSchema = z.looseObject({ tokens: z.array(objectItemSchema) });
export const stockPricesOutputSchema = z.looseObject({ tokens: z.array(objectItemSchema) });
export const stockPriceOutputSchema = z.looseObject({
  symbol: z.string(),
  source: z.string(),
  semantics: z.string(),
});
export const stockChartOutputSchema = z.looseObject({
  symbol: z.string(),
  tokenAddress: z.string(),
  provider: z.literal("dexscreener"),
  semantics: z.literal("dex_execution_market_price"),
  status: z.enum(["ready", "no_pair", "stale", "unavailable"]),
  pair: objectItemSchema.nullable(),
  embedUrl: z.string().nullable(),
  localFallback: z.looseObject({
    semantics: z.literal("sampled_dexscreener_execution_price"),
    interval: z.enum(["5m", "1h", "1d"]),
    candles: z.array(objectItemSchema),
  }),
});
export const researchPageOutputSchema = z.looseObject({
  items: z.array(objectItemSchema),
  nextCursor: z.string().nullable(),
});
export const researchOverviewOutputSchema = z.looseObject({ security: objectItemSchema });
export const researchFinancialsOutputSchema = z.looseObject({ observations: z.array(objectItemSchema) });
export const researchArrayOutputSchema = z.array(objectItemSchema);
export const researchComparisonOutputSchema = objectItemSchema;
export const chainStatusOutputSchema = z.looseObject({
  chainId: z.number().int(),
  ok: z.boolean(),
  connected: z.boolean(),
  sequencerHealth: z.looseObject({ ok: z.boolean() }),
  checkedAt: z.iso.datetime(),
});
export const chainStockTokensOutputSchema = z.looseObject({ tokens: z.array(objectItemSchema) });
export const corporateActionsOutputSchema = z.looseObject({ corporateActions: z.array(objectItemSchema) });

export const searchInputSchema = z.object({
  query: z.string().trim().max(120).default(""),
  coverage: z.array(coverageTierSchema).max(8).optional(),
  securityTypes: z.array(securityTypeSchema).max(12).optional(),
  sectors: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  profitability: z.enum(["profitable", "unprofitable", "unknown"]).optional(),
  growth: z.enum(["growing", "contracting", "flat", "unknown"]).optional(),
  valuation: z.enum(["available", "unavailable"]).optional(),
  liquidity: z.enum(["healthy", "thin", "stale", "unavailable"]).optional(),
  freshness: z.enum(["fresh", "stale", "unknown"]).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const securityInputSchema = z.object({ securityId: uuidSchema }).strict();
export const financialsInputSchema = securityInputSchema.extend({
  statement: z.enum(["income", "balance", "cash_flow", "shares"]).default("income"),
  periodicity: z.enum(["quarter", "annual"]).default("quarter"),
  limit: z.coerce.number().int().min(1).max(20).default(12),
});
export const filingsInputSchema = securityInputSchema.extend({
  forms: z.array(z.string().min(1).max(20)).max(20).optional(),
  category: z.enum(["fundamentals", "material_event", "proxy", "insider", "fund", "other"]).optional(),
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  query: z.string().trim().max(120).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const excerptInputSchema = securityInputSchema.extend({
  query: z.string().trim().min(2).max(200).optional(),
  chunkId: uuidSchema.optional(),
  filingId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(12).default(8),
}).superRefine((value, context) => {
  if (value.query === undefined && value.chunkId === undefined) {
    context.addIssue({ code: "custom", path: ["query"], message: "Provide query or chunkId" });
  }
});
export const limitInputSchema = securityInputSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const peersInputSchema = securityInputSchema.extend({
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
export const compareInputSchema = z.object({ securityIds: z.array(uuidSchema).min(2).max(4) }).strict();
export const screenInputSchema = z.object({
  filters: z.object({
    coverage: z.array(coverageTierSchema).max(8).optional(),
    securityTypes: z.array(securityTypeSchema).max(12).optional(),
    sectors: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    marketCapMin: nonNegativeDecimalSchema.optional(),
    marketCapMax: nonNegativeDecimalSchema.optional(),
    revenueGrowthTtmMin: signedDecimalSchema.optional(),
    operatingMarginMin: signedDecimalSchema.optional(),
    fcfYieldMin: signedDecimalSchema.optional(),
    debtToEquityMax: signedDecimalSchema.optional(),
    tokenLiquidityUsdMin: nonNegativeDecimalSchema.optional(),
    maxDataAgeHours: z.number().int().positive().max(8_760).optional(),
    includeUnknown: z.boolean().default(false),
  }).strict().default({ includeUnknown: false }),
  sort: z.object({
    field: z.enum(["display_name", "market_cap", "revenue_growth_ttm", "operating_margin", "fcf_yield", "debt_to_equity", "token_liquidity_usd", "latest_filing_at"]),
    direction: z.enum(["asc", "desc"]),
  }).strict().default({ field: "market_cap", direction: "desc" }),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const corporateActionsInputSchema = z.object({
  pendingOnly: z.boolean().default(false),
  symbol: symbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const providerMetaSchema = z.object({
  schemaVersion: z.literal(1),
  dataVersion: z.string().min(1).optional(),
  generatedAt: z.iso.datetime(),
  freshestSourceAt: z.iso.datetime().nullable().optional(),
  coverageTier: coverageTierSchema.optional(),
  stale: z.boolean().optional(),
  sources: z.array(z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
});

export function providerEnvelopeSchema(outputSchema: z.ZodType) {
  return z.object({ data: outputSchema, meta: providerMetaSchema });
}

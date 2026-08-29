import { z } from "zod";
import { PRICE_TIERS } from "./catalog/types.js";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine((value) => !/^0x0{40}$/i.test(value), "Address must not be the zero address");
const csvSchema = z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
const requiredNetworksSchema = csvSchema.pipe(z.array(z.string().regex(/^[a-z0-9]+:[A-Za-z0-9._-]+$/)).superRefine((networks, context) => {
  for (const required of ["eip155:8453", "eip155:4663"]) {
    if (!networks.includes(required)) context.addIssue({ code: "custom", message: `Required payment network missing: ${required}` });
  }
}));
const usdPriceSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).refine((value) => Number(value) > 0, "Price must be greater than zero");
const booleanFromString = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  PUBLIC_ORIGIN: z.url().default("http://127.0.0.1:3100"),
  ARCHER_PROVIDER_BASE_URL: z.url().default("http://127.0.0.1:3000/api/provider/v1"),
  ARCHER_PROVIDER_ISSUER: z.string().min(1).default("archer-protocol-gateway"),
  ARCHER_PROVIDER_AUDIENCE: z.string().min(1).default("archer-provider-v1"),
  ARCHER_PROVIDER_PRIVATE_KEY: z.string().optional(),
  ARCHER_PROVIDER_KEY_ID: z.string().min(1).default("gateway-main"),
  ARCHER_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  ARCHER_PROVIDER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(2_000_000),
  MPP_SECRET_KEY: z.string().min(32).optional(),
  PAYMENT_RECIPIENT: addressSchema.optional(),
  X402_FACILITATOR_URL: z.url().default("https://facilitator.meshgateway.co"),
  X402_FACILITATOR_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  X402_REQUIRED_NETWORKS: requiredNetworksSchema.default(["eip155:8453", "eip155:4663"]),
  BASE_USDC_ADDRESS: addressSchema.default("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  ROBINHOOD_USDG_ADDRESS: addressSchema.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  PRICE_CACHED_LOOKUP_USD: usdPriceSchema.default(PRICE_TIERS.cached_lookup.usd),
  PRICE_RESEARCH_BASIC_USD: usdPriceSchema.default(PRICE_TIERS.research_basic.usd),
  PRICE_RESEARCH_RICH_USD: usdPriceSchema.default(PRICE_TIERS.research_rich.usd),
  PRICE_RESEARCH_HEAVY_USD: usdPriceSchema.default(PRICE_TIERS.research_heavy.usd),
  TRUSTED_RESELLERS_JSON: z.string().default("[]"),
  STATE_STORE_URL: z.url().optional(),
  STATE_KEY_PREFIX: z.string().min(1).max(100).default("archer-protocol-gateway:"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PAYMENT_MODE: z.enum(["live", "fixture"]).default("live"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  CHALLENGE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PAID_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  MCP_TOOL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  PAYMENT_AUDIT_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  READINESS_CACHE_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_000_000).default(64_000),
  DATA_REDISTRIBUTION_APPROVED: booleanFromString,
  PROTOCOL_CONFORMANCE_APPROVED: booleanFromString,
  REAL_SETTLEMENTS_VERIFIED: booleanFromString,
  RESELLER_INTEGRATION_APPROVED: booleanFromString,
});

export type GatewayConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(environment);
  const publicOrigin = new URL(parsed.PUBLIC_ORIGIN);
  if (publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) {
    throw new Error("PUBLIC_ORIGIN must be an origin without credentials, path, query, or fragment");
  }
  if (parsed.NODE_ENV === "production" && parsed.PAYMENT_MODE === "fixture") {
    throw new Error("PAYMENT_MODE=fixture is forbidden in production");
  }
  if (parsed.PAYMENT_MODE === "live") {
    const missing = [
      parsed.ARCHER_PROVIDER_PRIVATE_KEY ? undefined : "ARCHER_PROVIDER_PRIVATE_KEY",
      parsed.MPP_SECRET_KEY ? undefined : "MPP_SECRET_KEY",
      parsed.PAYMENT_RECIPIENT ? undefined : "PAYMENT_RECIPIENT",
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) {
      throw new Error(`Missing live gateway configuration: ${missing.join(", ")}`);
    }
    if (parsed.NODE_ENV === "production" && publicOrigin.protocol !== "https:") {
      throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
    }
    if (parsed.NODE_ENV === "production" && !["127.0.0.1", "::1", "localhost"].includes(parsed.HOST)) {
      throw new Error("HOST must bind to loopback in production");
    }
    if (parsed.NODE_ENV === "production" && new URL(parsed.X402_FACILITATOR_URL).protocol !== "https:") {
      throw new Error("X402_FACILITATOR_URL must use HTTPS in production");
    }
    const providerUrl = new URL(parsed.ARCHER_PROVIDER_BASE_URL);
    const facilitatorUrl = new URL(parsed.X402_FACILITATOR_URL);
    if (providerUrl.username || providerUrl.password || facilitatorUrl.username || facilitatorUrl.password) {
      throw new Error("Provider and facilitator URLs must not contain credentials");
    }
    if (providerUrl.search || providerUrl.hash || facilitatorUrl.search || facilitatorUrl.hash) {
      throw new Error("Provider and facilitator URLs must not contain query strings or fragments");
    }
    const providerIsLoopback = providerUrl.hostname === "127.0.0.1" || providerUrl.hostname === "localhost" || providerUrl.hostname === "[::1]";
    if (parsed.NODE_ENV === "production" && providerUrl.protocol !== "https:" && !(providerUrl.protocol === "http:" && providerIsLoopback)) {
      throw new Error("ARCHER_PROVIDER_BASE_URL must use HTTPS unless it is loopback");
    }
    if (parsed.NODE_ENV === "production") {
      const incomplete = [
        parsed.DATA_REDISTRIBUTION_APPROVED ? undefined : "DATA_REDISTRIBUTION_APPROVED",
        parsed.PROTOCOL_CONFORMANCE_APPROVED ? undefined : "PROTOCOL_CONFORMANCE_APPROVED",
        parsed.REAL_SETTLEMENTS_VERIFIED ? undefined : "REAL_SETTLEMENTS_VERIFIED",
        parsed.STATE_STORE_URL ? undefined : "STATE_STORE_URL",
      ].filter((value): value is string => value !== undefined);
      if (incomplete.length > 0) throw new Error(`Production launch gates are incomplete: ${incomplete.join(", ")}`);
      if (parseTrustedResellers(parsed.TRUSTED_RESELLERS_JSON).length > 0 && !parsed.RESELLER_INTEGRATION_APPROVED) {
        throw new Error("RESELLER_INTEGRATION_APPROVED is required when production resellers are configured");
      }
    }
  }
  return parsed;
}

export const fixtureConfig = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  ...envSchema.parse({ NODE_ENV: "test", PAYMENT_MODE: "fixture" }),
  ARCHER_PROVIDER_PRIVATE_KEY: "fixture-key-is-injected",
  MPP_SECRET_KEY: "fixture-mpp-secret-key-at-least-32-bytes-long",
  PAYMENT_RECIPIENT: "0x1111111111111111111111111111111111111111",
  ...overrides,
});

export function parseTrustedResellers(value: string): TrustedResellerConfig[] {
  const decoded = JSON.parse(value) as unknown;
  const bodySchema = z.object({
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/i),
    scopes: z.array(z.string().min(1)).min(1),
    routes: z.array(z.string().min(1)).min(1).default(["/upstream/v1/*"]),
    rateLimitPerMinute: z.number().int().positive().default(120),
    enabled: z.boolean().default(true),
    disabledAt: z.iso.datetime().optional(),
  });
  const array = z.array(bodySchema.extend({ id: z.string().min(1) })).safeParse(decoded);
  if (array.success) return array.data;
  const record = z.record(z.string().min(1), bodySchema).parse(decoded);
  return Object.entries(record).map(([id, config]) => ({ id, ...config }));
}

export interface TrustedResellerConfig {
  id: string;
  tokenHash: string;
  scopes: string[];
  routes: string[];
  rateLimitPerMinute: number;
  enabled: boolean;
  disabledAt?: string | undefined;
}

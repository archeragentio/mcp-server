import type { ZodType } from "zod";

export const PRICE_TIERS = {
  free: { usd: "0", atomic: "0" },
  cached_lookup: { usd: "0.001", atomic: "1000" },
  research_basic: { usd: "0.003", atomic: "3000" },
  research_rich: { usd: "0.005", atomic: "5000" },
  research_heavy: { usd: "0.010", atomic: "10000" },
} as const;

export type PriceTier = keyof typeof PRICE_TIERS;
export type ServiceInput = Record<string, unknown>;

export interface ServiceDefinition {
  id: string;
  title: string;
  description: string;
  inputSchema: ZodType<ServiceInput>;
  outputSchema: ZodType;
  http: { method: "GET" | "POST"; path: string };
  mcp: { name: string; readOnly: true };
  provider: { method: "GET" | "POST"; path: (input: ServiceInput) => string };
  pricing: Exclude<PriceTier, "free">;
  scope: "market:read" | "research:read" | "chain:read";
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProviderMeta {
  schemaVersion: 1;
  dataVersion?: string;
  generatedAt: string;
  freshestSourceAt?: string | null;
  coverageTier?: string;
  stale?: boolean;
  sources?: unknown[];
  warnings?: string[];
}

export interface ProviderEnvelope<T = unknown> {
  data: T;
  meta: ProviderMeta;
}

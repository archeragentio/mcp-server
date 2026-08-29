import { Challenge, Credential } from "mppx";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceDefinition } from "../catalog/types.js";
import type { GatewayConfig } from "../config.js";

export const MPP_CHALLENGE_TTL_SECONDS = 60;
export const MPP_SCOPE_META_KEY = "_mppx_scope";

export function mppChallengeExpiry(): Date {
  return new Date(Date.now() + MPP_CHALLENGE_TTL_SECONDS * 1_000);
}

export function extractMppCredentialHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Credential.extractPaymentScheme(value) ?? undefined;
}

export function parseMppCredential(value: unknown): Credential.Credential | undefined {
  try {
    if (typeof value === "string") return Credential.deserialize(value);
    if (typeof value !== "object" || value === null) return undefined;
    return Credential.deserialize(Credential.serialize(value as Credential.Credential));
  } catch {
    return undefined;
  }
}

export function isMppChallengeForService(
  challenge: Credential.Credential["challenge"],
  service: ServiceDefinition,
  config: GatewayConfig,
  expectedScope: string,
): boolean {
  const request = challenge.request;
  const methodDetails = request["methodDetails"] as Record<string, unknown> | undefined;
  const credentialTypes = methodDetails?.["credentialTypes"];
  const price = configuredPrice(config, service.pricing);
  const now = Date.now();
  const expiresAt = challenge.expires === undefined ? Number.NaN : Date.parse(challenge.expires);
  return Challenge.verify(challenge, { secretKey: config.MPP_SECRET_KEY ?? "" })
    && challenge.realm === new URL(config.PUBLIC_ORIGIN).hostname
    && Number.isFinite(expiresAt)
    && expiresAt > now
    && expiresAt <= now + (MPP_CHALLENGE_TTL_SECONDS + 5) * 1_000
    && challenge.method === "evm"
    && challenge.intent === "charge"
    && challengeMeta(challenge)?.["service"] === service.id
    && challengeMeta(challenge)?.[MPP_SCOPE_META_KEY] === expectedScope
    && request["amount"] === price.atomic
    && methodDetails?.["chainId"] === 8453
    && methodDetails["decimals"] === 6
    && Array.isArray(credentialTypes)
    && credentialTypes.length === 1
    && credentialTypes[0] === "authorization"
    && String(request["currency"]).toLowerCase() === config.BASE_USDC_ADDRESS.toLowerCase()
    && String(request["recipient"]).toLowerCase() === config.PAYMENT_RECIPIENT?.toLowerCase();
}

export function mppMcpScope(service: ServiceDefinition): string {
  return `mcp:${service.mcp.name}`;
}

export function mppHttpScope(service: ServiceDefinition, config: GatewayConfig): string {
  return new URL(service.http.path, config.PUBLIC_ORIGIN).toString();
}

function challengeMeta(challenge: Credential.Credential["challenge"]): Record<string, string> | undefined {
  const direct = Challenge.meta(challenge);
  if (direct) return direct;
  if (!challenge.opaque) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(challenge.opaque, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const entries = Object.entries(decoded as Record<string, unknown>);
    if (!entries.every(([, value]) => typeof value === "string")) return undefined;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return undefined;
  }
}

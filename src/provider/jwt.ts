import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { GatewayConfig } from "../config.js";

export async function importProviderPrivateKey(config: GatewayConfig): Promise<CryptoKey> {
  if (!config.ARCHER_PROVIDER_PRIVATE_KEY) throw new Error("ARCHER_PROVIDER_PRIVATE_KEY is required");
  return importPKCS8(config.ARCHER_PROVIDER_PRIVATE_KEY.replaceAll("\\n", "\n"), "EdDSA");
}

export async function mintProviderToken(
  key: CryptoKey,
  config: Pick<GatewayConfig, "ARCHER_PROVIDER_ISSUER" | "ARCHER_PROVIDER_AUDIENCE" | "ARCHER_PROVIDER_KEY_ID">,
  scope: string,
  requestId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ scope: [scope], requestId })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: config.ARCHER_PROVIDER_KEY_ID })
    .setIssuer(config.ARCHER_PROVIDER_ISSUER)
    .setAudience(config.ARCHER_PROVIDER_AUDIENCE)
    .setSubject("gateway")
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now - 2)
    .setExpirationTime(now + 60)
    .sign(key);
}

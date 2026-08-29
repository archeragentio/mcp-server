import { createHash } from "node:crypto";

export const FIXTURE_RESELLER_TOKEN = "archer-fixture-reseller-token-not-a-production-secret";

export function fixtureResellersJson(): string {
  return JSON.stringify({
    "fixture-marketplace": {
      tokenHash: createHash("sha256").update(FIXTURE_RESELLER_TOKEN).digest("hex"),
      scopes: ["*"],
      routes: ["/upstream/v1/*"],
      rateLimitPerMinute: 10_000,
      enabled: true,
    },
  });
}

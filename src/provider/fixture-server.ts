import { jwtVerify } from "jose";
import { Hono } from "hono";

const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export interface ProviderFixture {
  app: Hono;
  calls: Map<string, number>;
}

export function createProviderFixture(publicKey: CryptoKey): ProviderFixture {
  const app = new Hono();
  const calls = new Map<string, number>();
  app.use("/api/provider/v1/*", async (context, next) => {
    const authorization = context.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) return context.json({ error: { code: "unauthorized", message: "Provider bearer JWT required" } }, 401);
    try {
      const verified = await jwtVerify(authorization.slice(7), publicKey, {
        algorithms: ["EdDSA"],
        issuer: "archer-protocol-gateway",
        audience: "archer-provider-v1",
        clockTolerance: 2,
      });
      const issued = verified.payload.iat;
      const expires = verified.payload.exp;
      if (issued === undefined || expires === undefined || expires - issued > 60) throw new Error("JWT lifetime exceeds 60 seconds");
      const scope = typeof verified.payload.scope === "string"
        ? verified.payload.scope.split(" ")
        : Array.isArray(verified.payload.scope) ? verified.payload.scope.filter((item): item is string => typeof item === "string") : [];
      const required = requiredScope(context.req.path);
      if (!scope.includes(required)) return context.json({ error: { code: "forbidden", message: `Missing ${required}` } }, 403);
    } catch {
      return context.json({ error: { code: "unauthorized", message: "Provider bearer JWT is invalid" } }, 401);
    }
    await next();
  });

  app.all("/api/provider/v1/*", async (context) => {
    const relative = context.req.path.slice("/api/provider/v1".length);
    calls.set(relative, (calls.get(relative) ?? 0) + 1);
    const body = context.req.method === "POST" ? await context.req.json<Record<string, unknown>>() : undefined;
    const data = fixtureData(relative, body);
    if (data === undefined) return context.json({ error: { code: "not_found", message: "Fixture resource not found" } }, 404);
    return context.json({
      data,
      meta: {
        schemaVersion: 1,
        dataVersion: "fixture-1",
        generatedAt: FIXTURE_TIMESTAMP,
        freshestSourceAt: FIXTURE_TIMESTAMP,
        sources: [{ id: "fixture", provider: "archer_fixture", label: "Deterministic local fixture" }],
        warnings: [],
      },
    });
  });
  return { app, calls };
}

function requiredScope(path: string): "market:read" | "research:read" | "chain:read" {
  if (path.includes("/research/")) return "research:read";
  if (path.includes("/chain/")) return "chain:read";
  return "market:read";
}

function fixtureData(path: string, body: Record<string, unknown> | undefined): unknown {
  if (path === "/meta/contract") return { provider: "archer-agent", apiVersion: "v1", schemaVersion: 1 };
  if (path === "/stocks") return { chainId: 4663, generatedAt: FIXTURE_TIMESTAMP, tokens: [{ symbol: "AAPL", name: "Apple Stock Token", currentMultiplier: "1", status: "active" }] };
  if (path === "/stocks/prices") return { chainId: 4663, source: "robinhood_rhj_rest", semantics: "raw_underlying_equity_bid_ask", tokens: [{ symbol: "AAPL", bid: "230.10", ask: "230.20" }] };
  if (path === "/stocks/MISSING/price") return undefined;
  if (/^\/stocks\/[^/]+\/price$/.test(path)) return { symbol: path.split("/")[2], source: "robinhood_rhj_rest", semantics: "raw_underlying_equity_bid_ask", quote: { currency: "USD", bid: "230.10", ask: "230.20", generatedAt: FIXTURE_TIMESTAMP }, stockTokenEquivalent: { currentMultiplier: "1", bidUsd: "230.10", askUsd: "230.20" } };
  if (/^\/stocks\/[^/]+\/chart$/.test(path)) return {
    symbol: path.split("/")[2],
    tokenAddress: "0x3333333333333333333333333333333333333333",
    provider: "dexscreener",
    semantics: "dex_execution_market_price",
    status: "ready",
    pair: { pairId: "fixture-pair", dexId: "fixture-dex", pairUrl: null, liquidityUsd: "1000000", volume24hUsd: "50000" },
    embedUrl: null,
    localFallback: { semantics: "sampled_dexscreener_execution_price", interval: "1h", candles: [] },
  };
  if (path.startsWith("/research/securities") && !/^\/research\/securities\/[^/]+\//.test(path)) return { items: [{ security: { id: "00000000-0000-4000-8000-000000000001", displayName: "Fixture Corp", tickers: ["FIX"] } }], nextCursor: null };
  if (/^\/research\/securities\/[^/]+\/overview$/.test(path)) return { security: { id: path.split("/")[3], displayName: "Fixture Corp" }, prices: [], metrics: [], financialTrend: [], latestFilings: [], recentEvents: [], dataGaps: [] };
  if (/^\/research\/securities\/[^/]+\/financials/.test(path)) return { securityId: path.split("/")[3], statement: "income", periodicity: "quarter", observations: [] };
  if (/^\/research\/securities\/[^/]+\/metrics$/.test(path)) return [];
  if (/^\/research\/securities\/[^/]+\/filings/.test(path)) return { items: [], nextCursor: null };
  if (/^\/research\/securities\/[^/]+\/excerpts/.test(path)) return [];
  if (/^\/research\/securities\/[^/]+\/events/.test(path)) return [];
  if (/^\/research\/securities\/[^/]+\/peers/.test(path)) return [];
  if (/^\/research\/securities\/[^/]+\/sources$/.test(path)) return [];
  if (path === "/research/compare") return { securities: body?.securityIds ?? [], rows: [] };
  if (path === "/research/screen") return { items: [], nextCursor: null };
  if (path === "/chain/status") return { chainId: 4663, ok: true, connected: true, sequencerHealth: { ok: true }, checkedAt: FIXTURE_TIMESTAMP };
  if (path === "/chain/stock-tokens") return { chainId: 4663, generatedAt: FIXTURE_TIMESTAMP, tokens: [{ symbol: "AAPL", name: "Apple Stock Token", currentMultiplier: "1" }] };
  if (path.startsWith("/chain/corporate-actions")) return { corporateActions: [] };
  return undefined;
}

import { z } from "zod";
import {
  compareInputSchema,
  chainStatusOutputSchema,
  chainStockTokensOutputSchema,
  corporateActionsInputSchema,
  corporateActionsOutputSchema,
  emptyInputSchema,
  excerptInputSchema,
  filingsInputSchema,
  financialsInputSchema,
  limitInputSchema,
  peersInputSchema,
  researchArrayOutputSchema,
  researchComparisonOutputSchema,
  researchFinancialsOutputSchema,
  researchOverviewOutputSchema,
  researchPageOutputSchema,
  searchInputSchema,
  securityInputSchema,
  screenInputSchema,
  stockChartOutputSchema,
  stockListOutputSchema,
  stockPriceOutputSchema,
  stockPricesOutputSchema,
  symbolSchema,
} from "./schemas.js";
import { PRICE_TIERS, type ServiceDefinition, type ServiceInput } from "./types.js";

const enc = encodeURIComponent;
const query = (input: ServiceInput, excluded: string[] = []): string => {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (excluded.includes(key) || value === undefined) continue;
    values.set(key, queryValue(value));
  }
  const encoded = values.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
};
const queryValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(queryValue).join(",");
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
};
const service = (definition: ServiceDefinition): ServiceDefinition => definition;
const GET_DEFAULTS = { timeoutMs: 5_000, maxOutputBytes: 2_000_000 } as const;

export const SERVICE_CATALOG: readonly ServiceDefinition[] = [
  service({ id: "stocks.list", title: "Stock Tokens", description: "List Archer's canonical Robinhood Stock Token registry and multiplier state.", inputSchema: emptyInputSchema, outputSchema: stockListOutputSchema, http: { method: "GET", path: "/v1/stocks" }, mcp: { name: "list_stock_tokens", readOnly: true }, provider: { method: "GET", path: () => "/stocks" }, pricing: "cached_lookup", scope: "market:read", ...GET_DEFAULTS }),
  service({ id: "stocks.prices", title: "Stock Token Prices", description: "Get the cached RHJ underlying-equity reference quote universe; values are not DEX execution prices.", inputSchema: emptyInputSchema, outputSchema: stockPricesOutputSchema, http: { method: "GET", path: "/v1/stocks/prices" }, mcp: { name: "get_stock_token_prices", readOnly: true }, provider: { method: "GET", path: () => "/stocks/prices" }, pricing: "cached_lookup", scope: "market:read", ...GET_DEFAULTS }),
  service({ id: "stocks.price", title: "Stock Token Price", description: "Get a cached RHJ underlying-equity reference quote and multiplier-derived token equivalent.", inputSchema: z.object({ symbol: symbolSchema }), outputSchema: stockPriceOutputSchema, http: { method: "GET", path: "/v1/stocks/{symbol}/price" }, mcp: { name: "get_stock_token_price", readOnly: true }, provider: { method: "GET", path: (i) => `/stocks/${enc(String(i.symbol))}/price` }, pricing: "cached_lookup", scope: "market:read", ...GET_DEFAULTS }),
  service({ id: "stocks.chart", title: "Stock Token Chart", description: "Get sampled Stock Token/USDG DEX execution-market history; never Robinhood equity history.", inputSchema: z.object({ symbol: symbolSchema }), outputSchema: stockChartOutputSchema, http: { method: "GET", path: "/v1/stocks/{symbol}/chart" }, mcp: { name: "get_stock_token_chart", readOnly: true }, provider: { method: "GET", path: (i) => `/stocks/${enc(String(i.symbol))}/chart` }, pricing: "research_basic", scope: "market:read", ...GET_DEFAULTS }),

  service({ id: "research.search", title: "Search Equity Research", description: "Search Archer's normalized public equity research universe.", inputSchema: searchInputSchema, outputSchema: researchPageOutputSchema, http: { method: "GET", path: "/v1/research/securities" }, mcp: { name: "search_equity_research", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities${query(i)}` }, pricing: "cached_lookup", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.overview", title: "Equity Research Overview", description: "Get a security overview with prices, metrics, filings, events, provenance, and data gaps.", inputSchema: securityInputSchema, outputSchema: researchOverviewOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/overview" }, mcp: { name: "get_equity_research_overview", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/overview` }, pricing: "research_rich", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.financials", title: "Equity Financials", description: "Get normalized reported financial statement observations.", inputSchema: financialsInputSchema, outputSchema: researchFinancialsOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/financials" }, mcp: { name: "get_equity_financials", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/financials${query(i, ["securityId"])}` }, pricing: "research_rich", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.metrics", title: "Equity Metrics", description: "Get normalized sourced equity metrics.", inputSchema: securityInputSchema, outputSchema: researchArrayOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/metrics" }, mcp: { name: "get_equity_metrics", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/metrics` }, pricing: "research_basic", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.filings", title: "Equity Filings", description: "List normalized public filings for a security.", inputSchema: filingsInputSchema, outputSchema: researchPageOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/filings" }, mcp: { name: "get_equity_filings", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/filings${query(i, ["securityId"])}` }, pricing: "research_rich", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.excerpt", title: "Equity Filing Excerpt", description: "Search or retrieve stable public filing excerpts with source identifiers.", inputSchema: excerptInputSchema, outputSchema: researchArrayOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/excerpts" }, mcp: { name: "get_equity_filing_excerpt", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/excerpts${query(i, ["securityId"])}` }, pricing: "research_heavy", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.events", title: "Equity Events", description: "List normalized public events and catalysts for a security.", inputSchema: limitInputSchema, outputSchema: researchArrayOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/events" }, mcp: { name: "get_equity_events", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/events${query(i, ["securityId"])}` }, pricing: "research_basic", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.compare", title: "Compare Equities", description: "Compare two to four securities using normalized sourced metrics.", inputSchema: compareInputSchema, outputSchema: researchComparisonOutputSchema, http: { method: "POST", path: "/v1/research/compare" }, mcp: { name: "compare_equities", readOnly: true }, provider: { method: "POST", path: () => "/research/compare" }, pricing: "research_heavy", scope: "research:read", timeoutMs: 8_000, maxOutputBytes: 3_000_000 }),
  service({ id: "research.screen", title: "Screen Equities", description: "Screen the normalized public equity universe with bounded filters.", inputSchema: screenInputSchema, outputSchema: researchPageOutputSchema, http: { method: "POST", path: "/v1/research/screen" }, mcp: { name: "screen_equities", readOnly: true }, provider: { method: "POST", path: () => "/research/screen" }, pricing: "research_heavy", scope: "research:read", timeoutMs: 8_000, maxOutputBytes: 3_000_000 }),
  service({ id: "research.peers", title: "Equity Peers", description: "Get comparable public securities and comparison reasons.", inputSchema: peersInputSchema, outputSchema: researchArrayOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/peers" }, mcp: { name: "get_equity_peers", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/peers${query(i, ["securityId"])}` }, pricing: "research_basic", scope: "research:read", ...GET_DEFAULTS }),
  service({ id: "research.sources", title: "Equity Research Sources", description: "Get provenance records for a security's public research data.", inputSchema: securityInputSchema, outputSchema: researchArrayOutputSchema, http: { method: "GET", path: "/v1/research/securities/{securityId}/sources" }, mcp: { name: "get_equity_research_sources", readOnly: true }, provider: { method: "GET", path: (i) => `/research/securities/${enc(String(i.securityId))}/sources` }, pricing: "cached_lookup", scope: "research:read", ...GET_DEFAULTS }),

  service({ id: "chain.status", title: "Robinhood Chain Status", description: "Get bounded Robinhood Chain connectivity, sequencer, gas, bridge, and rollup status.", inputSchema: emptyInputSchema, outputSchema: chainStatusOutputSchema, http: { method: "GET", path: "/v1/chain/status" }, mcp: { name: "get_robinhood_chain_status", readOnly: true }, provider: { method: "GET", path: () => "/chain/status" }, pricing: "cached_lookup", scope: "chain:read", ...GET_DEFAULTS }),
  service({ id: "chain.stock_tokens", title: "Robinhood Stock Tokens", description: "List canonical Robinhood Chain Stock Token contracts and capabilities.", inputSchema: emptyInputSchema, outputSchema: chainStockTokensOutputSchema, http: { method: "GET", path: "/v1/chain/stock-tokens" }, mcp: { name: "list_robinhood_stock_tokens", readOnly: true }, provider: { method: "GET", path: () => "/chain/stock-tokens" }, pricing: "cached_lookup", scope: "chain:read", ...GET_DEFAULTS }),
  service({ id: "chain.corporate_actions", title: "Stock Token Corporate Actions", description: "List normalized Stock Token corporate actions and multiplier changes.", inputSchema: corporateActionsInputSchema, outputSchema: corporateActionsOutputSchema, http: { method: "GET", path: "/v1/chain/corporate-actions" }, mcp: { name: "list_stock_token_corporate_actions", readOnly: true }, provider: { method: "GET", path: (i) => `/chain/corporate-actions${query(i)}` }, pricing: "research_basic", scope: "chain:read", ...GET_DEFAULTS }),
] as const;

export const servicesById = new Map(SERVICE_CATALOG.map((entry) => [entry.id, entry]));
export const servicesByTool = new Map(SERVICE_CATALOG.map((entry) => [entry.mcp.name, entry]));

export function assertValidCatalog(catalog: readonly ServiceDefinition[] = SERVICE_CATALOG): void {
  const ids = new Set<string>();
  const tools = new Set<string>();
  const routes = new Set<string>();
  for (const item of catalog) {
    if (ids.has(item.id)) throw new Error(`Duplicate service id: ${item.id}`);
    if (tools.has(item.mcp.name)) throw new Error(`Duplicate MCP tool: ${item.mcp.name}`);
    const routeKey = `${item.http.method} ${item.http.path}`;
    if (routes.has(routeKey)) throw new Error(`Duplicate HTTP operation: ${routeKey}`);
    const price = (PRICE_TIERS as Partial<Record<string, { atomic: string }>>)[item.pricing];
    if (!price || BigInt(price.atomic) <= 0n) throw new Error(`Paid service lacks a valid price: ${item.id}`);
    if (item.timeoutMs <= 0 || item.maxOutputBytes <= 0) throw new Error(`Service limits must be positive: ${item.id}`);
    ids.add(item.id);
    tools.add(item.mcp.name);
    routes.add(routeKey);
  }
}

assertValidCatalog();

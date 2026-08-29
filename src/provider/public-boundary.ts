import { GatewayError } from "../middleware/errors.js";

const FORBIDDEN_KEYS = new Set([
  "notes",
  "watchlist",
  "watchlists",
  "savedscreen",
  "savedscreens",
  "conversations",
  "automations",
  "mcpconnections",
  "oauthstate",
  "apicredentials",
  "credentials",
  "userid",
  "owneruserid",
  "accountid",
  "accountids",
  "brokerageaccount",
  "brokerageaccounts",
  "brokerageaccountid",
  "brokerageauthorization",
  "buyingpower",
  "positions",
  "orders",
  "taxlot",
  "taxlots",
  "privatepositions",
  "privateorders",
  "watchlistid",
  "usernotes",
  "savedscreenid",
  "savedscreens",
  "conversationid",
  "automationid",
  "privatemcpconnection",
  "mcpconnectionid",
  "oauthstate",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "mnemonic",
  "seedphrase",
  "walletcredential",
  "wallet",
  "wallets",
  "walletid",
  "walletaddress",
  "walletaddresses",
  "session",
  "sessionid",
  "sessiontoken",
  "cookie",
  "cookies",
  "password",
  "passwordhash",
  "clientsecret",
  "secret",
  "approvals",
  "transfers",
  "transactionsubmission",
  "tradeproposal",
  "tradeproposals",
  "userlinkedtradeproposal",
  "userlinkedtradeproposals",
  "signedtransaction",
  "transactionauthorization",
]);

export function assertPublicDataBoundary(value: unknown): void {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > 100_000) throw new GatewayError(502, "provider_contract_invalid", "Provider response exceeded structural safety limits");
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
      if (FORBIDDEN_KEYS.has(normalized)) {
        throw new GatewayError(502, "provider_contract_invalid", "Provider response crossed the public data boundary");
      }
      stack.push(child);
    }
  }
}

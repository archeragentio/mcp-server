# Archer Protocol Gateway

Archer Protocol Gateway is a standalone, read-only payment edge for Archer's Stock Token, equity-research, and Robinhood Chain data. It exposes 18 catalog-defined operations through REST and remote MCP, accepts MPP and x402 v2 payments, and supports trusted reseller upstreams without coupling the product to a marketplace.

The gateway never imports private application packages or reads application databases. Production calls cross a narrow, versioned Provider API protected by a short-lived Ed25519 service JWT.

## Quick start

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev:fixture
```

The fixture starts the gateway on `http://127.0.0.1:3100` and a deterministic synthetic Provider API on `127.0.0.1:3101`. No Archer database, Valkey instance, wallet, or private credential is needed.

In another shell:

```bash
curl -i http://127.0.0.1:3100/v1/stocks
curl -i -H 'Authorization: Payment fixture-mpp' http://127.0.0.1:3100/v1/stocks
pnpm conformance:smoke
```

Free discovery is available at `/openapi.json`, `/llms.txt`, `/service-catalog.json`, `/pricing.json`, and through the five `archer://` MCP resources. Paid responses always use `Cache-Control: private, no-store`.

## Payment rails

- Base USDC (`eip155:8453`) is offered through MPP and x402, using EIP-3009.
- Robinhood Chain USDG (`eip155:4663`) is offered through x402 only, using Permit2 exact settlement.
- A facilitator is configured by URL and must advertise x402 v2 `exact` support for every required network before readiness succeeds.

Prices, REST operations, MCP tools, provider routes, payment offers, OpenAPI extensions, and agent-readable discovery are generated from one Service Catalog. Launch defaults range from $0.001 to $0.010 and can be changed with the `PRICE_*_USD` environment variables.

## Development checks

```bash
pnpm catalog:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:conformance
pnpm build
```

Tests use the official MCP v2 client, the current `mppx` signed-payment clients, and the current x402 client. They verify the dual MCP challenge, modern and legacy MCP negotiation, HTTP/tool challenge scope binding, input-before-payment validation, both payment protocols, the official x402 verify → provider → settle → release lifecycle, cancellation, settlement withholding, pre-settlement payer limiting, idempotency, discovery, readiness, all 18 routes, and reseller isolation. The real-process conformance workflow also runs `mppx validate` against the synthetic gateway.

## Production setup

1. Copy `.env.example` to a root-owned environment file outside the checkout.
2. Generate the Provider API keypair with `pnpm keys:provider -- gateway-main`; install only the public key in private Archer.
3. Generate reseller secrets with a cryptographically secure source and hash them over stdin with `pnpm reseller:hash`.
4. Build with `pnpm install --frozen-lockfile && pnpm build`.
5. Install the systemd and Caddy templates under `deploy/`.
6. Complete every blocking item in [Launch gates](docs/launch-gates.md).

The code is production-capable, but no deployment should accept paid traffic until source redistribution rights, production payment credentials, required facilitator networks, low-value real settlements, and marketplace single-charge behavior have been verified by a human operator. Production startup rejects incomplete launch-attestation flags, and separately requires reseller approval whenever a reseller credential is configured.

## Documentation

- [Architecture](docs/architecture.md)
- [Payments](docs/payments.md)
- [MCP](docs/mcp.md)
- [Provider contract](docs/provider-contract.md)
- [Marketplace and reseller integration](docs/marketplace.md)
- [Operations](docs/operations.md)
- [Security boundary](docs/security.md)
- [Data licensing review](docs/data-licensing.md)
- [Launch gates](docs/launch-gates.md)

The public gateway is licensed under Apache-2.0. Upstream data remains subject to its own terms and is not relicensed by this repository.

# Archer Protocol Gateway

Archer Protocol Gateway is a standalone, read-only payment edge for Archer's Stock Token, equity-research, and Robinhood Chain data. It exposes 18 catalog-defined operations through REST and remote MCP, accepts MPP and x402 v2 payments, and supports trusted reseller upstreams without coupling the product to a marketplace.

## Payment rails

- Base USDC (`eip155:8453`) is offered through MPP and x402, using EIP-3009.
- Robinhood Chain USDG (`eip155:4663`) is offered through x402 only, using Permit2 exact settlement.
- A facilitator is configured by URL and must advertise x402 v2 `exact` support for every required network before readiness succeeds.

Prices, REST operations, MCP tools, provider routes, payment offers, OpenAPI extensions, and agent-readable discovery are generated from one Service Catalog.

The public gateway is licensed under Apache-2.0. Upstream data remains subject to its own terms and is not relicensed by this repository.

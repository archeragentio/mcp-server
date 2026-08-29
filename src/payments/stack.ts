import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { MiddlewareHandler } from "hono";
import { mpp } from "mppx/x402/hono";
import type { AppEnv } from "../app-env.js";
import type { GatewayConfig } from "../config.js";
import { buildX402Routes } from "./offers.js";
import { fixturePaymentMiddleware } from "./fixture.js";

export interface PaymentReadiness {
  ready: boolean;
  checkedAt?: string;
  error?: string;
  supportedNetworks: string[];
}

export interface PaymentStack {
  resourceServer: x402ResourceServer;
  routes: RoutesConfig;
  middleware: MiddlewareHandler<AppEnv>;
  readiness: PaymentReadiness;
  fixtureLifecycleEvents?: string[];
  initialize(): Promise<void>;
}

export function createPaymentStack(config: GatewayConfig, fixtureLifecycleEvents: string[] = [], facilitatorOverride?: FacilitatorClient): PaymentStack {
  const facilitator: FacilitatorClient = facilitatorOverride ?? (config.PAYMENT_MODE === "fixture"
    ? new FixtureFacilitator(fixtureLifecycleEvents)
    : new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL, timeoutMs: config.X402_FACILITATOR_TIMEOUT_MS }));
  const resourceServer = new x402ResourceServer(facilitator)
    .register("eip155:8453", new ExactEvmScheme())
    .register("eip155:4663", new ExactEvmScheme());
  const routes = buildX402Routes(config);
  const readiness: PaymentReadiness = { ready: false, supportedNetworks: [] };
  const middleware = config.PAYMENT_MODE === "fixture"
    ? fixturePaymentMiddleware(resourceServer, routes, config, fixtureLifecycleEvents)
    : mpp(routes, resourceServer, {
        secretKey: config.MPP_SECRET_KEY ?? "",
        realm: new URL(config.PUBLIC_ORIGIN).hostname,
      }) as MiddlewareHandler<AppEnv>;
  return {
    resourceServer,
    routes,
    middleware,
    readiness,
    ...(config.PAYMENT_MODE === "fixture" ? { fixtureLifecycleEvents } : {}),
    async initialize() {
      try {
        await resourceServer.initialize();
        const supportedNetworks = config.X402_REQUIRED_NETWORKS.filter((network) => resourceServer.getSupportedKind(2, network as `${string}:${string}`, "exact") !== undefined);
        readiness.supportedNetworks = supportedNetworks;
        readiness.checkedAt = new Date().toISOString();
        const missing = config.X402_REQUIRED_NETWORKS.filter((network) => !supportedNetworks.includes(network));
        if (missing.length > 0) {
          readiness.ready = false;
          readiness.error = `Facilitator lacks x402 v2 exact support for: ${missing.join(", ")}`;
          return;
        }
        readiness.ready = true;
        delete readiness.error;
      } catch {
        readiness.ready = false;
        readiness.checkedAt = new Date().toISOString();
        readiness.error = "Payment facilitator readiness check failed";
      }
    },
  };
}

class FixtureFacilitator implements FacilitatorClient {
  constructor(readonly events: string[]) {}
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.events.push("verify");
    const matches = payload.x402Version === 2
      && payload.accepted.network === requirements.network
      && payload.accepted.asset.toLowerCase() === requirements.asset.toLowerCase()
      && payload.accepted.amount === requirements.amount
      && payload.accepted.payTo.toLowerCase() === requirements.payTo.toLowerCase()
      && payload.payload.fixture === true;
    return Promise.resolve(matches ? { isValid: true, payer: "0x2222222222222222222222222222222222222222" } : { isValid: false, invalidReason: "fixture_payment_invalid" });
  }
  settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.events.push("settle");
    return Promise.resolve({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: requirements.network,
      amount: requirements.amount,
      payer: "0x2222222222222222222222222222222222222222",
    });
  }
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        { x402Version: 2, scheme: "exact", network: "eip155:4663" },
      ],
      extensions: [],
      signers: {},
    });
  }
}

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402HTTPResourceServer, type RoutesConfig, type x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import { Challenge, Receipt } from "mppx";
import type { AppEnv } from "../app-env.js";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceDefinition } from "../catalog/types.js";
import type { GatewayConfig } from "../config.js";
import { hashCanonical } from "../executor/fingerprint.js";
import {
  extractMppCredentialHeader,
  isMppChallengeForService,
  MPP_SCOPE_META_KEY,
  mppChallengeExpiry,
  mppHttpScope,
  parseMppCredential,
} from "./mpp-wire.js";

export function fixturePaymentMiddleware(
  resourceServer: x402ResourceServer,
  routes: RoutesConfig,
  config: GatewayConfig,
  lifecycleEvents: string[] = [],
): MiddlewareHandler<AppEnv> {
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  const x402 = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false) as MiddlewareHandler<AppEnv>;
  return async (context, next) => {
    const x402Credential = context.req.header("payment-signature") ?? context.req.header("x-payment");
    const mppCredential = context.req.header("authorization");
    if (x402Credential !== undefined && extractMppCredentialHeader(mppCredential) !== undefined) {
      return context.json({ error: { code: "bad_request", message: "Supply exactly one payment credential" } }, 400);
    }
    const service = context.get("service");
    const mppAuthorization = service ? fixtureMppAuthorization(mppCredential, service, config) : undefined;
    if (mppAuthorization && service) {
      const reference = `fixture-mpp-${context.get("requestId")}`;
      lifecycleEvents.push("verify");
      context.set("paymentProtocol", "mpp");
      context.set("paymentPayer", mppAuthorization.payer);
      if (mppAuthorization.challengeId) context.set("challengeId", mppAuthorization.challengeId);
      context.set("paymentNetwork", "eip155:8453");
      context.set("paymentStatus", "verified");
      const price = configuredPrice(config, service.pricing);
      const selectedOffer = `eip155:8453:${config.BASE_USDC_ADDRESS.toLowerCase()}:${price.atomic}:${config.PAYMENT_RECIPIENT?.toLowerCase() ?? "fixture-recipient"}`;
      context.set("priceOffer", selectedOffer);
      const fingerprint = context.get("requestFingerprint");
      if (fingerprint) context.set("requestFingerprint", hashCanonical({ requestFingerprint: fingerprint, selectedPriceOffer: selectedOffer }));
      await next();
      if (context.res.status >= 400) {
        context.set("paymentStatus", "canceled");
        lifecycleEvents.push("cancel");
        return;
      }
      context.set("paymentStatus", "settled");
      context.set("paymentReference", reference);
      lifecycleEvents.push("settle");
      context.header("cache-control", "private, no-store");
      context.header("payment-receipt", Receipt.serialize(Receipt.from({
        method: "evm",
        status: "success",
        timestamp: new Date().toISOString(),
        reference,
      })));
      lifecycleEvents.push("release");
      return;
    }

    const result = await x402(context, next);
    if (result instanceof Response) context.res = result;
    if (context.res.status === 402 && service) appendMppChallenge(context.res, config, service);
    else if (x402Credential !== undefined && context.res.status < 400) lifecycleEvents.push("release");
    return result;
  };
}

function appendMppChallenge(response: Response, config: GatewayConfig, service: ServiceDefinition): void {
  const encoded = response.headers.get("payment-required");
  if (!encoded) return;
  const paymentRequired = decodePaymentRequiredHeader(encoded);
  const base = paymentRequired.accepts.find((item) => item.network === "eip155:8453");
  if (!base) return;
  const challenge = Challenge.from({
    secretKey: config.MPP_SECRET_KEY ?? "fixture-mpp-secret-key-at-least-32-bytes-long",
    realm: new URL(config.PUBLIC_ORIGIN).hostname,
    method: "evm",
    intent: "charge",
    expires: mppChallengeExpiry(),
    request: {
      amount: base.amount,
      currency: base.asset,
      methodDetails: {
        chainId: 8453,
        credentialTypes: ["authorization"],
        decimals: 6,
      },
      recipient: base.payTo,
    },
    meta: { service: service.id, [MPP_SCOPE_META_KEY]: paymentRequired.resource.url },
  });
  response.headers.append("www-authenticate", Challenge.serialize(challenge));
  response.headers.set("cache-control", "no-store");
}

function fixtureMppAuthorization(
  header: string | undefined,
  service: ServiceDefinition,
  config: GatewayConfig,
): { payer: string; challengeId?: string } | undefined {
  if (header === "Payment fixture-mpp") return { payer: "0x2222222222222222222222222222222222222222" };
  const payment = extractMppCredentialHeader(header);
  if (!payment) return undefined;
  const credential = parseMppCredential(payment);
  if (!credential || !isMppChallengeForService(credential.challenge, service, config, mppHttpScope(service, config))) return undefined;
  return { payer: credential.source ?? "fixture-mpp-payer", challengeId: credential.challenge.id };
}

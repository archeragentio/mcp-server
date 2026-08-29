import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { GatewayConfig } from "../config.js";
import { hashCanonical } from "../executor/fingerprint.js";
import type { Metrics } from "../observability/metrics.js";
import type { StateStore } from "../state/index.js";
import { incrementRateBucket } from "../middleware/rate-limit.js";
import type { PaymentStack } from "./stack.js";
import { extractMppCredentialHeader, parseMppCredential } from "./mpp-wire.js";

const installed = new WeakSet<object>();

export function installPaymentLifecycleHooks(
  payment: PaymentStack,
  metrics: Metrics,
  state: StateStore,
  config: GatewayConfig,
): void {
  if (installed.has(payment.resourceServer)) return;
  installed.add(payment.resourceServer);

  payment.resourceServer.onAfterVerify((event) => {
    const context = honoContext(event.transportContext);
    const authorization = context?.req.header("authorization");
    const protocol: string = context
      ? extractMppCredentialHeader(authorization) ? "mpp" : "x402"
      : transportProtocol(event.transportContext);
    if (!event.result.isValid) return Promise.resolve();
    if (context) {
      const submittedMpp = protocol === "mpp" ? parseMppCredential(extractMppCredentialHeader(authorization)) : undefined;
      if (submittedMpp) context.set("challengeId", submittedMpp.challenge.id);
      context.set("paymentProtocol", protocol === "mpp" ? "mpp" : "x402");
      context.set("paymentPayer", event.result.payer ?? "unknown");
      context.set("paymentNetwork", event.requirements.network);
      context.set("paymentStatus", "verified");
      const selectedOffer = priceOffer(event.requirements);
      context.set("priceOffer", selectedOffer);
      const fingerprint = context.get("requestFingerprint");
      if (fingerprint) context.set("requestFingerprint", hashCanonical({ requestFingerprint: fingerprint, selectedPriceOffer: selectedOffer }));
    }
    metrics.increment("archer_payment_verified_total", {
      network: event.requirements.network,
      protocol,
    });
    const payer = event.result.payer;
    if (!payer) {
      context?.set("paymentStatus", "failed");
      return Promise.resolve({ abort: true as const, reason: "payer_missing", message: "Payment verification did not identify a payer" });
    }
    const minute = Math.floor(Date.now() / 60_000);
    return incrementRateBucket(state, `rate:paid:${hashCanonical(payer.toLowerCase())}:${String(minute)}`)
      .then((count) => {
        if (count <= config.PAID_RATE_LIMIT_PER_MINUTE) {
          context?.set("paidRateLimitDecision", "allowed");
          return undefined;
        }
        context?.set("paidRateLimitDecision", "limited");
        context?.set("paymentStatus", "canceled");
        metrics.increment("archer_payment_failures_total", { network: event.requirements.network, protocol, phase: "rate_limit" });
        return { abort: true as const, reason: "rate_limited", message: "Paid caller rate limit exceeded" };
      })
      .catch(() => {
        context?.set("paidRateLimitDecision", "unavailable");
        context?.set("paymentStatus", "canceled");
        metrics.increment("archer_payment_failures_total", { network: event.requirements.network, protocol, phase: "rate_limit_state" });
        return { abort: true as const, reason: "rate_limit_unavailable", message: "Paid caller rate limit is unavailable" };
      });
  });

  payment.resourceServer.onAfterSettle((event) => {
    const context = honoContext(event.transportContext);
    if (context) {
      context.set("paymentStatus", "settled");
      context.set("paymentReference", event.result.transaction);
      context.set("paymentPayer", event.result.payer ?? context.get("paymentPayer"));
    }
    metrics.increment("archer_payment_settled_total", {
      network: event.requirements.network,
      protocol: context?.get("paymentProtocol") ?? transportProtocol(event.transportContext),
    });
    return Promise.resolve();
  });

  payment.resourceServer.onVerifyFailure((event) => {
    const context = honoContext(event.transportContext);
    context?.set("paymentStatus", "failed");
    metrics.increment("archer_payment_failures_total", {
      network: event.requirements.network,
      protocol: context?.get("paymentProtocol") ?? transportProtocol(event.transportContext),
      phase: "verify",
    });
    return Promise.resolve();
  });

  payment.resourceServer.onSettleFailure((event) => {
    const context = honoContext(event.transportContext);
    context?.set("paymentStatus", "failed");
    metrics.increment("archer_payment_failures_total", {
      network: event.requirements.network,
      protocol: context?.get("paymentProtocol") ?? transportProtocol(event.transportContext),
      phase: "settle",
    });
    return Promise.resolve();
  });

  payment.resourceServer.onVerifiedPaymentCanceled((event) => {
    const context = honoContext(event.transportContext);
    context?.set("paymentStatus", "canceled");
    payment.fixtureLifecycleEvents?.push("cancel");
    return Promise.resolve();
  });
}

function honoContext(transportContext: unknown): Context<AppEnv> | undefined {
  const adapter = (transportContext as { request?: { adapter?: unknown } } | undefined)?.request?.adapter;
  return (adapter as { c?: Context<AppEnv> } | undefined)?.c;
}

function transportProtocol(transportContext: unknown): string {
  const context = transportContext as { paymentProtocol?: unknown; transport?: unknown } | undefined;
  if (context?.transport !== "mcp") return "unknown";
  return context.paymentProtocol === "mpp" ? "mpp" : "x402";
}

function priceOffer(requirements: { network: string; asset: string; amount: string; payTo: string }): string {
  return `${requirements.network}:${requirements.asset.toLowerCase()}:${requirements.amount}:${requirements.payTo.toLowerCase()}`;
}

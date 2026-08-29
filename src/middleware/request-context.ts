import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Challenge } from "mppx";
import type { Logger } from "pino";
import type { AppEnv } from "../app-env.js";
import type { Metrics } from "../observability/metrics.js";
import type { PaymentAudit } from "../observability/payment-audit.js";
import { extractMppCredentialHeader, parseMppCredential } from "../payments/mpp-wire.js";

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestContext(logger: Logger, metrics: Metrics, audit: PaymentAudit): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    context.set("requestId", requestId);
    context.set("service", undefined);
    context.set("paymentProtocol", undefined);
    context.set("resellerId", undefined);
    context.set("challengeId", undefined);
    context.set("requestFingerprint", undefined);
    context.set("paymentPayer", undefined);
    context.set("paymentNetwork", undefined);
    context.set("paymentReference", undefined);
    context.set("paymentStatus", undefined);
    context.set("paidRateLimitDecision", undefined);
    context.set("priceOffer", undefined);
    context.set("providerStatus", "not_called");
    context.set("responseBytes", undefined);
    context.header("x-request-id", requestId);
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    const started = performance.now();
    await next();
    const latencyMs = performance.now() - started;
    const service = context.get("service");
    const serviceId = service?.id ?? "unmatched";
    if (context.res.status === 402 && service) {
      const authorization = context.req.header("authorization");
      const serializedMppCredential = extractMppCredentialHeader(authorization);
      const submittedMppCredential = parseMppCredential(serializedMppCredential);
      if (submittedMppCredential) context.set("challengeId", submittedMppCredential.challenge.id);
      else {
        try {
          context.set("challengeId", Challenge.fromResponse(context.res).id);
        } catch {
          // An x402-only challenge retains the request correlation ID.
        }
      }
      const hasMppCredential = serializedMppCredential !== undefined;
      const hasX402Credential = context.req.header("payment-signature") !== undefined || context.req.header("x-payment") !== undefined;
      context.set("paymentProtocol", context.get("paymentProtocol") ?? (hasMppCredential ? "mpp" : hasX402Credential ? "x402" : undefined));
      context.set("paymentStatus", context.get("paymentStatus") ?? (hasMppCredential || hasX402Credential ? "failed" : "challenged"));
      metrics.increment("archer_payment_challenges_total", { service: service.id });
    }
    metrics.increment("archer_gateway_requests_total", { method: context.req.method, service: serviceId, status: String(context.res.status) });
    metrics.observe("archer_gateway_request_duration_ms", latencyMs, { service: serviceId });
    logger.info({
      requestId,
      transport: context.req.path === "/mcp" ? "mcp" : "http",
      serviceId,
      paymentProtocol: context.get("paymentProtocol"),
      paymentNetwork: context.get("paymentNetwork"),
      paymentStatus: context.get("paymentStatus"),
      providerStatus: context.get("providerStatus"),
      status: context.res.status,
      latencyMs: Math.round(latencyMs),
      responseBytes: context.get("responseBytes"),
    }, "gateway request");
    const challengeId = context.get("challengeId");
    const fingerprint = context.get("requestFingerprint");
    if (service && challengeId && fingerprint) {
      const paymentStatus = context.get("paymentStatus");
      const paymentProtocol = context.get("paymentProtocol");
      const payer = context.get("paymentPayer");
      const network = context.get("paymentNetwork");
      const priceOffer = context.get("priceOffer");
      const paymentReference = context.get("paymentReference");
      const resellerId = context.get("resellerId");
      const responseBytes = context.get("responseBytes");
      const providerStatus = context.get("providerStatus");
      const fulfillmentResult = providerStatus === "success" && (paymentStatus === "settled" || paymentStatus === "reseller_authorized")
        ? "fulfilled"
        : providerStatus === "success"
          ? "withheld"
          : paymentStatus === "challenged"
            ? "challenged"
            : paymentStatus === "failed"
              ? "failed"
              : "not_fulfilled";
      await audit.record({
        requestId,
        challengeId,
        requestFingerprint: fingerprint,
        serviceId: service.id,
        transport: "http",
        fulfillmentResult,
        ...(paymentStatus === undefined ? {} : { paymentStatus }),
        ...(paymentProtocol === undefined ? {} : { paymentProtocol }),
        ...(payer === undefined ? {} : { payer }),
        ...(network === undefined ? {} : { network }),
        ...(priceOffer === undefined ? {} : { priceOffer }),
        ...(paymentReference === undefined ? {} : { paymentReference }),
        ...(resellerId === undefined ? {} : { resellerId }),
        providerStatus,
        latencyMs: Math.round(latencyMs),
        ...(responseBytes === undefined ? {} : { responseBytes }),
      });
    }
  };
}

import type { Handler, Hono, MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { AppEnv } from "../app-env.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import type { GatewayConfig, TrustedResellerConfig } from "../config.js";
import { hashCanonical } from "../executor/fingerprint.js";
import type { ServiceExecutor } from "../executor/service-executor.js";
import { errorResponse, GatewayError } from "../middleware/errors.js";
import { challengeRateLimit, incrementRateBucket } from "../middleware/rate-limit.js";
import { authorizeReseller } from "../middleware/reseller.js";
import { honoPath, validateServiceRequest } from "../middleware/validation.js";
import type { Metrics } from "../observability/metrics.js";
import type { PaymentStack } from "../payments/stack.js";
import { extractMppCredentialHeader } from "../payments/mpp-wire.js";
import type { StateStore } from "../state/index.js";

export function registerRestRoutes(
  app: Hono<AppEnv>,
  dependencies: {
    config: GatewayConfig;
    executor: ServiceExecutor;
    payment: PaymentStack;
    resellers: readonly TrustedResellerConfig[];
    state: StateStore;
    metrics: Metrics;
    logger: Logger;
  },
): void {
  for (const service of SERVICE_CATALOG) {
    const handler: Handler<AppEnv> = async (context) => {
      const idempotencyKey = context.req.header("idempotency-key");
      try {
        const result = await dependencies.executor.execute(service, context.get("input"), {
          requestId: context.get("requestId"),
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        const body = JSON.stringify(result);
        context.set("providerStatus", "success");
        context.set("responseBytes", Buffer.byteLength(body));
        context.header("cache-control", "private, no-store");
        context.header("content-type", "application/json; charset=utf-8");
        return context.body(body);
      } catch (error) {
        context.set("providerStatus", "failed");
        return errorResponse(error, context.get("requestId"));
      }
    };
    const preflight: Handler<AppEnv> = async (context, next) => {
      await dependencies.executor.preflightIdempotency(service, context.get("input"), context.req.header("idempotency-key"));
      await next();
    };
    const credentialPreflight: Handler<AppEnv> = async (context, next) => {
      const credentials = [
        context.req.header("payment-signature"),
        context.req.header("x-payment"),
        extractMppCredentialHeader(context.req.header("authorization")),
      ].filter((value) => value !== undefined);
      if (credentials.length > 1) throw new GatewayError(400, "bad_request", "Supply exactly one payment credential");
      await next();
    };
    const paidLimit: Handler<AppEnv> = async (context, next) => {
      if (context.get("paidRateLimitDecision") === "allowed") {
        await next();
        return;
      }
      const payer = context.get("paymentPayer");
      if (!payer) throw new GatewayError(402, "payment_invalid", "Payment verification did not identify a payer");
      const minute = Math.floor(Date.now() / 60_000);
      const count = await incrementRateBucket(dependencies.state, `rate:paid:${hashCanonical(payer.toLowerCase())}:${String(minute)}`);
      if (count > dependencies.config.PAID_RATE_LIMIT_PER_MINUTE) {
        context.header("retry-after", String(60 - (Math.floor(Date.now() / 1_000) % 60)));
        throw new GatewayError(429, "rate_limited", "Paid caller rate limit exceeded");
      }
      await next();
    };
    const guardedPayment: MiddlewareHandler<AppEnv> = async (context, next) => {
      const result = await dependencies.payment.middleware(context, next);
      const decision = context.get("paidRateLimitDecision");
      if (decision === "limited") {
        const response = errorResponse(new GatewayError(429, "rate_limited", "Paid caller rate limit exceeded"), context.get("requestId"));
        response.headers.set("retry-after", String(60 - (Math.floor(Date.now() / 1_000) % 60)));
        context.res = response;
        return response;
      }
      if (decision === "unavailable") {
        const response = errorResponse(new GatewayError(503, "dependency_unavailable", "Paid caller rate limit is unavailable"), context.get("requestId"));
        context.res = response;
        return response;
      }
      const response = result instanceof Response ? result : context.res;
      if (response.status === 502 && context.get("providerStatus") !== "failed") {
        const unavailable = errorResponse(
          new GatewayError(503, "dependency_unavailable", "Payment facilitator is unavailable"),
          context.get("requestId"),
        );
        context.res = unavailable;
        return unavailable;
      }
      return result;
    };
    const path = honoPath(service.http.path);
    app.on(
      service.http.method,
      path,
      validateServiceRequest(service, dependencies.config),
      preflight,
      credentialPreflight,
      challengeRateLimit(dependencies.state, dependencies.config.CHALLENGE_RATE_LIMIT_PER_MINUTE),
      guardedPayment,
      paidLimit,
      handler,
    );

    const upstream = `/upstream${path}`;
    app.on(
      service.http.method,
      upstream,
      validateServiceRequest(service, dependencies.config),
      authorizeReseller(service, dependencies.resellers, dependencies.state, dependencies.metrics, dependencies.logger),
      handler,
    );
  }
}

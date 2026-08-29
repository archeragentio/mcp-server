import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { AppEnv } from "../app-env.js";
import type { ServiceDefinition } from "../catalog/types.js";
import type { TrustedResellerConfig } from "../config.js";
import { hashCanonical } from "../executor/fingerprint.js";
import type { Metrics } from "../observability/metrics.js";
import type { StateStore } from "../state/index.js";
import { GatewayError } from "./errors.js";
import { incrementRateBucket } from "./rate-limit.js";

export function authorizeReseller(
  service: ServiceDefinition,
  resellers: readonly TrustedResellerConfig[],
  state: StateStore,
  metrics: Metrics,
  logger: Logger,
): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new GatewayError(401, "unauthorized", "A reseller bearer credential is required");
    const digest = createHash("sha256").update(authorization.slice(7)).digest();
    const reseller = resellers.find((candidate) => {
      const expected = Buffer.from(candidate.tokenHash, "hex");
      return expected.length === digest.length && timingSafeEqual(expected, digest);
    });
    const disabled = reseller !== undefined && (!reseller.enabled || (reseller.disabledAt !== undefined && Date.parse(reseller.disabledAt) <= Date.now()));
    if (!reseller || disabled) throw new GatewayError(401, "unauthorized", "Reseller credential is invalid or disabled");
    if (!matchesAny(service, reseller.scopes) || !routeAllowed(service, reseller.routes)) {
      throw new GatewayError(403, "forbidden", "Reseller credential does not authorize this service");
    }
    const minute = Math.floor(Date.now() / 60_000);
    const count = await incrementRateBucket(state, `rate:reseller:${reseller.id}:${String(minute)}`);
    if (count > reseller.rateLimitPerMinute) throw new GatewayError(429, "rate_limited", "Reseller rate limit exceeded");
    context.set("resellerId", reseller.id);
    context.set("paymentProtocol", "reseller");
    context.set("paymentPayer", `reseller:${reseller.id}`);
    context.set("paymentNetwork", "reseller");
    context.set("paymentStatus", "reseller_authorized");
    const selectedOffer = `reseller:${reseller.id}`;
    context.set("priceOffer", selectedOffer);
    const fingerprint = context.get("requestFingerprint");
    if (fingerprint) context.set("requestFingerprint", hashCanonical({ requestFingerprint: fingerprint, selectedPriceOffer: selectedOffer }));
    metrics.increment("archer_reseller_requests_total", { reseller: reseller.id, service: service.id });
    logger.info({ requestId: context.get("requestId"), resellerId: reseller.id, serviceId: service.id }, "reseller authorization accepted");
    await next();
  };
}

function matchesAny(service: ServiceDefinition, scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === "*" || scope === service.id || scope === service.scope || scope.replace(".", ":") === service.scope || (scope.endsWith(".*") && service.id.startsWith(scope.slice(0, -1))));
}

function routeAllowed(service: ServiceDefinition, routes: readonly string[]): boolean {
  const upstream = `/upstream${service.http.path}`;
  return routes.some((route) => route === "*" || route === service.id || route === service.http.path || route === upstream || (route.endsWith("*") && upstream.startsWith(route.slice(0, -1))));
}

import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import { hashCanonical } from "../executor/fingerprint.js";
import type { StateStore } from "../state/index.js";
import { GatewayError } from "./errors.js";
import { extractMppCredentialHeader } from "../payments/mpp-wire.js";

export function rateLimit(
  state: StateStore,
  limit: number,
  bucket: string,
  when: (context: Context<AppEnv>) => boolean = () => true,
): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (!when(context)) {
      await next();
      return;
    }
    const identity = context.req.header("x-real-ip") ?? context.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim() ?? "unknown";
    const minute = Math.floor(Date.now() / 60_000);
    const count = await incrementRateBucket(state, `rate:${bucket}:${hashCanonical(identity)}:${String(minute)}`);
    if (count > limit) {
      context.header("retry-after", String(60 - (Math.floor(Date.now() / 1_000) % 60)));
      throw new GatewayError(429, "rate_limited", "Rate limit exceeded");
    }
    await next();
  };
}

export async function incrementRateBucket(state: StateStore, key: string): Promise<number> {
  try {
    const count = await state.increment(key, 120);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid rate-limit count");
    return count;
  } catch {
    throw new GatewayError(503, "dependency_unavailable", "Rate-limit state is unavailable");
  }
}

export function challengeRateLimit(state: StateStore, limit: number): MiddlewareHandler<AppEnv> {
  return rateLimit(state, limit, "challenge", (context) => {
    const authorization = context.req.header("authorization");
    return context.req.header("payment-signature") === undefined
      && context.req.header("x-payment") === undefined
      && extractMppCredentialHeader(authorization) === undefined;
  });
}

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import type { ServiceDefinition, ServiceInput } from "../catalog/types.js";
import type { GatewayConfig } from "../config.js";
import { requestFingerprint } from "../executor/fingerprint.js";
import { GatewayError } from "./errors.js";

const ARRAY_QUERY_FIELDS = new Set(["coverage", "securityTypes", "sectors", "forms"]);

export function validateServiceRequest(service: ServiceDefinition, config: GatewayConfig): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    context.set("service", service);
    let candidate: ServiceInput;
    if (service.http.method === "POST") {
      const declared = Number(context.req.header("content-length") ?? 0);
      if (declared > config.MAX_REQUEST_BODY_BYTES) throw new GatewayError(413, "request_too_large", "Request body is too large");
      const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new GatewayError(400, "bad_request", "Content-Type must be application/json");
      const text = await context.req.raw.clone().text();
      if (Buffer.byteLength(text) > config.MAX_REQUEST_BODY_BYTES) throw new GatewayError(413, "request_too_large", "Request body is too large");
      candidate = JSON.parse(text) as ServiceInput;
    } else {
      candidate = {};
      const url = new URL(context.req.url);
      for (const [key, value] of url.searchParams) {
        candidate[key] = ARRAY_QUERY_FIELDS.has(key)
          ? value.split(",").filter(Boolean)
          : key === "pendingOnly" ? parseBooleanQuery(value) : value;
      }
    }
    for (const key of pathParameters(service.http.path)) candidate[key] = context.req.param(key);
    const parsed = service.inputSchema.parse(candidate);
    const idempotencyKey = context.req.header("idempotency-key");
    if (idempotencyKey !== undefined && (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey) || idempotencyKey.includes(" "))) {
      throw new GatewayError(400, "bad_request", "Idempotency-Key must contain 1-200 visible non-space ASCII characters");
    }
    context.set("input", parsed);
    context.set("challengeId", randomUUID());
    context.set("requestFingerprint", requestFingerprint(service, parsed, config));
    await next();
  };
}

export function honoPath(path: string): string {
  return path.replaceAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).filter((value): value is string => value !== undefined);
}

function parseBooleanQuery(value: string): boolean | string {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}

import { FacilitatorResponseError } from "@x402/core/server";
import { ZodError } from "zod";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "payment_required"
  | "payment_invalid"
  | "conflict"
  | "request_too_large"
  | "rate_limited"
  | "dependency_unavailable"
  | "provider_unavailable"
  | "provider_contract_invalid"
  | "response_too_large"
  | "internal_error";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const normalized = normalizeError(error);
  return Response.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    },
    {
      status: normalized.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
      },
    },
  );
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof FacilitatorResponseError) {
    return new GatewayError(503, "dependency_unavailable", "Payment facilitator is unavailable");
  }
  if (error instanceof ZodError) {
    return new GatewayError(400, "bad_request", "Request validation failed", error.issues);
  }
  if (error instanceof SyntaxError) return new GatewayError(400, "bad_request", "Malformed JSON body");
  return new GatewayError(500, "internal_error", "Internal server error");
}

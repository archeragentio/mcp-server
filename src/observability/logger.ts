import pino, { type Logger } from "pino";
import type { GatewayConfig } from "../config.js";

export function createLogger(config: GatewayConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: "archer-protocol-gateway" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['payment-signature']",
        "req.headers['payment-authorization']",
        "req.headers['x-payment']",
        "req.headers.payment-signature",
        "req.headers.payment-authorization",
        "req.headers.x-payment",
        "*.headers.authorization",
        "*.headers['payment-signature']",
        "*.headers['payment-authorization']",
        "*.headers['x-payment']",
        "authorization",
        "paymentSignature",
        "xPayment",
        "credential",
        "*.credential",
        "token",
        "*.token",
        "privateKey",
        "*.privateKey",
        "serviceJwt",
        "resellerToken",
        "paymentPayload.payload.signature",
        "ARCHER_PROVIDER_PRIVATE_KEY",
        "MPP_SECRET_KEY",
      ],
      censor: "[REDACTED]",
    },
  });
}

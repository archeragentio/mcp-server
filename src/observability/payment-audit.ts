import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { StateStore } from "../state/index.js";

export interface PaymentAuditRecord {
  requestId: string;
  challengeId: string;
  requestFingerprint: string;
  serviceId: string;
  transport: "http" | "mcp";
  fulfillmentResult: string;
  paymentStatus?: string;
  paymentProtocol?: string;
  payer?: string;
  network?: string;
  priceOffer?: string;
  paymentReference?: string;
  resellerId?: string;
  providerStatus?: string;
  latencyMs?: number;
  responseBytes?: number;
}

export class PaymentAudit {
  constructor(
    readonly state: StateStore,
    readonly logger: Logger,
    readonly config: GatewayConfig,
  ) {}

  async record(record: PaymentAuditRecord): Promise<void> {
    const stored = { ...record, recordedAt: new Date().toISOString() };
    const key = `audit:${record.requestId}:${randomUUID()}`;
    try {
      await this.state.set(key, JSON.stringify(stored), this.config.PAYMENT_AUDIT_TTL_SECONDS);
    } catch (error) {
      this.logger.error({
        requestId: record.requestId,
        errorType: error instanceof Error ? error.name : typeof error,
      }, "payment audit persistence failed");
    }
    this.logger.info(stored, "payment audit");
  }
}

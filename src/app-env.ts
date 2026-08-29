import type { ServiceDefinition, ServiceInput } from "./catalog/types.js";

export interface AppEnv {
  Variables: {
    requestId: string;
    input: ServiceInput;
    service: ServiceDefinition | undefined;
    paymentProtocol: "mpp" | "x402" | "reseller" | undefined;
    resellerId: string | undefined;
    challengeId: string | undefined;
    requestFingerprint: string | undefined;
    paymentPayer: string | undefined;
    paymentNetwork: string | undefined;
    paymentReference: string | undefined;
    paymentStatus: "challenged" | "verified" | "settled" | "failed" | "canceled" | "reseller_authorized" | undefined;
    paidRateLimitDecision: "allowed" | "limited" | "unavailable" | undefined;
    priceOffer: string | undefined;
    providerStatus: "success" | "failed" | "not_called";
    responseBytes: number | undefined;
  };
}

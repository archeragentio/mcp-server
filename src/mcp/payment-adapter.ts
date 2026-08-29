import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { PaymentPayloadV2Schema } from "@x402/core/schemas";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { Receipt, type Credential } from "mppx";
import { AuthorizationPayloadSchema, challengeHash, type AuthorizationPayload } from "mppx/evm";
import { configuredPrice } from "../catalog/pricing.js";
import type { ProviderEnvelope, ServiceDefinition, ServiceInput } from "../catalog/types.js";
import type { GatewayConfig } from "../config.js";
import { hashCanonical, requestFingerprint } from "../executor/fingerprint.js";
import { GatewayError } from "../middleware/errors.js";
import { incrementRateBucket } from "../middleware/rate-limit.js";
import type { Metrics } from "../observability/metrics.js";
import type { PaymentAudit, PaymentAuditRecord } from "../observability/payment-audit.js";
import { createMppMcpAdapter, type MppPaymentRequired } from "../payments/mpp-mcp.js";
import { isMppChallengeForService, mppMcpScope, parseMppCredential } from "../payments/mpp-wire.js";
import { paymentOptions } from "../payments/offers.js";
import type { StateStore } from "../state/index.js";

const X402_PAYMENT_KEY = "x402/payment";
const X402_RECEIPT_KEY = "x402/payment-response";
const MPP_CREDENTIAL_KEY = "org.paymentauth/credential";
const MPP_CHALLENGE_KEY = "org.paymentauth/payment-required";
const MPP_RECEIPT_KEY = "org.paymentauth/receipt";

interface InvocationAudit {
  requestId: string;
  challengeId: string;
  challengeIdentity: string;
  fingerprint: string;
  startedAt: number;
}

export class McpPaymentAdapter {
  readonly #mpp;
  constructor(
    readonly config: GatewayConfig,
    readonly resourceServer: x402ResourceServer,
    readonly metrics: Metrics,
    readonly state: StateStore,
    readonly audit: PaymentAudit,
    readonly lifecycleEvents: string[] | undefined,
  ) {
    this.#mpp = createMppMcpAdapter(config);
  }

  async invoke(
    service: ServiceDefinition,
    input: ServiceInput,
    meta: Record<string, unknown> | undefined,
    requestId: string,
    challengeIdentity: string,
    execute: () => Promise<ProviderEnvelope>,
  ): Promise<CallToolResult> {
    const invocation = {
      requestId,
      challengeId: randomUUID(),
      challengeIdentity,
      fingerprint: requestFingerprint(service, input, this.config),
      startedAt: performance.now(),
    };
    const x402Credential = meta?.[X402_PAYMENT_KEY];
    const mppCredential = meta?.[MPP_CREDENTIAL_KEY];
    if (x402Credential !== undefined && mppCredential !== undefined) {
      await this.#record(service, invocation, "failed", { paymentStatus: "failed" });
      return this.#error("Supply exactly one payment credential", "payment_invalid", requestId);
    }
    if (mppCredential !== undefined) return this.#invokeMpp(service, input, mppCredential, invocation, execute);
    if (x402Credential !== undefined) return this.#invokeX402(service, input, x402Credential, invocation, execute);
    return this.#challenge(service, input, invocation);
  }

  async #challenge(
    service: ServiceDefinition,
    input: ServiceInput,
    audit: InvocationAudit,
    error?: string,
    submittedChallengeId?: string,
  ): Promise<CallToolResult> {
    await this.#enforceChallengeRate(audit.challengeIdentity);
    const paymentRequired = await this.#paymentRequired(service, input, error);
    const mppChallenge = await this.#mppChallenge(service);
    const issuedChallenge = mppChallenge.challenges[0];
    if (submittedChallengeId !== undefined) audit.challengeId = submittedChallengeId;
    else if (issuedChallenge) audit.challengeId = issuedChallenge.id;
    const text = JSON.stringify(paymentRequired);
    this.metrics.increment("archer_payment_challenges_total", { service: service.id, transport: "mcp" });
    await this.#record(service, audit, error === undefined ? "challenged" : "failed", {
      paymentStatus: error === undefined ? "challenged" : "failed",
    });
    return {
      isError: true,
      structuredContent: paymentRequired as unknown as Record<string, unknown>,
      content: [{ type: "text", text }],
      _meta: { [MPP_CHALLENGE_KEY]: mppChallenge },
    };
  }

  async #invokeMpp(
    service: ServiceDefinition,
    input: ServiceInput,
    credential: unknown,
    audit: InvocationAudit,
    execute: () => Promise<ProviderEnvelope>,
  ): Promise<CallToolResult> {
    const selectedOffer = `eip155:8453:${this.config.BASE_USDC_ADDRESS.toLowerCase()}:${configuredPrice(this.config, service.pricing).atomic}:${this.config.PAYMENT_RECIPIENT?.toLowerCase() ?? "missing-recipient"}`;
    audit.fingerprint = hashCanonical({ requestFingerprint: audit.fingerprint, selectedPriceOffer: selectedOffer });
    const parsedCredential = parseMppCredential(credential);
    if (parsedCredential) audit.challengeId = parsedCredential.challenge.id;
    const submittedChallengeId = parsedCredential?.challenge.id;
    if (this.config.PAYMENT_MODE === "fixture") {
      if (!this.#isFixtureMppCredential(service, credential)) {
        return this.#challenge(service, input, audit, "MPP payment verification failed", submittedChallengeId);
      }
      const payer = parsedCredential?.source ?? "0x2222222222222222222222222222222222222222";
      this.#countMppVerification(service);
      this.lifecycleEvents?.push("verify");
      let result: ProviderEnvelope;
      try {
        await this.#enforcePaidRate(payer);
        result = await execute();
      } catch (error) {
        await this.#record(service, audit, "not_fulfilled", {
          paymentStatus: "canceled",
          paymentProtocol: "mpp",
          payer,
          network: "eip155:8453",
          priceOffer: selectedOffer,
          providerStatus: error instanceof GatewayError && (error.status === 429 || error.status === 503) ? "not_called" : "failed",
        });
        throw error;
      }
      const receipt = {
        ...Receipt.from({
          method: "evm",
          status: "success",
          timestamp: new Date().toISOString(),
          reference: `fixture-mpp-${service.id}`,
        }),
        ...(parsedCredential === undefined ? {} : { challengeId: parsedCredential.challenge.id }),
      };
      this.#countMppSettlement(service);
      this.lifecycleEvents?.push("settle");
      await this.#record(service, audit, "fulfilled", {
        paymentStatus: "settled",
        paymentProtocol: "mpp",
        payer,
        network: "eip155:8453",
        priceOffer: selectedOffer,
        paymentReference: receipt.reference,
        providerStatus: "success",
        responseBytes: Buffer.byteLength(JSON.stringify(result)),
      });
      this.lifecycleEvents?.push("release");
      return successResult(result, { [MPP_RECEIPT_KEY]: receipt });
    }
    if (!parsedCredential || !isMppChallengeForService(parsedCredential.challenge, service, this.config, mppMcpScope(service))) {
      this.metrics.increment("archer_payment_failures_total", { protocol: "mpp", service: service.id });
      return this.#challenge(service, input, audit, "MPP payment verification failed", submittedChallengeId);
    }
    const authorization = AuthorizationPayloadSchema.safeParse(parsedCredential.payload);
    const paymentRequired = await this.#paymentRequired(service, input);
    const requirement = paymentRequired.accepts.find((item) => item.network === "eip155:8453"
      && item.scheme === "exact"
      && item.asset.toLowerCase() === this.config.BASE_USDC_ADDRESS.toLowerCase()
      && item.amount === configuredPrice(this.config, service.pricing).atomic
      && item.payTo.toLowerCase() === this.config.PAYMENT_RECIPIENT?.toLowerCase());
    if (!authorization.success
      || !requirement
      || (paymentRequired.extensions !== undefined && Object.keys(paymentRequired.extensions).length > 0)
      || !mppAuthorizationMatches(parsedCredential, authorization.data, requirement)) {
      this.metrics.increment("archer_payment_failures_total", { protocol: "mpp", service: service.id });
      return this.#challenge(service, input, audit, "MPP payment verification failed", submittedChallengeId);
    }
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: requirement,
      payload: {
        authorization: {
          from: authorization.data.from,
          nonce: authorization.data.nonce,
          to: authorization.data.to,
          validAfter: authorization.data.validAfter,
          validBefore: authorization.data.validBefore,
          value: authorization.data.value,
        },
        signature: authorization.data.signature,
      },
    };
    const transportContext = {
      transport: "mcp",
      paymentProtocol: "mpp",
      tool: service.mcp.name,
      serviceId: service.id,
      requestId: audit.requestId,
    };
    let verified;
    try {
      verified = await this.resourceServer.verifyPayment(payload, requirement, paymentRequired.extensions, transportContext);
    } catch {
      return this.#challenge(service, input, audit, "MPP payment verification failed", submittedChallengeId);
    }
    if (!verified.isValid) {
      await this.#throwIfRateLimited(service, audit, "mpp", requirement.network, selectedOffer, verified.invalidReason, verified.payer);
      this.metrics.increment("archer_payment_failures_total", { protocol: "mpp", service: service.id });
      return this.#challenge(service, input, audit, verified.invalidReason ?? "MPP payment verification failed", submittedChallengeId);
    }
    const payer = verified.payer;
    if (!payer) {
      return this.#challenge(service, input, audit, "MPP payment verification did not identify a payer", submittedChallengeId);
    }
    const settlement = await this.#mpp.settle(service, parsedCredential);
    if (!settlement.settled) {
      this.metrics.increment("archer_payment_failures_total", { protocol: "mpp", service: service.id, phase: "settle" });
      return this.#challenge(service, input, audit, settlement.error ?? "MPP payment settlement failed", submittedChallengeId);
    }
    this.#countMppSettlement(service);
    const reference = receiptReference(settlement.receipt);
    let result: ProviderEnvelope;
    try {
      result = await execute();
    } catch (error) {
      await this.#record(service, audit, "not_fulfilled", {
        paymentStatus: "settled",
        paymentProtocol: "mpp",
        payer,
        network: "eip155:8453",
        priceOffer: selectedOffer,
        ...(reference === undefined ? {} : { paymentReference: reference }),
        providerStatus: "failed",
      });
      throw error;
    }
    await this.#record(service, audit, "fulfilled", {
      paymentStatus: "settled",
      paymentProtocol: "mpp",
      payer,
      network: "eip155:8453",
      priceOffer: selectedOffer,
      ...(reference === undefined ? {} : { paymentReference: reference }),
      providerStatus: "success",
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
    });
    this.lifecycleEvents?.push("release");
    return successResult(result, { [MPP_RECEIPT_KEY]: settlement.receipt });
  }

  async #invokeX402(
    service: ServiceDefinition,
    input: ServiceInput,
    credential: unknown,
    audit: InvocationAudit,
    execute: () => Promise<ProviderEnvelope>,
  ): Promise<CallToolResult> {
    const parsed = PaymentPayloadV2Schema.safeParse(credential);
    if (!parsed.success) return this.#challenge(service, input, audit, "Malformed x402 payment payload");
    const payload = parsed.data as PaymentPayload;
    const paymentRequired = await this.#paymentRequired(service, input);
    if (!this.resourceServer.validateExtensions(paymentRequired, payload).valid) {
      return this.#challenge(service, input, audit, "x402 extension echo mismatch");
    }
    const requirement = this.resourceServer.findMatchingRequirements(paymentRequired.accepts, payload);
    if (!requirement) return this.#challenge(service, input, audit, "Payment does not match an offered requirement");
    audit.fingerprint = hashCanonical({ requestFingerprint: audit.fingerprint, selectedPriceOffer: offerKey(requirement) });
    const transportContext = { transport: "mcp", tool: service.mcp.name, serviceId: service.id, requestId: audit.requestId };
    let verified;
    try {
      verified = await this.resourceServer.verifyPayment(payload, requirement, paymentRequired.extensions, transportContext);
    } catch {
      return this.#challenge(service, input, audit, "x402 verification failed");
    }
    if (!verified.isValid) {
      await this.#throwIfRateLimited(service, audit, "x402", requirement.network, offerKey(requirement), verified.invalidReason, verified.payer);
      this.metrics.increment("archer_payment_failures_total", { protocol: "x402", service: service.id });
      return this.#challenge(service, input, audit, verified.invalidReason ?? "x402 verification failed");
    }
    const payer = verified.payer ?? "unknown";
    const cancellation = this.resourceServer.createPaymentCancellationDispatcher(payload, requirement, paymentRequired.extensions, transportContext);
    let result: ProviderEnvelope;
    try {
      result = await execute();
    } catch (error) {
      await cancellation.cancel({ reason: "handler_threw", error });
      await this.#record(service, audit, "not_fulfilled", {
        paymentStatus: "canceled",
        paymentProtocol: "x402",
        payer,
        network: requirement.network,
        priceOffer: offerKey(requirement),
        providerStatus: error instanceof GatewayError && error.status === 429 ? "not_called" : "failed",
      });
      throw error;
    }
    let settlement: SettleResponse;
    try {
      settlement = await this.resourceServer.settlePayment(payload, requirement, paymentRequired.extensions, transportContext);
    } catch {
      this.metrics.increment("archer_payment_failures_total", { protocol: "x402", service: service.id });
      await this.#record(service, audit, "withheld", {
        paymentStatus: "failed",
        paymentProtocol: "x402",
        payer,
        network: requirement.network,
        priceOffer: offerKey(requirement),
        providerStatus: "success",
      });
      return this.#error("Payment settlement failed; no data was released", "payment_invalid", audit.requestId);
    }
    if (!settlement.success) {
      await this.#record(service, audit, "withheld", {
        paymentStatus: "failed",
        paymentProtocol: "x402",
        payer,
        network: requirement.network,
        priceOffer: offerKey(requirement),
        providerStatus: "success",
      });
      return this.#error("Payment settlement failed; no data was released", "payment_invalid", audit.requestId);
    }
    await this.#record(service, audit, "fulfilled", {
      paymentStatus: "settled",
      paymentProtocol: "x402",
      payer: settlement.payer ?? payer,
      network: settlement.network,
      priceOffer: offerKey(requirement),
      paymentReference: settlement.transaction,
      providerStatus: "success",
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
    });
    this.lifecycleEvents?.push("release");
    return successResult(result, { [X402_RECEIPT_KEY]: settlement });
  }

  async #enforcePaidRate(payer: string): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const identity = hashCanonical(payer.toLowerCase());
    const count = await incrementRateBucket(this.state, `rate:paid:${identity}:${String(minute)}`);
    if (count > this.config.PAID_RATE_LIMIT_PER_MINUTE) throw new GatewayError(429, "rate_limited", "Paid caller rate limit exceeded");
  }

  async #enforceChallengeRate(identity: string): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const count = await incrementRateBucket(this.state, `rate:challenge:${hashCanonical(identity)}:${String(minute)}`);
    if (count > this.config.CHALLENGE_RATE_LIMIT_PER_MINUTE) {
      throw new GatewayError(429, "rate_limited", "Payment challenge rate limit exceeded");
    }
  }

  async #throwIfRateLimited(
    service: ServiceDefinition,
    audit: InvocationAudit,
    protocol: "mpp" | "x402",
    network: string,
    priceOffer: string,
    reason: string | undefined,
    payer: string | undefined,
  ): Promise<void> {
    if (reason !== "rate_limited" && reason !== "rate_limit_unavailable") return;
    const unavailable = reason === "rate_limit_unavailable";
    await this.#record(service, audit, "not_fulfilled", {
      paymentStatus: "canceled",
      paymentProtocol: protocol,
      ...(payer === undefined ? {} : { payer }),
      network,
      priceOffer,
      providerStatus: "not_called",
    });
    throw new GatewayError(unavailable ? 503 : 429, unavailable ? "dependency_unavailable" : "rate_limited", unavailable
      ? "Paid caller rate limit is unavailable"
      : "Paid caller rate limit exceeded");
  }

  async #record(
    service: ServiceDefinition,
    invocation: InvocationAudit,
    fulfillmentResult: string,
    details: Partial<Omit<PaymentAuditRecord, "requestId" | "challengeId" | "requestFingerprint" | "serviceId" | "transport" | "fulfillmentResult">>,
  ): Promise<void> {
    await this.audit.record({
      requestId: invocation.requestId,
      challengeId: invocation.challengeId,
      requestFingerprint: invocation.fingerprint,
      serviceId: service.id,
      transport: "mcp",
      fulfillmentResult,
      latencyMs: Math.round(performance.now() - invocation.startedAt),
      ...details,
    });
  }

  async #paymentRequired(service: ServiceDefinition, input: ServiceInput, error?: string): Promise<PaymentRequired> {
    const options = paymentOptions(service, this.config);
    const requirements = await this.resourceServer.buildPaymentRequirementsFromOptions(options, { toolName: service.mcp.name, arguments: input });
    return this.resourceServer.createPaymentRequiredResponse(
      requirements,
      {
        url: `mcp://tool/${service.mcp.name}`,
        description: service.description,
        mimeType: "application/json",
        serviceName: "Archer Protocol Gateway",
        tags: [service.pricing],
      },
      error,
      undefined,
      { transport: "mcp", tool: service.mcp.name },
    );
  }

  async #mppChallenge(service: ServiceDefinition): Promise<MppPaymentRequired> {
    return this.#mpp.challenge(service);
  }

  #isFixtureMppCredential(service: ServiceDefinition, credential: unknown): boolean {
    if (credential === "fixture-mpp") return true;
    const parsed = parseMppCredential(credential);
    return parsed !== undefined && isMppChallengeForService(parsed.challenge, service, this.config, mppMcpScope(service));
  }

  #countMppVerification(service: ServiceDefinition): void {
    const labels = { network: "eip155:8453", protocol: "mpp", service: service.id };
    this.metrics.increment("archer_payment_verified_total", labels);
  }

  #countMppSettlement(service: ServiceDefinition): void {
    const labels = { network: "eip155:8453", protocol: "mpp", service: service.id };
    this.metrics.increment("archer_payment_settled_total", labels);
  }

  #error(message: string, code: string, requestId: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message, requestId } }) }] };
  }
}

function mppAuthorizationMatches(
  credential: Credential.Credential,
  authorization: AuthorizationPayload,
  requirement: PaymentRequirements,
): boolean {
  try {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    return authorization.nonce.toLowerCase() === challengeHash(credential.challenge).toLowerCase()
      && authorization.to.toLowerCase() === requirement.payTo.toLowerCase()
      && authorization.value === requirement.amount
      && BigInt(authorization.validAfter) <= now
      && BigInt(authorization.validBefore) > now;
  } catch {
    return false;
  }
}

function offerKey(requirement: PaymentRequirements): string {
  return `${requirement.network}:${requirement.asset.toLowerCase()}:${requirement.amount}:${requirement.payTo.toLowerCase()}`;
}

function receiptReference(receipt: unknown): string | undefined {
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const value = receipt as Record<string, unknown>;
  return typeof value.reference === "string" ? value.reference : typeof value.transaction === "string" ? value.transaction : undefined;
}

function successResult(envelope: ProviderEnvelope, meta: Record<string, unknown>): CallToolResult {
  const structured = envelope as unknown as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: structured, _meta: meta };
}

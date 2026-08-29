import { Credential, type Challenge } from "mppx";
import { Mppx, Transport, evm } from "mppx/server";
import type { GatewayConfig } from "../config.js";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceDefinition } from "../catalog/types.js";
import { mppChallengeExpiry, mppMcpScope, parseMppCredential } from "./mpp-wire.js";

interface MppInput { credential?: unknown }
interface MppChallenge { challenge: Challenge.Challenge }
interface MppReceipt { receipt: unknown }

export interface MppPaymentRequired {
  challenges: Challenge.Challenge[];
}

export interface MppSettlementResult {
  settled: boolean;
  receipt?: unknown;
  error?: string;
}

export function createMppMcpAdapter(config: GatewayConfig) {
  if (!config.PAYMENT_RECIPIENT || !config.MPP_SECRET_KEY) throw new Error("MPP payment configuration is incomplete");
  const transport = Transport.from<MppInput, MppChallenge, undefined, MppReceipt>({
    name: "archer-mcp-v2",
    getCredential(input) {
      if (input.credential === undefined) return null;
      const parsed = parseMppCredential(input.credential);
      if (!parsed) throw new Credential.InvalidCredentialEncodingError();
      return parsed;
    },
    respondChallenge({ challenge }) { return { challenge }; },
    respondReceipt({ receipt, challengeId }) { return { receipt: { ...receipt, challengeId } }; },
  });
  const methods = evm({
    authorization: { name: "USD Coin", version: "2" },
    chainId: 8453,
    currency: config.BASE_USDC_ADDRESS as `0x${string}`,
    decimals: 6,
    recipient: config.PAYMENT_RECIPIENT as `0x${string}`,
    x402: { facilitator: config.X402_FACILITATOR_URL, maxTimeoutSeconds: 60, routeBinding: "required" },
  });
  const server = Mppx.create({
    methods,
    realm: new URL(config.PUBLIC_ORIGIN).hostname,
    secretKey: config.MPP_SECRET_KEY,
    transport,
  });

  const options = (service: ServiceDefinition) => ({
    amount: configuredPrice(config, service.pricing).usd,
    description: service.description,
    expires: mppChallengeExpiry(),
    scope: mppMcpScope(service),
    meta: { service: service.id },
  });
  const verificationOptions = (service: ServiceDefinition) => ({
    realm: new URL(config.PUBLIC_ORIGIN).hostname,
    scope: mppMcpScope(service),
    meta: { service: service.id },
    request: { amount: configuredPrice(config, service.pricing).usd },
  });

  return {
    async challenge(service: ServiceDefinition): Promise<MppPaymentRequired> {
      const challenge = await server.challenge.evm.charge(options(service));
      return { challenges: [challenge] };
    },
    async settle(service: ServiceDefinition, credential: unknown): Promise<MppSettlementResult> {
      try {
        const parsed = parseMppCredential(credential);
        if (!parsed) return { settled: false, error: "MPP payment settlement failed" };
        const receipt = await server.broadcastCredential(parsed, verificationOptions(service));
        return { settled: true, receipt };
      } catch {
        return { settled: false, error: "MPP payment settlement failed" };
      }
    },
  };
}

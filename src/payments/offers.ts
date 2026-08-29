import type { PaymentOption, RoutesConfig } from "@x402/core/http";
import type { AssetAmount, PaymentRequirements } from "@x402/core/types";
import type { GatewayConfig } from "../config.js";
import { SERVICE_CATALOG } from "../catalog/services.js";
import { configuredPrice } from "../catalog/pricing.js";
import type { ServiceDefinition } from "../catalog/types.js";

export type StaticPaymentOption = Omit<PaymentOption, "payTo" | "price"> & { payTo: string; price: AssetAmount };

export function paymentOptions(service: ServiceDefinition, config: GatewayConfig): StaticPaymentOption[] {
  const price = configuredPrice(config, service.pricing);
  const recipient = config.PAYMENT_RECIPIENT;
  if (!recipient) throw new Error("PAYMENT_RECIPIENT is required to build payment offers");
  return [
    {
      scheme: "exact",
      network: "eip155:8453",
      payTo: recipient,
      price: {
        amount: price.atomic,
        asset: config.BASE_USDC_ADDRESS,
        extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
      },
      maxTimeoutSeconds: 60,
    },
    {
      scheme: "exact",
      network: "eip155:4663",
      payTo: recipient,
      price: {
        amount: price.atomic,
        asset: config.ROBINHOOD_USDG_ADDRESS,
        extra: { assetTransferMethod: "permit2" },
      },
      maxTimeoutSeconds: 60,
    },
  ];
}

export function routeKey(service: ServiceDefinition): string {
  return `${service.http.method} ${service.http.path.replaceAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1")}`;
}

export function buildX402Routes(config: GatewayConfig): RoutesConfig {
  return Object.fromEntries(SERVICE_CATALOG.map((service) => [
    routeKey(service),
    {
      accepts: paymentOptions(service, config),
      resource: new URL(service.http.path, config.PUBLIC_ORIGIN).toString(),
      description: service.description,
      mimeType: "application/json",
      serviceName: "Archer Protocol Gateway",
      tags: [service.id.split(".")[0] ?? "archer", service.pricing],
    },
  ]));
}

export function requirementsForDiscovery(service: ServiceDefinition, config: GatewayConfig): PaymentRequirements[] {
  return paymentOptions(service, config).map((option) => {
    if (typeof option.payTo !== "string" || typeof option.price !== "object") throw new Error("Discovery offers must be static");
    return {
      scheme: option.scheme,
      network: option.network,
      asset: option.price.asset,
      amount: option.price.amount,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds ?? 60,
      extra: option.price.extra ?? {},
    };
  });
}

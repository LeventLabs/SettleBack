import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describeNetwork, type Environment, type NetworkDescription, type NetworkProfile } from "@settleback/domain";
import { ManualClock } from "./clock.ts";
import { MerchantClient } from "./hsp/merchant-client.ts";
import { ProvenanceViolationError } from "./provenance.ts";
import { SimChain } from "./sim/chain.ts";
import { SimGateway } from "./sim/gateway.ts";
import { SimulatedPaymentRail } from "./sim/payment-rail.ts";

export interface SimulatedAdapters {
  provenance: "SIMULATED";
  network: NetworkDescription;
  clock: ManualClock;
  paymentChain: SimChain;
  gateway: SimGateway;
  /** The receiving agent's client for the simulated gateway, with a freshly generated merchant key. */
  merchant: MerchantClient;
  /** The merchant public key a Payment Agent pins for this simulated seller. */
  merchantPublicKey: KeyObject;
  rail: SimulatedPaymentRail;
}

export interface SimulatedAdapterOptions {
  environment: Environment;
  profile?: NetworkProfile;
  /** The simulated application's app_secret; request signatures and webhooks use it, as documented. */
  webhookSecret: string;
  merchantName?: string;
  start?: string;
}

/**
 * Builds the simulated payment gateway and chain. Refuses any live environment, so simulated
 * payments can never be produced where real evidence is expected. The registry has no simulator:
 * locally it is the real contract on a disposable chain (see EvmRegistryGateway).
 */
export function createSimulatedAdapters(options: SimulatedAdapterOptions): SimulatedAdapters {
  if (options.environment !== "local") {
    throw new ProvenanceViolationError(`Simulated adapters are not available in the "${options.environment}" environment.`);
  }
  const network = describeNetwork("local", options.profile);
  const clock = new ManualClock(options.start ?? "2026-10-30T10:00:00.000Z");
  const paymentChain = new SimChain(network.paymentChainId);
  const gateway = new SimGateway({ clock, chain: paymentChain });
  const keys = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const merchantName = options.merchantName ?? "SettleBack Demo Seller";
  gateway.registerApp({ appKey: "sim-app-key", appSecret: options.webhookSecret, merchantName, publicKey: keys.publicKey });
  const merchant = new MerchantClient({
    credentials: { appKey: "sim-app-key", appSecret: options.webhookSecret, merchantName, privateKey: keys.privateKey },
    transport: (request) => gateway.handle(request),
    clock,
  });
  return {
    provenance: "SIMULATED",
    network,
    clock,
    paymentChain,
    gateway,
    merchant,
    merchantPublicKey: keys.publicKey,
    rail: new SimulatedPaymentRail({ gateway, chain: paymentChain, clock, merchant }),
  };
}

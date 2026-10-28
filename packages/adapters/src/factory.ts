import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describeNetwork, type Address, type Environment, type NetworkDescription, type NetworkProfile } from "@settleback/domain";
import { ManualClock } from "./clock.ts";
import { MerchantClient } from "./hsp/merchant-client.ts";
import { ProvenanceViolationError } from "./provenance.ts";
import { SimChain } from "./sim/chain.ts";
import { SimGateway } from "./sim/gateway.ts";
import { SimulatedPaymentRail } from "./sim/payment-rail.ts";
import { SimulatedRegistry } from "./sim/registry.ts";

export interface SimulatedAdapters {
  provenance: "SIMULATED";
  network: NetworkDescription;
  clock: ManualClock;
  paymentChain: SimChain;
  registryChain: SimChain;
  gateway: SimGateway;
  /** The receiving agent's client for the simulated gateway, with a freshly generated merchant key. */
  merchant: MerchantClient;
  /** The merchant public key a Payment Agent pins for this simulated seller. */
  merchantPublicKey: KeyObject;
  rail: SimulatedPaymentRail;
  registry: SimulatedRegistry;
}

export interface SimulatedAdapterOptions {
  environment: Environment;
  profile?: NetworkProfile;
  verifier: Address;
  /** The simulated application's app_secret; request signatures and webhooks use it, as documented. */
  webhookSecret: string;
  merchantName?: string;
  start?: string;
}

/**
 * Builds the simulated gateway, chains, and registry. Refuses any live environment, so simulated
 * payments and registry records can never be produced where real evidence is expected.
 */
export function createSimulatedAdapters(options: SimulatedAdapterOptions): SimulatedAdapters {
  if (options.environment !== "local") {
    throw new ProvenanceViolationError(`Simulated adapters are not available in the "${options.environment}" environment.`);
  }
  const network = describeNetwork("local", options.profile);
  const clock = new ManualClock(options.start ?? "2026-10-30T10:00:00.000Z");
  const paymentChain = new SimChain(network.paymentChainId);
  const registryChain = network.registryChainId === network.paymentChainId ? paymentChain : new SimChain(network.registryChainId);
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
    registryChain,
    gateway,
    merchant,
    merchantPublicKey: keys.publicKey,
    rail: new SimulatedPaymentRail({ gateway, chain: paymentChain, clock, merchant }),
    registry: new SimulatedRegistry({ chain: registryChain, verifier: options.verifier, clock }),
  };
}

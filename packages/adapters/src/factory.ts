import { describeNetwork, type Address, type Environment, type NetworkDescription, type NetworkProfile } from "@settleback/domain";
import { ManualClock } from "./clock.ts";
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
  rail: SimulatedPaymentRail;
  registry: SimulatedRegistry;
}

export interface SimulatedAdapterOptions {
  environment: Environment;
  profile?: NetworkProfile;
  verifier: Address;
  webhookSecret: string;
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
  const gateway = new SimGateway({ clock, chain: paymentChain, webhookSecret: options.webhookSecret });
  return {
    provenance: "SIMULATED",
    network,
    clock,
    paymentChain,
    registryChain,
    gateway,
    rail: new SimulatedPaymentRail({ gateway, chain: paymentChain, clock }),
    registry: new SimulatedRegistry({ chain: registryChain, verifier: options.verifier, clock }),
  };
}

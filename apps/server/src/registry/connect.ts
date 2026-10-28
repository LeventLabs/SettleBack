import { EvmRegistryGateway, type RegistryGateway } from "@settleback/adapters";
import type { Environment } from "@settleback/domain";
import type { RegistryConfig } from "../config.ts";

const RPC_TIMEOUT_MS = 15_000;

/**
 * Connects to the configured registry, or returns undefined when none is configured. The local
 * environment's registry is the real contract on a disposable chain and is labeled simulated;
 * every live environment's registry is labeled live. Connection checks the chain, the code at the
 * address, and the verifier key, and throws on any mismatch.
 */
export async function connectRegistry(config: RegistryConfig | undefined, environment: Environment): Promise<RegistryGateway | undefined> {
  if (config === undefined) return undefined;
  return EvmRegistryGateway.connect({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    address: config.address,
    provenance: environment === "local" ? "SIMULATED" : "LIVE",
    ...(config.verifierPrivateKey === undefined ? {} : { verifierPrivateKey: config.verifierPrivateKey.reveal() as `0x${string}` }),
    confirmations: config.confirmations,
    timeoutMs: RPC_TIMEOUT_MS,
  });
}

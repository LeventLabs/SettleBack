import { EvmRegistryGateway, type RegistryGateway } from "@settleback/adapters";
import { isHskChain, type RegistryConfig } from "../config.ts";

const RPC_TIMEOUT_MS = 15_000;

/**
 * Connects to the configured registry, or returns undefined when none is configured. A registry on
 * a disposable local chain is labeled simulated; one on HSK Chain is labeled live, including the
 * fixture demo's registry on HSK Chain testnet, whose cases still reference simulated payments.
 * Connection checks the chain, the code at the address, and the verifier key, and throws on any
 * mismatch.
 */
export async function connectRegistry(config: RegistryConfig | undefined): Promise<RegistryGateway | undefined> {
  if (config === undefined) return undefined;
  return EvmRegistryGateway.connect({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    address: config.address,
    provenance: isHskChain(config.chainId) ? "LIVE" : "SIMULATED",
    ...(config.verifierPrivateKey === undefined ? {} : { verifierPrivateKey: config.verifierPrivateKey.reveal() as `0x${string}` }),
    confirmations: config.confirmations,
    timeoutMs: RPC_TIMEOUT_MS,
  });
}

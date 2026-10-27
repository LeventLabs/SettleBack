export const ENVIRONMENTS = ["local", "testnet", "mixed", "mainnet"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export const NETWORK_PROFILES = ["testnet", "mixed", "mainnet"] as const;

export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export const HASHKEY_TESTNET_CHAIN_ID = 133;
export const HASHKEY_MAINNET_CHAIN_ID = 177;

export type ExecutionMode = "simulated" | "live";

export interface NetworkDescription {
  environment: Environment;
  mode: ExecutionMode;
  profile: NetworkProfile;
  paymentChainId: number;
  registryChainId: number;
  label: string;
}

const PROFILES: Record<NetworkProfile, { paymentChainId: number; registryChainId: number; label: string }> = {
  testnet: { paymentChainId: HASHKEY_TESTNET_CHAIN_ID, registryChainId: HASHKEY_TESTNET_CHAIN_ID, label: "testnet" },
  mixed: {
    paymentChainId: HASHKEY_TESTNET_CHAIN_ID,
    registryChainId: HASHKEY_MAINNET_CHAIN_ID,
    label: "mixed-network: testnet payment, mainnet registry",
  },
  mainnet: { paymentChainId: HASHKEY_MAINNET_CHAIN_ID, registryChainId: HASHKEY_MAINNET_CHAIN_ID, label: "mainnet" },
};

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}

export function parseEnvironment(value: string): Environment {
  if (!isEnvironment(value)) {
    throw new Error(`Unknown environment "${value}". Expected one of: ${ENVIRONMENTS.join(", ")}.`);
  }
  return value;
}

export function parseNetworkProfile(value: string): NetworkProfile {
  const profile = NETWORK_PROFILES.find((candidate) => candidate === value);
  if (profile === undefined) {
    throw new Error(`Unknown network profile "${value}". Expected one of: ${NETWORK_PROFILES.join(", ")}.`);
  }
  return profile;
}

/**
 * The local environment simulates one of the live profiles and always says so; every live
 * environment runs exactly its own profile.
 */
export function describeNetwork(environment: Environment, simulatedProfile: NetworkProfile = "testnet"): NetworkDescription {
  if (environment === "local") {
    const profile = PROFILES[simulatedProfile];
    return {
      environment,
      mode: "simulated",
      profile: simulatedProfile,
      paymentChainId: profile.paymentChainId,
      registryChainId: profile.registryChainId,
      label: `local simulation (${profile.label})`,
    };
  }
  const profile = PROFILES[environment];
  return {
    environment,
    mode: "live",
    profile: environment,
    paymentChainId: profile.paymentChainId,
    registryChainId: profile.registryChainId,
    label: profile.label,
  };
}

export function networkLabel(environment: Environment, simulatedProfile?: NetworkProfile): string {
  return describeNetwork(environment, simulatedProfile).label;
}

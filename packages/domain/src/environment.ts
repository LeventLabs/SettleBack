export const ENVIRONMENTS = ["local", "testnet", "mixed", "mainnet"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

const NETWORK_LABELS: Record<Environment, string> = {
  local: "local simulation",
  testnet: "testnet",
  mixed: "mixed-network: testnet payment, mainnet registry",
  mainnet: "mainnet",
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

export function networkLabel(environment: Environment): string {
  return NETWORK_LABELS[environment];
}

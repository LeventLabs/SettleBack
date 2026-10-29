import { fileURLToPath } from "node:url";
import { describeNetwork, parseEnvironment, parseNetworkProfile, type Environment, type NetworkProfile } from "@settleback/domain";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
/** Models the assessment may be pinned to. Changing the list is a reviewed code change. */
export const ASSESSMENT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
export const ASSESSMENT_EFFORTS = ["low", "medium", "high"] as const;
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../data/", import.meta.url));

export type LogLevel = (typeof LOG_LEVELS)[number];
export type AssessmentModel = (typeof ASSESSMENT_MODELS)[number];
export type AssessmentEffort = (typeof ASSESSMENT_EFFORTS)[number];

/** Holds a credential without exposing it to logs or JSON serialization. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }
}

export interface AssessmentConfig {
  model: AssessmentModel;
  effort: AssessmentEffort;
  /** Output limit for one assessment, reasoning included. */
  maxTokens: number;
  timeoutMs: number;
  /** Absent means assessments fail with PROVIDER_NOT_CONFIGURED; they are never skipped. */
  apiKey: Secret | undefined;
}

export interface ServerConfig {
  environment: Environment;
  host: string;
  port: number;
  logLevel: LogLevel;
  paymentWritesEnabled: boolean;
  /** One database per environment so records from different networks never mix. */
  databasePath: string;
  /** Which live profile the local simulation imitates; meaningless and refused elsewhere. */
  simulatedProfile: NetworkProfile;
  assessment: AssessmentConfig;
  /** Undefined when no registry is configured; integrated repayment is then unavailable. */
  registry: RegistryConfig | undefined;
  auth: AuthConfig;
  /** Local only: seeded fixture cases, in memory and reseeded on every start. */
  demo: DemoConfig | undefined;
}

export interface DemoConfig {
  /** The fixture operations' buyer and seller: accounts the person running the demo can sign in with. */
  buyer: `0x${string}`;
  seller: `0x${string}`;
}

export interface AuthConfig {
  /** The only origin writes are accepted from, and the domain and URI wallets are asked to sign in to. */
  webOrigin: string;
  /** Lowercase wallet addresses that sign in as operators. No request can grant the role. */
  operators: readonly `0x${string}`[];
}

export interface RegistryConfig {
  rpcUrl: string;
  chainId: number;
  address: `0x${string}`;
  /** Blocks before a registry write or a reported reservation counts as confirmed. */
  confirmations: number;
  /** The verifier's key for registry writes; absent means read and confirm only. */
  verifierPrivateKey: Secret | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const environment = parseEnvironment(env.SETTLEBACK_ENV ?? "local");
  const paymentWritesEnabled = parsePaymentWrites(env.SETTLEBACK_PAYMENT_WRITES ?? "disabled");

  // Live payment writes need chain, token, gateway, and finality settings that do not exist yet.
  // Refusing here keeps a misconfigured deployment from looking ready.
  if (paymentWritesEnabled && environment !== "local") {
    throw new Error(
      `SETTLEBACK_PAYMENT_WRITES=enabled is not supported for the "${environment}" environment: ` +
        "live chain, token, gateway, and finality configuration is not implemented.",
    );
  }

  if (env.SETTLEBACK_SIM_PROFILE !== undefined && environment !== "local") {
    throw new Error(`SETTLEBACK_SIM_PROFILE applies only to the local environment, not "${environment}".`);
  }

  const demo = parseDemo(env, environment);
  return {
    environment,
    simulatedProfile: parseNetworkProfile(env.SETTLEBACK_SIM_PROFILE ?? "testnet"),
    host: env.SETTLEBACK_HOST ?? "127.0.0.1",
    port: parsePort(env.SETTLEBACK_PORT ?? "8787"),
    logLevel: parseLogLevel(env.SETTLEBACK_LOG_LEVEL ?? "info"),
    paymentWritesEnabled,
    // The demo's data is disposable: it lives in memory and is reseeded on every start.
    databasePath: demo === undefined ? (env.SETTLEBACK_DB_PATH ?? `${DEFAULT_DATA_DIR}settleback-${environment}.db`) : ":memory:",
    assessment: {
      model: parseMember("SETTLEBACK_ASSESSMENT_MODEL", env.SETTLEBACK_ASSESSMENT_MODEL ?? "claude-opus-5-5", ASSESSMENT_MODELS),
      effort: parseMember("SETTLEBACK_ASSESSMENT_EFFORT", env.SETTLEBACK_ASSESSMENT_EFFORT ?? "medium", ASSESSMENT_EFFORTS),
      maxTokens: parseBoundedInteger("SETTLEBACK_ASSESSMENT_MAX_TOKENS", env.SETTLEBACK_ASSESSMENT_MAX_TOKENS ?? "8000", 1000, 32000),
      timeoutMs: parseBoundedInteger("SETTLEBACK_ASSESSMENT_TIMEOUT_MS", env.SETTLEBACK_ASSESSMENT_TIMEOUT_MS ?? "45000", 5000, 120000),
      apiKey: parseApiKey(env.ANTHROPIC_API_KEY),
    },
    registry: parseRegistry(env, environment, env.SETTLEBACK_SIM_PROFILE === undefined ? "testnet" : parseNetworkProfile(env.SETTLEBACK_SIM_PROFILE)),
    auth: { webOrigin: parseWebOrigin(env.SETTLEBACK_WEB_ORIGIN, environment), operators: parseOperators(env.SETTLEBACK_OPERATORS ?? "") },
    demo,
  };
}

function parseDemo(env: NodeJS.ProcessEnv, environment: Environment): DemoConfig | undefined {
  const mode = env.SETTLEBACK_DEMO ?? "";
  const buyer = env.SETTLEBACK_DEMO_BUYER ?? "";
  const seller = env.SETTLEBACK_DEMO_SELLER ?? "";
  if (mode === "") {
    if (buyer !== "" || seller !== "") throw new Error("SETTLEBACK_DEMO_BUYER and SETTLEBACK_DEMO_SELLER apply only with SETTLEBACK_DEMO=fixtures.");
    return undefined;
  }
  if (mode !== "fixtures") throw new Error(`SETTLEBACK_DEMO must be "fixtures" or unset, got "${mode}".`);
  if (environment !== "local") throw new Error(`SETTLEBACK_DEMO applies only to the local environment, not "${environment}".`);
  if ((env.SETTLEBACK_DB_PATH ?? "") !== "") throw new Error("The demo keeps its data in memory; unset SETTLEBACK_DB_PATH.");
  for (const [name, value] of [["SETTLEBACK_DEMO_BUYER", buyer], ["SETTLEBACK_DEMO_SELLER", seller]] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be the 20-byte hex address of an account you can sign in with, got "${value}".`);
  }
  if (buyer.toLowerCase() === seller.toLowerCase()) throw new Error("SETTLEBACK_DEMO_BUYER and SETTLEBACK_DEMO_SELLER must be different accounts.");
  return { buyer: buyer.toLowerCase() as `0x${string}`, seller: seller.toLowerCase() as `0x${string}` };
}

const LOCAL_WEB_ORIGIN = "http://localhost:5173";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];

/**
 * A bare origin (scheme, host, optional port). A live environment must name its HTTPS origin; plain
 * HTTP is accepted only for a loopback host in the local environment.
 */
function parseWebOrigin(value: string | undefined, environment: Environment): string {
  if (value === undefined || value === "") {
    if (environment === "local") return LOCAL_WEB_ORIGIN;
    throw new Error(`SETTLEBACK_WEB_ORIGIN is required for the "${environment}" environment.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SETTLEBACK_WEB_ORIGIN is not a URL, got "${value}".`);
  }
  if (url.origin !== value) throw new Error(`SETTLEBACK_WEB_ORIGIN must be a bare origin such as https://settleback.xyz, got "${value}".`);
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && environment === "local" && LOOPBACK_HOSTS.includes(url.hostname)) return value;
  throw new Error(`SETTLEBACK_WEB_ORIGIN must use HTTPS${environment === "local" ? " or a loopback HTTP origin" : ""}, got "${value}".`);
}

function parseOperators(value: string): `0x${string}`[] {
  const operators = new Set<`0x${string}`>();
  for (const entry of value.split(",")) {
    const address = entry.trim();
    if (address === "") continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`SETTLEBACK_OPERATORS must be comma-separated 20-byte hex addresses, got "${address}".`);
    operators.add(address.toLowerCase() as `0x${string}`);
  }
  return [...operators];
}

const HSK_CHAINS = [133, 177];

/**
 * All of RPC URL, chain ID, and address, or none. A local environment may only use a disposable
 * chain, never HSK Chain; a live environment may only use its profile's registry chain, over HTTPS.
 */
function parseRegistry(env: NodeJS.ProcessEnv, environment: Environment, simulatedProfile: NetworkProfile): RegistryConfig | undefined {
  const rpcUrl = env.SETTLEBACK_REGISTRY_RPC_URL;
  const chain = env.SETTLEBACK_REGISTRY_CHAIN_ID;
  const address = env.SETTLEBACK_REGISTRY_ADDRESS;
  const given = [rpcUrl, chain, address].filter((value) => value !== undefined && value !== "");
  if (given.length === 0) {
    if (env.SETTLEBACK_VERIFIER_PRIVATE_KEY) throw new Error("SETTLEBACK_VERIFIER_PRIVATE_KEY is set but no registry is configured.");
    return undefined;
  }
  if (given.length !== 3 || rpcUrl === undefined || chain === undefined || address === undefined) {
    throw new Error("SETTLEBACK_REGISTRY_RPC_URL, SETTLEBACK_REGISTRY_CHAIN_ID, and SETTLEBACK_REGISTRY_ADDRESS must be set together.");
  }
  const chainId = parseBoundedInteger("SETTLEBACK_REGISTRY_CHAIN_ID", chain, 1, 2 ** 32);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`SETTLEBACK_REGISTRY_ADDRESS must be a 20-byte hex address, got "${address}".`);
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error(`SETTLEBACK_REGISTRY_RPC_URL is not a URL, got "${rpcUrl}".`);
  }
  if (environment === "local") {
    if (HSK_CHAINS.includes(chainId)) throw new Error("The local environment uses a disposable chain for the registry, never HSK Chain 133 or 177.");
  } else {
    const expected = describeNetwork(environment, simulatedProfile).registryChainId;
    if (chainId !== expected) throw new Error(`The ${environment} environment's registry is on chain ${expected}, not ${chainId}.`);
    if (url.protocol !== "https:") throw new Error("A live registry RPC URL must use HTTPS.");
  }
  const key = env.SETTLEBACK_VERIFIER_PRIVATE_KEY;
  if (key !== undefined && key !== "" && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // Never echo the value.
    throw new Error("SETTLEBACK_VERIFIER_PRIVATE_KEY must be 0x followed by 64 hex digits.");
  }
  return {
    rpcUrl,
    chainId,
    address: address as `0x${string}`,
    confirmations: parseBoundedInteger(
      "SETTLEBACK_REGISTRY_CONFIRMATIONS",
      env.SETTLEBACK_REGISTRY_CONFIRMATIONS ?? (environment === "local" ? "1" : "3"),
      1,
      64,
    ),
    verifierPrivateKey: key === undefined || key === "" ? undefined : new Secret(key),
  };
}

function parseMember<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${value}".`);
  return found;
}

function parseBoundedInteger(name: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${value}".`);
  }
  return parsed;
}

function parseApiKey(value: string | undefined): Secret | undefined {
  if (value === undefined || value === "") return undefined;
  // Never echo the value: a malformed key is still a secret.
  if (/\s|["']/.test(value)) throw new Error("ANTHROPIC_API_KEY contains whitespace or quotes; paste the key alone after '='.");
  return new Secret(value);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SETTLEBACK_PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  return port;
}

function parseLogLevel(value: string): LogLevel {
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`SETTLEBACK_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${value}".`);
  }
  return level;
}

function parsePaymentWrites(value: string): boolean {
  if (value === "disabled") return false;
  if (value === "enabled") return true;
  throw new Error(`SETTLEBACK_PAYMENT_WRITES must be "disabled" or "enabled", got "${value}".`);
}

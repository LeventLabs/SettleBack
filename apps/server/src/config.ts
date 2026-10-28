import { fileURLToPath } from "node:url";
import { parseEnvironment, parseNetworkProfile, type Environment, type NetworkProfile } from "@settleback/domain";

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

  return {
    environment,
    simulatedProfile: parseNetworkProfile(env.SETTLEBACK_SIM_PROFILE ?? "testnet"),
    host: env.SETTLEBACK_HOST ?? "127.0.0.1",
    port: parsePort(env.SETTLEBACK_PORT ?? "8787"),
    logLevel: parseLogLevel(env.SETTLEBACK_LOG_LEVEL ?? "info"),
    paymentWritesEnabled,
    databasePath: env.SETTLEBACK_DB_PATH ?? `${DEFAULT_DATA_DIR}settleback-${environment}.db`,
    assessment: {
      model: parseMember("SETTLEBACK_ASSESSMENT_MODEL", env.SETTLEBACK_ASSESSMENT_MODEL ?? "claude-opus-5-5", ASSESSMENT_MODELS),
      effort: parseMember("SETTLEBACK_ASSESSMENT_EFFORT", env.SETTLEBACK_ASSESSMENT_EFFORT ?? "medium", ASSESSMENT_EFFORTS),
      maxTokens: parseBoundedInteger("SETTLEBACK_ASSESSMENT_MAX_TOKENS", env.SETTLEBACK_ASSESSMENT_MAX_TOKENS ?? "8000", 1000, 32000),
      timeoutMs: parseBoundedInteger("SETTLEBACK_ASSESSMENT_TIMEOUT_MS", env.SETTLEBACK_ASSESSMENT_TIMEOUT_MS ?? "45000", 5000, 120000),
      apiKey: parseApiKey(env.ANTHROPIC_API_KEY),
    },
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

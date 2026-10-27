import { fileURLToPath } from "node:url";
import { parseEnvironment, parseNetworkProfile, type Environment, type NetworkProfile } from "@settleback/domain";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../../data/", import.meta.url));

export type LogLevel = (typeof LOG_LEVELS)[number];

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
  };
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

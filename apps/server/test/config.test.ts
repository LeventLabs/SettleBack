import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("defaults to local mode with payment writes disabled and a loopback bind", () => {
    expect(loadConfig({})).toEqual({
      environment: "local",
      host: "127.0.0.1",
      port: 8787,
      logLevel: "info",
      paymentWritesEnabled: false,
      databasePath: expect.stringMatching(/\/data\/settleback-local\.db$/),
    });
  });

  it("uses a separate default database per environment and honors an explicit path", () => {
    expect(loadConfig({ SETTLEBACK_ENV: "testnet" }).databasePath).toMatch(/\/data\/settleback-testnet\.db$/);
    expect(loadConfig({ SETTLEBACK_DB_PATH: "/tmp/x.db" }).databasePath).toBe("/tmp/x.db");
  });

  it("rejects unknown environments, ports, log levels, and payment-write values", () => {
    expect(() => loadConfig({ SETTLEBACK_ENV: "prod" })).toThrow(/Unknown environment/);
    expect(() => loadConfig({ SETTLEBACK_PORT: "80a" })).toThrow(/SETTLEBACK_PORT/);
    expect(() => loadConfig({ SETTLEBACK_PORT: "70000" })).toThrow(/SETTLEBACK_PORT/);
    expect(() => loadConfig({ SETTLEBACK_LOG_LEVEL: "verbose" })).toThrow(/SETTLEBACK_LOG_LEVEL/);
    expect(() => loadConfig({ SETTLEBACK_PAYMENT_WRITES: "true" })).toThrow(/SETTLEBACK_PAYMENT_WRITES/);
  });

  it("refuses payment writes in every live environment", () => {
    for (const environment of ["testnet", "mixed", "mainnet"]) {
      expect(() =>
        loadConfig({ SETTLEBACK_ENV: environment, SETTLEBACK_PAYMENT_WRITES: "enabled" }),
      ).toThrow(/not supported/);
    }
  });

  it("allows payment writes against local simulation only when explicitly enabled", () => {
    expect(loadConfig({ SETTLEBACK_PAYMENT_WRITES: "enabled" }).paymentWritesEnabled).toBe(true);
  });
});

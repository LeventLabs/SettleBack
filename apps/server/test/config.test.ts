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
      simulatedProfile: "testnet",
      assessment: { model: "claude-opus-5-5", effort: "medium", maxTokens: 8000, timeoutMs: 45000, apiKey: undefined },
    });
  });

  it("accepts a simulated profile only in the local environment", () => {
    expect(loadConfig({ SETTLEBACK_SIM_PROFILE: "mixed" }).simulatedProfile).toBe("mixed");
    expect(() => loadConfig({ SETTLEBACK_SIM_PROFILE: "local" })).toThrow(/Unknown network profile/);
    expect(() => loadConfig({ SETTLEBACK_ENV: "testnet", SETTLEBACK_SIM_PROFILE: "testnet" })).toThrow(/only to the local environment/);
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

  it("pins the assessment model to a reviewed list and bounds its limits", () => {
    expect(loadConfig({ SETTLEBACK_ASSESSMENT_MODEL: "claude-sonnet-5-5" }).assessment.model).toBe("claude-sonnet-5-5");
    for (const model of ["claude-fable-5-1", "claude-opus-5-5-20260401", "gpt-5"]) {
      expect(() => loadConfig({ SETTLEBACK_ASSESSMENT_MODEL: model }), model).toThrow(/SETTLEBACK_ASSESSMENT_MODEL/);
    }
    expect(() => loadConfig({ SETTLEBACK_ASSESSMENT_EFFORT: "max" })).toThrow(/SETTLEBACK_ASSESSMENT_EFFORT/);
    expect(() => loadConfig({ SETTLEBACK_ASSESSMENT_MAX_TOKENS: "999" })).toThrow(/SETTLEBACK_ASSESSMENT_MAX_TOKENS/);
    expect(() => loadConfig({ SETTLEBACK_ASSESSMENT_TIMEOUT_MS: "45s" })).toThrow(/SETTLEBACK_ASSESSMENT_TIMEOUT_MS/);
    expect(loadConfig({ SETTLEBACK_ASSESSMENT_TIMEOUT_MS: "60000" }).assessment.timeoutMs).toBe(60000);
  });

  it("keeps the API key out of logs, JSON, and error messages", () => {
    const key = "sk-ant-api03-secret-value";
    const config = loadConfig({ ANTHROPIC_API_KEY: key });
    expect(config.assessment.apiKey?.reveal()).toBe(key);
    expect(JSON.stringify(config)).not.toContain(key);
    expect(String(config.assessment.apiKey)).toBe("[redacted]");
    expect(loadConfig({ ANTHROPIC_API_KEY: "" }).assessment.apiKey).toBeUndefined();
    const quoted = `"${key}"`;
    expect(() => loadConfig({ ANTHROPIC_API_KEY: quoted })).toThrow(/ANTHROPIC_API_KEY/);
    try {
      loadConfig({ ANTHROPIC_API_KEY: quoted });
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });
});

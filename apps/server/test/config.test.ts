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
      auth: { webOrigin: "http://localhost:5173", operators: [] },
      demo: undefined,
    });
  });

  it("accepts a simulated profile only in the local environment", () => {
    expect(loadConfig({ SETTLEBACK_SIM_PROFILE: "mixed" }).simulatedProfile).toBe("mixed");
    expect(() => loadConfig({ SETTLEBACK_SIM_PROFILE: "local" })).toThrow(/Unknown network profile/);
    expect(() => loadConfig({ SETTLEBACK_ENV: "testnet", SETTLEBACK_SIM_PROFILE: "testnet" })).toThrow(/only to the local environment/);
  });

  it("uses a separate default database per environment and honors an explicit path", () => {
    expect(loadConfig({ SETTLEBACK_ENV: "testnet", SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz" }).databasePath).toMatch(/\/data\/settleback-testnet\.db$/);
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

  it("configures the registry all at once or not at all, on the chain the environment allows", () => {
    const local = { SETTLEBACK_REGISTRY_RPC_URL: "http://127.0.0.1:8545", SETTLEBACK_REGISTRY_CHAIN_ID: "31337", SETTLEBACK_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };
    expect(loadConfig({}).registry).toBeUndefined();
    expect(loadConfig(local).registry).toMatchObject({ chainId: 31337, confirmations: 1, verifierPrivateKey: undefined });
    expect(() => loadConfig({ SETTLEBACK_REGISTRY_RPC_URL: local.SETTLEBACK_REGISTRY_RPC_URL })).toThrow(/set together/);
    expect(() => loadConfig({ ...local, SETTLEBACK_REGISTRY_CHAIN_ID: "133" })).toThrow(/never HSK Chain/);
    expect(() => loadConfig({ ...local, SETTLEBACK_REGISTRY_ADDRESS: "0x123" })).toThrow(/20-byte/);
    const testnet = {
      SETTLEBACK_ENV: "testnet",
      SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz",
      SETTLEBACK_REGISTRY_RPC_URL: "https://testnet.hsk.xyz",
      SETTLEBACK_REGISTRY_CHAIN_ID: "133",
      SETTLEBACK_REGISTRY_ADDRESS: "0xcC1A01Fe331D65b683d8caB377c49e63Dcb6996C",
    };
    expect(loadConfig(testnet).registry).toMatchObject({ chainId: 133, confirmations: 3 });
    expect(() => loadConfig({ ...testnet, SETTLEBACK_REGISTRY_CHAIN_ID: "177" })).toThrow(/chain 133, not 177/);
    expect(() => loadConfig({ ...testnet, SETTLEBACK_REGISTRY_RPC_URL: "http://testnet.hsk.xyz" })).toThrow(/HTTPS/);
    expect(() => loadConfig({ SETTLEBACK_VERIFIER_PRIVATE_KEY: `0x${"1".repeat(64)}` })).toThrow(/no registry is configured/);
  });

  it("requires a bare HTTPS web origin outside local development", () => {
    expect(loadConfig({ SETTLEBACK_WEB_ORIGIN: "http://127.0.0.1:4173" }).auth.webOrigin).toBe("http://127.0.0.1:4173");
    expect(loadConfig({ SETTLEBACK_ENV: "mainnet", SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz" }).auth.webOrigin).toBe("https://settleback.xyz");
    for (const environment of ["testnet", "mixed", "mainnet"]) {
      expect(() => loadConfig({ SETTLEBACK_ENV: environment }), environment).toThrow(/SETTLEBACK_WEB_ORIGIN is required/);
      expect(() => loadConfig({ SETTLEBACK_ENV: environment, SETTLEBACK_WEB_ORIGIN: "http://localhost:5173" }), environment).toThrow(/must use HTTPS,/);
    }
    for (const origin of ["https://settleback.xyz/", "https://settleback.xyz/app", "https://settleback.xyz?x=1", "settleback.xyz"]) {
      expect(() => loadConfig({ SETTLEBACK_WEB_ORIGIN: origin }), origin).toThrow(/SETTLEBACK_WEB_ORIGIN/);
    }
    expect(() => loadConfig({ SETTLEBACK_WEB_ORIGIN: "http://example.com" })).toThrow(/HTTPS or a loopback HTTP origin/);
  });

  it("takes operators only from configured addresses, normalized and deduplicated", () => {
    const operator = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
    expect(loadConfig({ SETTLEBACK_OPERATORS: ` ${operator}, ${operator.toLowerCase()} ,` }).auth.operators).toEqual([operator.toLowerCase()]);
    expect(() => loadConfig({ SETTLEBACK_OPERATORS: "operator-1" })).toThrow(/SETTLEBACK_OPERATORS/);
  });

  it("runs the fixture demo only locally, in memory, for two distinct accounts", () => {
    const parties = { SETTLEBACK_DEMO_BUYER: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", SETTLEBACK_DEMO_SELLER: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" };
    const demo = loadConfig({ SETTLEBACK_DEMO: "fixtures", ...parties });
    expect(demo.demo).toEqual({ buyer: parties.SETTLEBACK_DEMO_BUYER.toLowerCase(), seller: parties.SETTLEBACK_DEMO_SELLER.toLowerCase() });
    expect(demo.databasePath).toBe(":memory:");
    expect(() => loadConfig({ SETTLEBACK_DEMO: "fixtures" })).toThrow(/SETTLEBACK_DEMO_BUYER/);
    expect(() => loadConfig({ SETTLEBACK_DEMO: "fixtures", ...parties, SETTLEBACK_DEMO_SELLER: parties.SETTLEBACK_DEMO_BUYER.toLowerCase() })).toThrow(/different accounts/);
    expect(() => loadConfig({ SETTLEBACK_DEMO: "fixtures", ...parties, SETTLEBACK_DB_PATH: "/tmp/demo.db" })).toThrow(/in memory/);
    expect(() => loadConfig({ SETTLEBACK_DEMO: "everything", ...parties })).toThrow(/SETTLEBACK_DEMO must be/);
    expect(() => loadConfig({ SETTLEBACK_ENV: "testnet", SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz", SETTLEBACK_DEMO: "fixtures", ...parties })).toThrow(/only to the local environment/);
    expect(() => loadConfig(parties)).toThrow(/apply only with SETTLEBACK_DEMO/);
  });

  it("keeps the verifier key out of JSON and error messages", () => {
    const key = `0x${"ab".repeat(32)}`;
    const config = loadConfig({
      SETTLEBACK_REGISTRY_RPC_URL: "http://127.0.0.1:8545",
      SETTLEBACK_REGISTRY_CHAIN_ID: "31337",
      SETTLEBACK_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      SETTLEBACK_VERIFIER_PRIVATE_KEY: key,
    });
    expect(config.registry?.verifierPrivateKey?.reveal()).toBe(key);
    expect(JSON.stringify(config)).not.toContain(key.slice(2));
    try {
      loadConfig({ SETTLEBACK_REGISTRY_RPC_URL: "http://127.0.0.1:8545", SETTLEBACK_REGISTRY_CHAIN_ID: "31337", SETTLEBACK_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", SETTLEBACK_VERIFIER_PRIVATE_KEY: key.slice(2) });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toMatch(/SETTLEBACK_VERIFIER_PRIVATE_KEY/);
      expect(String(error)).not.toContain(key.slice(2));
    }
  });
});

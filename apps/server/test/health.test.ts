import { describe, expect, it } from "vitest";
import type { RegistryGateway } from "@settleback/adapters";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";

function database(environment: "local" | "mixed" = "local") {
  return openDatabase({ path: ":memory:", environment });
}

describe("GET /api/health", () => {
  it("reports a live environment's profile, chains, and payment-write state", async () => {
    const app = buildApp(loadConfig({ SETTLEBACK_ENV: "mixed", SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz", SETTLEBACK_LOG_LEVEL: "silent" }), { db: database("mixed") });
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        service: "settleback",
        environment: "mixed",
        mode: "live",
        networkProfile: "mixed",
        networkLabel: "mixed-network: testnet payment, mainnet registry",
        paymentChainId: 133,
        registryChainId: 177,
        paymentWrites: "disabled",
        registry: { status: "not configured", integratedRepayment: "unavailable" },
      });
    } finally {
      await app.close();
    }
  });

  it("marks the local environment as a simulation of its configured profile", async () => {
    const app = buildApp(loadConfig({ SETTLEBACK_SIM_PROFILE: "mainnet", SETTLEBACK_LOG_LEVEL: "silent" }), { db: database() });
    try {
      const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
      expect(body).toMatchObject({ environment: "local", mode: "simulated", networkProfile: "mainnet", networkLabel: "local simulation (mainnet)" });
    } finally {
      await app.close();
    }
  });
});

describe("registry status", () => {
  it("shows the connected registry's chain, address, and provenance", async () => {
    const registry = { chainId: 31337, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3", provenance: "SIMULATED" } as unknown as RegistryGateway;
    const app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent" }), { db: database(), registry });
    try {
      const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
      expect(body.registry).toEqual({ status: "connected", chainId: 31337, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3", provenance: "SIMULATED" });
    } finally {
      await app.close();
    }
  });
});

describe("response headers", () => {
  it("carry the mode and network profile on every response, including errors", async () => {
    const app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent" }), { db: database() });
    try {
      for (const url of ["/api/health", "/api/does-not-exist"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.headers["x-settleback-mode"], url).toBe("simulated");
        expect(response.headers["x-settleback-network"], url).toBe("testnet");
        expect(response.headers["cache-control"], url).toBe("no-store");
      }
      expect((await app.inject({ method: "GET", url: "/api/does-not-exist" })).json()).toEqual({ error: { code: "NOT_FOUND", message: "No such route." } });
    } finally {
      await app.close();
    }
  });
});

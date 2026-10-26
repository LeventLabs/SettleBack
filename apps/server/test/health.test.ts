import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

describe("GET /api/health", () => {
  it("reports the environment, its network label, and the payment-write state", async () => {
    const app = buildApp(loadConfig({ SETTLEBACK_ENV: "mixed", SETTLEBACK_LOG_LEVEL: "silent" }));
    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        service: "settleback",
        environment: "mixed",
        networkLabel: "mixed-network: testnet payment, mainnet registry",
        paymentWrites: "disabled",
      });
    } finally {
      await app.close();
    }
  });
});

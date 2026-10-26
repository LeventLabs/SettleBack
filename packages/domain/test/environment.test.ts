import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, isEnvironment, networkLabel, parseEnvironment } from "../src/index.ts";

describe("environment", () => {
  it("accepts every declared environment", () => {
    for (const environment of ENVIRONMENTS) {
      expect(parseEnvironment(environment)).toBe(environment);
    }
  });

  it("rejects unknown and differently cased values", () => {
    expect(() => parseEnvironment("production")).toThrow(/Unknown environment/);
    expect(() => parseEnvironment("Mainnet")).toThrow(/Unknown environment/);
    expect(isEnvironment(undefined)).toBe(false);
  });

  it("labels the mixed profile with both chains so it cannot pass as mainnet settlement", () => {
    expect(networkLabel("mixed")).toBe("mixed-network: testnet payment, mainnet registry");
    expect(networkLabel("local")).toBe("local simulation");
  });
});

import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS,
  describeNetwork,
  isEnvironment,
  networkLabel,
  parseEnvironment,
  parseNetworkProfile,
} from "../src/index.ts";

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
    expect(() => parseNetworkProfile("local")).toThrow(/Unknown network profile/);
  });

  it("labels the mixed profile with both chains so it cannot pass as mainnet settlement", () => {
    expect(networkLabel("mixed")).toBe("mixed-network: testnet payment, mainnet registry");
  });
});

describe("describeNetwork", () => {
  it("runs each live environment on its own profile and chains", () => {
    expect(describeNetwork("testnet")).toMatchObject({ mode: "live", profile: "testnet", paymentChainId: 133, registryChainId: 133 });
    expect(describeNetwork("mixed")).toMatchObject({ mode: "live", profile: "mixed", paymentChainId: 133, registryChainId: 177 });
    expect(describeNetwork("mainnet")).toMatchObject({ mode: "live", profile: "mainnet", paymentChainId: 177, registryChainId: 177 });
  });

  it("ignores a simulated profile outside the local environment", () => {
    expect(describeNetwork("testnet", "mainnet").profile).toBe("testnet");
  });

  it("marks local runs as simulated and names the profile they imitate", () => {
    expect(describeNetwork("local")).toMatchObject({ mode: "simulated", profile: "testnet", label: "local simulation (testnet)" });
    expect(describeNetwork("local", "mixed")).toMatchObject({
      mode: "simulated",
      registryChainId: 177,
      label: "local simulation (mixed-network: testnet payment, mainnet registry)",
    });
  });
});

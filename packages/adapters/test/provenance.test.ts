import { describe, expect, it } from "vitest";
import type { Address } from "@settleback/domain";
import {
  ProvenanceViolationError,
  assertProvenanceAllowed,
  createSimulatedAdapters,
  signSimulatedPayload,
  type ExecutionPayload,
} from "../src/index.ts";

const VERIFIER = "0x00000000000000000000000000000000000000f0" as Address;

describe("simulated artifacts cannot enter live environments", () => {
  it("refuses to build simulated adapters outside the local environment", () => {
    for (const environment of ["testnet", "mixed", "mainnet"] as const) {
      expect(() => createSimulatedAdapters({ environment, verifier: VERIFIER, webhookSecret: "s" }), environment).toThrow(
        ProvenanceViolationError,
      );
    }
  });

  it("accepts simulated artifacts only locally and live artifacts only in live environments", () => {
    expect(() => assertProvenanceAllowed("local", "SIMULATED")).not.toThrow();
    expect(() => assertProvenanceAllowed("local", "LIVE")).toThrow(ProvenanceViolationError);
    for (const environment of ["testnet", "mixed", "mainnet"] as const) {
      expect(() => assertProvenanceAllowed(environment, "SIMULATED"), environment).toThrow(ProvenanceViolationError);
      expect(() => assertProvenanceAllowed(environment, "LIVE"), environment).not.toThrow();
    }
  });

  it("labels everything the simulator produces", async () => {
    const sim = createSimulatedAdapters({ environment: "local", verifier: VERIFIER, webhookSecret: "s" });
    expect(sim.provenance).toBe("SIMULATED");
    expect(sim.rail.provenance).toBe("SIMULATED");
    expect(sim.registry.provenance).toBe("SIMULATED");
    expect(sim.network.mode).toBe("simulated");
  });

  it("refuses to sign or submit a payload that is not marked simulated", async () => {
    const sim = createSimulatedAdapters({ environment: "local", verifier: VERIFIER, webhookSecret: "s" });
    const live: ExecutionPayload = {
      provenance: "LIVE",
      kind: "payment-mandate",
      cartMandateId: "cart-1",
      cartSha256: "a".repeat(64),
      paymentRequestId: "pr-1",
      payer: "0x00000000000000000000000000000000000000b1",
      payee: "0x00000000000000000000000000000000000000a1",
      chainId: 133,
      token: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6",
      amountBaseUnits: "1000000",
      nonce: "n",
    };
    expect(() => signSimulatedPayload(live)).toThrow(/Only simulated payloads/);
    await expect(sim.rail.submit({ payload: live, signature: "x" })).rejects.toMatchObject({ code: "PROVENANCE" });
  });
});

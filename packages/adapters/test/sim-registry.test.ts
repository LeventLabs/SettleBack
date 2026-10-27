import { beforeEach, describe, expect, it } from "vitest";
import type { Address } from "@settleback/domain";
import {
  RailTimeoutError,
  RegistryRevertError,
  createSimulatedAdapters,
  type RegisterCaseInput,
  type SimulatedAdapters,
} from "../src/index.ts";

const BUYER = "0x00000000000000000000000000000000000000b1" as Address;
const SELLER = "0x00000000000000000000000000000000000000a1" as Address;
const VERIFIER = "0x00000000000000000000000000000000000000f0" as Address;
const STRANGER = "0x00000000000000000000000000000000000000c3" as Address;
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const CASE_KEY = `0x${"1".repeat(64)}`;
const ORIGINAL_TX = `0x${"a".repeat(64)}`;
const REPAY_TX = `0x${"b".repeat(64)}`;
const SHA = "c".repeat(64);

let sim: SimulatedAdapters;

beforeEach(() => {
  sim = createSimulatedAdapters({ environment: "local", verifier: VERIFIER, webhookSecret: "s" });
});

function caseInput(overrides: Partial<RegisterCaseInput> = {}): RegisterCaseInput {
  return {
    caseKey: CASE_KEY,
    buyer: BUYER,
    seller: SELLER,
    token: TOKEN,
    amountBaseUnits: "1000000",
    originalRef: { chainId: 133, txHash: ORIGINAL_TX },
    policySha256: SHA,
    actionDigest: SHA,
    evidenceDigest: SHA,
    actionKind: "REPAY",
    deadline: "2026-10-30T12:00:00Z",
    ...overrides,
  };
}

async function reverts(promise: Promise<unknown>, reason: RegExp): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(RegistryRevertError);
  await expect(promise).rejects.toThrow(reason);
}

describe("simulated registry: repayment lifecycle", () => {
  it("registers, reserves by the seller, and completes once by the verifier", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput());
    await sim.registry.reserveRepayment(SELLER, CASE_KEY);
    const tx = await sim.registry.completeRepayment(VERIFIER, CASE_KEY, { chainId: 133, txHash: REPAY_TX }, SHA);
    const record = await sim.registry.readCase(CASE_KEY);
    expect(record).toMatchObject({ state: "REPAID", repaymentRef: { chainId: 133, txHash: REPAY_TX }, outcomeSha256: SHA });
    expect(await sim.registry.getReceipt(tx)).toMatchObject({ confirmations: 0 });
    await reverts(sim.registry.completeRepayment(VERIFIER, CASE_KEY, { chainId: 133, txHash: `0x${"d".repeat(64)}` }, SHA), /case is REPAID/);
  });

  it("lets only the verifier register and complete, and only the recorded seller reserve", async () => {
    await reverts(sim.registry.registerCase(STRANGER, caseInput()), /only the verifier/);
    await sim.registry.registerCase(VERIFIER, caseInput());
    for (const caller of [BUYER, VERIFIER, STRANGER]) {
      await reverts(sim.registry.reserveRepayment(caller, CASE_KEY), /only the recorded seller/);
    }
    await sim.registry.reserveRepayment(SELLER, CASE_KEY);
    await reverts(sim.registry.completeRepayment(SELLER, CASE_KEY, { chainId: 133, txHash: REPAY_TX }, SHA), /only the verifier/);
  });

  it("refuses a second registration, a reused original payment, and a repayment equal to the original", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput());
    await reverts(sim.registry.registerCase(VERIFIER, caseInput()), /already registered/);
    await reverts(sim.registry.registerCase(VERIFIER, caseInput({ caseKey: `0x${"2".repeat(64)}` })), /original payment already bound/);
    await sim.registry.reserveRepayment(SELLER, CASE_KEY);
    await reverts(sim.registry.completeRepayment(VERIFIER, CASE_KEY, { chainId: 133, txHash: ORIGINAL_TX }, SHA), /already used/);
  });

  it("treats the same hash on another chain as a different reference", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput());
    await sim.registry.registerCase(VERIFIER, caseInput({ caseKey: `0x${"2".repeat(64)}`, originalRef: { chainId: 177, txHash: ORIGINAL_TX } }));
  });

  it("refuses reservation after the deadline but still records a completion after it", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput());
    await sim.registry.reserveRepayment(SELLER, CASE_KEY);
    sim.clock.advance(3 * 60 * 60 * 1000);
    await sim.registry.completeRepayment(VERIFIER, CASE_KEY, { chainId: 133, txHash: REPAY_TX }, SHA);

    await sim.registry.registerCase(VERIFIER, caseInput({ caseKey: `0x${"3".repeat(64)}`, originalRef: { chainId: 133, txHash: `0x${"e".repeat(64)}` }, deadline: "2026-10-30T14:00:00Z" }));
    sim.clock.advance(2 * 60 * 60 * 1000);
    await reverts(sim.registry.reserveRepayment(SELLER, `0x${"3".repeat(64)}`), /deadline passed/);
  });

  it("refuses invalid registrations", async () => {
    await reverts(sim.registry.registerCase(VERIFIER, caseInput({ amountBaseUnits: "0" })), /amount must be positive/);
    await reverts(sim.registry.registerCase(VERIFIER, caseInput({ seller: BUYER })), /buyer equals seller/);
    await reverts(sim.registry.registerCase(VERIFIER, caseInput({ deadline: "2026-10-30T09:00:00Z" })), /deadline must be in the future/);
  });
});

describe("simulated registry: retrieval lifecycle", () => {
  it("is reserved and completed by the verifier only, and cannot take the repayment path", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput({ actionKind: "RETRIEVE" }));
    await reverts(sim.registry.reserveRepayment(SELLER, CASE_KEY), /not a repayment/);
    await reverts(sim.registry.reserveRetrieval(SELLER, CASE_KEY), /only the verifier/);
    await sim.registry.reserveRetrieval(VERIFIER, CASE_KEY);
    await sim.registry.completeRetrieval(VERIFIER, CASE_KEY, SHA, SHA);
    expect((await sim.registry.readCase(CASE_KEY))?.state).toBe("RECOVERED");
  });
});

describe("simulated registry: lost receipts", () => {
  it("applies the write even when the response is lost, so callers reconcile by reading state", async () => {
    await sim.registry.registerCase(VERIFIER, caseInput());
    sim.registry.injectFault({ kind: "receipt-lost" });
    await expect(sim.registry.reserveRepayment(SELLER, CASE_KEY)).rejects.toBeInstanceOf(RailTimeoutError);
    expect((await sim.registry.readCase(CASE_KEY))?.state).toBe("RESERVED_REPAY");
    await reverts(sim.registry.reserveRepayment(SELLER, CASE_KEY), /case is RESERVED_REPAY/);
  });
});

describe("network profiles", () => {
  it("places the registry on mainnet and payments on testnet in the mixed profile, with chain-qualified references", async () => {
    const mixed = createSimulatedAdapters({ environment: "local", profile: "mixed", verifier: VERIFIER, webhookSecret: "s" });
    expect(mixed.registry.chainId).toBe(177);
    expect(mixed.paymentChain.chainId).toBe(133);
    expect(mixed.network.label).toBe("local simulation (mixed-network: testnet payment, mainnet registry)");
    await mixed.registry.registerCase(VERIFIER, caseInput());
    expect((await mixed.registry.readCase(CASE_KEY))?.originalRef).toEqual({ chainId: 133, txHash: ORIGINAL_TX });
  });

  it("uses one chain for both in the testnet and mainnet profiles", () => {
    for (const [profile, chainId] of [["testnet", 133], ["mainnet", 177]] as const) {
      const adapters = createSimulatedAdapters({ environment: "local", profile, verifier: VERIFIER, webhookSecret: "s" });
      expect(adapters.registryChain).toBe(adapters.paymentChain);
      expect(adapters.registry.chainId).toBe(chainId);
    }
  });
});

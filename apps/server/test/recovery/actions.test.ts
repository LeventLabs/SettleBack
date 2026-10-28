import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VERIFIED_ARTIFACT_LEAD_RULES, eligibilityRulesSha256, registryCaseKey, type Address } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { getRecoveryAction, getRecoveryActionForCase } from "../../src/db/actions.ts";
import { getCase } from "../../src/db/cases.ts";
import { ingestEvidence } from "../../src/db/evidence.ts";
import { assessCase } from "../../src/recovery/assessment.ts";
import { confirmRepaymentReservation, prepareRecovery, strandRecovery, type PrepareRecoveryInput } from "../../src/recovery/actions.ts";
import { BUYER, NOW, SELLER, TOKEN, memoryDatabase } from "../db/helpers.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";
import { ScriptedProvider, TERMS, lineWith, registerFixturePolicies, reply, setupFixtureCase } from "./helpers.ts";

const PORT = 24_000 + (process.pid % 5_000);
const clock = () => new Date();
let chain: LocalChain;
let policyChain: LocalChain;
let db: DatabaseSync;

beforeAll(async () => {
  [chain, policyChain] = await Promise.all([startLocalChain(PORT), startLocalChain(PORT + 1)]);
}, 120_000);

afterAll(() => {
  chain?.stop();
  policyChain?.stop();
});

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
});

afterEach(() => {
  db.close();
});

function input(caseId: string, overrides: Partial<PrepareRecoveryInput> = {}): PrepareRecoveryInput {
  return { caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock, ...overrides };
}

describe("retrieval", () => {
  it("prepares a rules-resolved retrieval, registers it with the proposal digest, and reserves it", async () => {
    const setup = await setupFixtureCase(db, "lost-response");
    const prepared = await prepareRecovery(db, input(setup.caseId));
    const { action } = prepared;
    expect(action).toMatchObject({ action: "RETRIEVE", state: "RESERVED", authorizationMode: null, approvalTx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(prepared.sellerCall).toBeNull();
    expect(action.proposal).toMatchObject({ basis: "RULES_BASELINE", autoEligible: false, transfer: null, artifactSha256: setup.composed.serviceRun?.status.artifactSha256 });
    expect(getCase(db, setup.caseId)?.status).toBe("RESERVED");
    const onChain = await chain.registry.readCase(action.proposal.caseKey);
    expect(onChain).toMatchObject({
      state: "RESERVED_RETRIEVE",
      actionKind: "RETRIEVE",
      actionDigest: action.actionSha256,
      evidenceDigest: action.evidenceSha256,
      autoEligible: false,
      buyer: BUYER,
      seller: SELLER,
      amountBaseUnits: "1000000",
    });
    expect(action.proposal.caseKey).toBe(registryCaseKey(setup.caseId, { chainId: chain.registry.chainId, address: chain.registry.address }));
  });

  it("prepares a retrieval from a verified artifact lead when the rules abstain", async () => {
    const setup = await setupFixtureCase(db, "hidden-completion");
    const worker = setup.item("worker-log");
    const digest = setup.composed.serviceRun?.store.list()[0]?.sha256 ?? "";
    const provider = new ScriptedProvider(() =>
      reply({
        findings: [{ statement: "Stored after the timeout.", support: "supported", citations: [{ evidenceId: worker.id, quote: lineWith(worker.content, "artifact stored") }] }],
        suggestedAction: "RETRIEVE",
        artifactSha256: digest,
        missingEvidence: [],
        explanation: "Retrieve it.",
      }),
    );
    await assessCase(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, provider, lookup: setup.lookup, terms: TERMS, timeoutMs: 45_000 });
    const { action } = await prepareRecovery(db, input(setup.caseId));
    expect(action.proposal).toMatchObject({ basis: "VERIFIED_ARTIFACT_LEAD", artifactSha256: digest, eligibilityRulesSha256: sha256Hex(VERIFIED_ARTIFACT_LEAD_RULES) });
    expect(action.state).toBe("RESERVED");
  });
});

describe("per-case repayment", () => {
  it("binds the exact repayment, and only the seller's own confirmed reservation approves it", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const prepared = await prepareRecovery(db, input(setup.caseId));
    const { action } = prepared;
    expect(action).toMatchObject({ action: "REPAY", state: "PREPARED", authorizationMode: "PER_CASE" });
    expect(action.proposal.transfer).toEqual({ payer: SELLER, payee: BUYER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" });
    expect(prepared.policyGaps).toEqual(["the seller has no active standing policy for this chain and token"]);
    expect(prepared.sellerCall?.to).toBe(chain.registry.address);
    expect(await chain.registry.readCase(action.proposal.caseKey)).toMatchObject({ state: "OPEN", autoEligible: true, actionDigest: action.actionSha256 });
    const sellerCall = prepared.sellerCall;
    if (sellerCall === null) throw new Error("expected a seller call");
    const confirm = (txHash: string, now = clock) => confirmRepaymentReservation(db, { actionId: action.id, txHash, registry: chain.registry, now });

    // The buyer and an operator cannot make the seller's approval: their transactions revert or do not count.
    const byBuyer = await chain.sendAs(BUYER as Address, sellerCall, 200_000n);
    await chain.mined(byBuyer);
    expect(await confirm(byBuyer)).toMatchObject({ status: "REJECTED" });
    const operator = chain.addressOf(chain.keys[7] as Hex);
    const byOperator = await chain.sendAs(operator, sellerCall, 200_000n);
    await chain.mined(byOperator);
    expect(await confirm(byOperator)).toMatchObject({ status: "REJECTED" });
    const unrelated = await chain.sendAs(SELLER as Address, { ...sellerCall, to: operator, data: "0x" });
    await chain.mined(unrelated);
    expect(await confirm(unrelated)).toMatchObject({ status: "REJECTED", reason: expect.stringMatching(/not a call to this registry/) });
    expect(getRecoveryAction(db, action.id)?.state).toBe("PREPARED");

    // The seller's reservation stays pending until mined, then is confirmed and recorded.
    await chain.rpc("evm_setAutomine", [false]);
    let bySeller: Hex;
    try {
      bySeller = await chain.sendAs(SELLER as Address, sellerCall);
      expect(await confirm(bySeller)).toEqual({ status: "PENDING", reason: "the transaction is not mined yet" });
      await chain.rpc("evm_mine");
    } finally {
      await chain.rpc("evm_setAutomine", [true]);
    }
    const confirmed = await confirm(bySeller);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", executable: true, reasons: [] });
    expect(getRecoveryAction(db, action.id)).toMatchObject({ state: "RESERVED", approvalTx: bySeller.toLowerCase() });
    expect(getCase(db, setup.caseId)?.status).toBe("RESERVED");
    expect(await confirm(bySeller)).toMatchObject({ status: "CONFIRMED" });
    expect(await confirm(byBuyer)).toMatchObject({ status: "REJECTED", reason: "the action is already RESERVED" });
  });

  it("records a reservation made after the evidence changed, but never makes it executable or resets it", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const prepared = await prepareRecovery(db, input(setup.caseId));
    ingestEvidence(db, {
      operationId: setup.operationId,
      submittedBy: "buyer",
      source: "buyer-claim",
      mediaType: "text/plain",
      sourceEventId: "late-claim",
      content: "One more thing.",
      observedAt: null,
      now: NOW,
    });
    expect(getCase(db, setup.caseId)?.status).toBe("OPEN");
    const sellerCall = prepared.sellerCall;
    if (sellerCall === null) throw new Error("expected a seller call");
    const hash = await chain.sendAs(SELLER as Address, sellerCall);
    await chain.mined(hash);
    const outcome = await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: hash, registry: chain.registry, now: clock });
    expect(outcome).toMatchObject({ status: "CONFIRMED", executable: false, reasons: [expect.stringMatching(/^STALE_EVIDENCE/)] });
    expect(getRecoveryAction(db, prepared.action.id)?.state).toBe("RESERVED");
    expect(getCase(db, setup.caseId)?.status).toBe("OPEN");

    const stranded = strandRecovery(db, { actionId: prepared.action.id, operator: "ops@settleback", reason: "evidence changed after the seller's reservation", now: clock });
    expect(stranded.state).toBe("STRANDED");
    await expect(prepareRecovery(db, input(setup.caseId))).rejects.toMatchObject({ code: "ACTION_EXISTS" });
    // The reservation and its exposure stay on chain.
    expect((await chain.registry.readCase(prepared.action.proposal.caseKey))?.state).toBe("RESERVED_REPAY");
    expect(BigInt((await chain.registry.readBudget(SELLER as Address, 133, TOKEN)).outstandingBaseUnits)).toBeGreaterThanOrEqual(1_000_000n);
  });

  it("does not make an expired reservation executable", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const prepared = await prepareRecovery(db, input(setup.caseId, { deadlineMs: 60_000 }));
    const sellerCall = prepared.sellerCall;
    if (sellerCall === null) throw new Error("expected a seller call");
    const hash = await chain.sendAs(SELLER as Address, sellerCall);
    await chain.mined(hash);
    const later = () => new Date(Date.now() + 120_000);
    expect(await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: hash, registry: chain.registry, now: later })).toMatchObject({
      status: "CONFIRMED",
      executable: false,
      reasons: [expect.stringMatching(/^EXPIRED/)],
    });
    expect(getCase(db, setup.caseId)?.status).toBe("ACTION_PREPARED");
  });
});

describe("standing-policy repayment", () => {
  async function activate(maxPerCase: string, delegate: Address): Promise<void> {
    const block = (await policyChain.rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const now = Number(BigInt(block.timestamp));
    const call = policyChain.registry.activatePolicyCall({
      delegate,
      signer: policyChain.addressOf(policyChain.keys[6] as Hex),
      token: TOKEN,
      paymentChainId: 133,
      servicePolicySha256: TERMS.get("extraction-delivery-v1")?.sha256 ?? "",
      eligibilityRulesSha256: eligibilityRulesSha256("RULES_BASELINE"),
      maxPerCaseBaseUnits: maxPerCase,
      dailyLimitBaseUnits: "10000000",
      validFrom: new Date((now - 60) * 1000).toISOString(),
      validUntil: new Date((now + 7 * 86_400) * 1000).toISOString(),
    });
    await policyChain.mined(await policyChain.sendAs(SELLER as Address, call));
  }

  it("routes an eligible repayment to the seller's delegate and accepts only the delegate's reservation", async () => {
    const delegate = policyChain.addressOf(policyChain.keys[4] as Hex);
    await activate("2000000", delegate);
    const setup = await setupFixtureCase(db, "refundable-failure-standing-policy");
    const prepared = await prepareRecovery(db, input(setup.caseId, { registry: policyChain.registry }));
    const authorization = prepared.action.proposal.authorization;
    expect(authorization).toMatchObject({ mode: "STANDING_POLICY", version: expect.any(Number) });
    expect(prepared.action).toMatchObject({ authorizationMode: "STANDING_POLICY", authorizationVersion: authorization?.mode === "STANDING_POLICY" ? authorization.version : -1 });
    expect(prepared.sellerCall).toBeNull();
    const delegateCall = prepared.delegateCall;
    if (delegateCall === null) throw new Error("expected a delegate call");

    const bySeller = await policyChain.sendAs(SELLER as Address, delegateCall, 300_000n);
    await policyChain.mined(bySeller);
    const confirm = (txHash: string) => confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash, registry: policyChain.registry, now: clock });
    expect(await confirm(bySeller)).toMatchObject({ status: "REJECTED" });

    const byDelegate = await policyChain.sendAs(delegate, delegateCall);
    await policyChain.mined(byDelegate);
    expect(await confirm(byDelegate)).toMatchObject({ status: "CONFIRMED", executable: true });
    expect(getRecoveryAction(db, prepared.action.id)).toMatchObject({ state: "RESERVED", policyTx: byDelegate.toLowerCase(), approvalTx: null });
  });

  it("falls back to an explicit per-case approval when the policy does not cover the amount", async () => {
    await activate("500000", policyChain.addressOf(policyChain.keys[4] as Hex));
    const setup = await setupFixtureCase(db, "refundable-failure-standing-policy");
    const prepared = await prepareRecovery(db, input(setup.caseId, { registry: policyChain.registry }));
    expect(prepared.action.authorizationMode).toBe("PER_CASE");
    expect(prepared.policyGaps).toEqual(["the amount exceeds the per-case limit"]);
    expect(prepared.sellerCall).not.toBeNull();
  });
});

describe("refusals and integrity", () => {
  it("refuses without a registry, from the wrong requester, for ineligible cases, and a second time", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    await expect(prepareRecovery(db, input(setup.caseId, { registry: undefined }))).rejects.toMatchObject({ code: "REGISTRY_REQUIRED" });
    await expect(prepareRecovery(db, input(setup.caseId, { requestedBy: { role: "seller", identity: BUYER } }))).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    const asBuyer = { role: "buyer", identity: BUYER } as unknown as PrepareRecoveryInput["requestedBy"];
    await expect(prepareRecovery(db, input(setup.caseId, { requestedBy: asBuyer }))).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    await prepareRecovery(db, input(setup.caseId, { requestedBy: { role: "operator", identity: "ops@settleback" } }));
    await expect(prepareRecovery(db, input(setup.caseId))).rejects.toMatchObject({ code: "ACTION_EXISTS" });

    for (const fixtureId of ["billable-failure", "conflicting-evidence"]) {
      const other = await setupFixtureCase(db, fixtureId);
      await expect(prepareRecovery(db, input(other.caseId)), fixtureId).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    }
  });

  it("refuses to proceed when the registry already holds the case key with other terms", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const caseKey = registryCaseKey(setup.caseId, { chainId: chain.registry.chainId, address: chain.registry.address });
    const block = (await chain.rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    await chain.registry.registerCase({
      caseKey,
      buyer: BUYER as Address,
      seller: SELLER as Address,
      token: TOKEN as Address,
      amountBaseUnits: "999999",
      originalRef: { chainId: 133, txHash: `0x${"9".repeat(64)}` },
      policySha256: "a".repeat(64),
      eligibilityRulesSha256: "b".repeat(64),
      autoEligible: true,
      actionDigest: "c".repeat(64),
      evidenceDigest: "d".repeat(64),
      actionKind: "REPAY",
      deadline: new Date((Number(BigInt(block.timestamp)) + 86_400) * 1000).toISOString(),
    });
    await expect(prepareRecovery(db, input(setup.caseId))).rejects.toMatchObject({ code: "REGISTRY_TERMS_MISMATCH" });

    // Even if the seller reserves that registry case, it does not approve this proposal.
    const action = getRecoveryActionForCase(db, setup.caseId);
    if (action === undefined) throw new Error("expected the prepared action");
    const hash = await chain.sendAs(SELLER as Address, chain.registry.reserveRepaymentCall(caseKey));
    await chain.mined(hash);
    expect(await confirmRepaymentReservation(db, { actionId: action.id, txHash: hash, registry: chain.registry, now: clock })).toMatchObject({
      status: "REJECTED",
      reason: "the registry case has a different amount",
    });
    expect(getRecoveryAction(db, action.id)?.state).toBe("PREPARED");
  });

  it("refuses to prepare from a snapshot that changed while the registry was being read", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const registry = Object.create(chain.registry) as typeof chain.registry;
    registry.activePolicyId = async (...args) => {
      ingestEvidence(db, {
        operationId: setup.operationId,
        submittedBy: "buyer",
        source: "buyer-claim",
        mediaType: "text/plain",
        sourceEventId: "concurrent-claim",
        content: "Arrived meanwhile.",
        observedAt: null,
        now: NOW,
      });
      return chain.registry.activePolicyId(...args);
    };
    await expect(prepareRecovery(db, input(setup.caseId, { registry }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(getRecoveryActionForCase(db, setup.caseId)).toBeUndefined();
  });

  it("detects a recovery action whose columns no longer match its proposal", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const { action } = await prepareRecovery(db, input(setup.caseId));
    // Only possible by bypassing the schema's own guards.
    db.exec("DROP TRIGGER recovery_actions_fixed_intent");
    db.prepare("UPDATE recovery_actions SET amount_base_units = '2000000', revision = revision + 1 WHERE id = ?").run(action.id);
    expect(() => getRecoveryAction(db, action.id)).toThrow(/columns differ from its proposal/);
  });
});

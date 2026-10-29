import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSimulatedAdapters, signSimulatedPayload, type GatewayFault, type PaymentRail, type RegistryGateway, type SimulatedAdapters } from "@settleback/adapters";
import { REPAYMENT_EVIDENCE_SCHEMA, eligibilityRulesSha256, repaymentEvidenceSha256, type Address } from "@settleback/domain";
import { getRecoveryAction } from "../../src/db/actions.ts";
import { getCase, readCaseEvidence } from "../../src/db/cases.ts";
import { immediateTransaction } from "../../src/db/database.ts";
import { ingestEvidence } from "../../src/db/evidence.ts";
import { getPaymentAttempt } from "../../src/db/payments.ts";
import { insertProofAllocation } from "../../src/db/proofs.ts";
import type { PaymentSigner } from "../../src/payments/execution.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { confirmRepaymentReservation, moveCase, prepareRecovery } from "../../src/recovery/actions.ts";
import { completeRepayment, liveAttempt, repaymentEvidence, requestRepayment, type RepaymentPayments } from "../../src/recovery/repayment.ts";
import { BUYER, SELLER, TOKEN, memoryDatabase } from "../db/helpers.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";
import { TERMS, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup } from "./helpers.ts";

const clock = () => new Date();
let chain: LocalChain;
let db: DatabaseSync;
let sim: SimulatedAdapters;

beforeAll(async () => {
  chain = await startLocalChain();
}, 120_000);

afterAll(() => chain?.stop());

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
  sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret", start: new Date().toISOString() });
});

afterEach(() => {
  db.close();
});

/** The simulated signer and rail, counting every signature and submission they make. */
function payments(overrides: Partial<RepaymentPayments> = {}): RepaymentPayments & { calls: { sign: number; submit: number } } {
  const calls = { sign: 0, submit: 0 };
  const signer: PaymentSigner = {
    provenance: "SIMULATED",
    sign: async (payload) => {
      calls.sign += 1;
      return signSimulatedPayload(payload);
    },
  };
  const rail: PaymentRail = {
    provenance: "SIMULATED",
    prepare: (input) => sim.rail.prepare(input),
    submit: async (signed) => {
      calls.submit += 1;
      return sim.rail.submit(signed);
    },
    observe: (paymentRequestId) => sim.rail.observe(paymentRequestId),
  };
  return { calls, rail, signer, merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey }, deploymentId: "local-registry", coin: "USDC", maxFeeBaseUnits: "100000", ...overrides };
}

/** A per-case repayment the seller reserved from its own account, confirmed from the chain. */
async function reserved(fixture = "refundable-failure-per-case"): Promise<{ setup: FixtureCaseSetup; actionId: string; caseKey: string }> {
  const setup = await setupFixtureCase(db, fixture);
  const prepared = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock });
  if (prepared.sellerCall === null) throw new Error("expected a seller call");
  const hash = await chain.sendAs(SELLER as Address, prepared.sellerCall);
  await chain.mined(hash);
  expect(await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: hash, registry: chain.registry, now: clock })).toMatchObject({ status: "CONFIRMED", executable: true });
  return { setup, actionId: prepared.action.id, caseKey: prepared.action.proposal.caseKey };
}

function request(setup: FixtureCaseSetup, using: RepaymentPayments, overrides: Partial<Parameters<typeof requestRepayment>[1]> = {}) {
  return requestRepayment(db, { caseId: setup.caseId, requestedBy: SELLER, registry: chain.registry, payments: using, now: clock, ...overrides });
}

function pass(registry: RegistryGateway | undefined = chain.registry) {
  return reconcilePending({ db, rail: sim.rail, registry, now: clock, requiredLevel: "FINAL" });
}

function ticks(count: number): void {
  for (let index = 0; index < count; index += 1) sim.gateway.tick();
}

function events(actionId: string): string[] {
  return db
    .prepare("SELECT event_type FROM events WHERE entity_type = 'recovery_action' AND entity_id = ? ORDER BY seq")
    .all(actionId)
    .map((row) => String(row.event_type));
}

function repaymentAttempts(operationId: string): number {
  return Number(db.prepare("SELECT count(*) AS n FROM payment_attempts WHERE operation_id = ? AND purpose = 'REPAYMENT'").get(operationId)?.n);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return "accepted";
}

/** The registry, except that completing a repayment behaves as given. */
function withCompletion(completeRepaymentImpl: RegistryGateway["completeRepayment"]): RegistryGateway {
  const registry = Object.create(chain.registry) as RegistryGateway;
  registry.completeRepayment = completeRepaymentImpl;
  return registry;
}

describe("per-case repayment", () => {
  it("pays the exact separate transfer once and closes only after verification and the registry record", async () => {
    const { setup, actionId, caseKey } = await reserved();
    const using = payments();
    const requested = await request(setup, using);
    expect(requested).toMatchObject({ status: "SUBMITTED", action: { state: "EXECUTION_REQUESTED" }, attempt: { purpose: "REPAYMENT", state: "SIGNING_REQUESTED", payer: SELLER, payee: BUYER, amountBaseUnits: "1000000" } });
    expect(getCase(db, setup.caseId)?.status).toBe("EXECUTION_REQUESTED");

    // Not final yet: nothing is bound or recorded.
    ticks(4);
    await pass();
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
    expect((await chain.registry.readCase(caseKey))?.state).toBe("RESERVED_REPAY");

    ticks(2);
    const run = await pass();
    expect(run.outcomes).toEqual([{ actionId, result: expect.objectContaining({ status: "RECORDED" }) }]);
    const action = getRecoveryAction(db, actionId);
    expect(action?.state).toBe("COMPLETED");
    expect(action?.registryTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(getCase(db, setup.caseId)?.status).toBe("REPAID");

    const attempt = getPaymentAttempt(db, requested.attempt?.id ?? "");
    if (attempt?.txHash === null || attempt === undefined || action === undefined) throw new Error("expected a verified repayment");
    expect(attempt.state).toBe("VERIFIED");
    const transfer = sim.paymentChain.getTransfer(attempt.txHash);
    expect(transfer).toMatchObject({ from: SELLER, to: BUYER, amountBaseUnits: "1000000", status: "success" });
    // The commitment is recomputed here from the facts themselves, not through the server's mapping.
    const commitment = repaymentEvidenceSha256({
      schema: REPAYMENT_EVIDENCE_SCHEMA,
      caseKey,
      actionSha256: action.actionSha256,
      attemptId: attempt.id,
      payer: SELLER as Address,
      payee: BUYER as Address,
      chainId: 133,
      token: TOKEN as Address,
      amountBaseUnits: "1000000",
      cartSha256: attempt.cartSha256 ?? "",
      paymentMandateSha256: attempt.paymentMandateSha256 ?? "",
      flowId: attempt.flowId ?? "",
      txHash: attempt.txHash,
    });
    expect(repaymentEvidence(action, attempt, attempt.txHash)).toBe(commitment);
    expect(await chain.registry.readCase(caseKey)).toMatchObject({ state: "REPAID", outcomeRef: attempt.txHash, outcomeCommitment: commitment });
    expect(db.prepare("SELECT proof_type, action_id, proof_id FROM proof_allocations WHERE action_id = ?").all(actionId)).toEqual([{ proof_type: "REPAYMENT", action_id: actionId, proof_id: attempt.txHash }]);
    expect(events(actionId).slice(-5)).toEqual(["RECOVERY_REPAYMENT_REQUESTED", "PROOF_ALLOCATED", "RECOVERY_REPAYMENT_VERIFIED", "RECOVERY_OUTCOME_PENDING", "RECOVERY_REPAYMENT_RECORDED"]);
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
    expect((await pass()).outcomes).toEqual([]);
  });

  it("pays once however often the seller asks, concurrently or later", async () => {
    const { setup, actionId } = await reserved();
    const using = payments();
    const results = await Promise.all(Array.from({ length: 20 }, () => request(setup, using)));
    expect(results.filter((result) => result.status === "SUBMITTED")).toHaveLength(1);
    expect(results.filter((result) => result.status === "ALREADY_REQUESTED")).toHaveLength(19);
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
    expect(repaymentAttempts(setup.operationId)).toBe(1);
    expect(sim.gateway.orderCount()).toBe(1);

    ticks(6);
    await pass();
    expect(getRecoveryAction(db, actionId)?.state).toBe("COMPLETED");
    expect(await request(setup, using)).toMatchObject({ status: "ALREADY_REQUESTED", action: { state: "COMPLETED" } });
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
  });

  it("keeps a verified transfer RECORD_PENDING while the registry write fails, then records it without paying again", async () => {
    const { setup, actionId, caseKey } = await reserved();
    const using = payments();
    await request(setup, using);
    ticks(6);
    const failing = withCompletion(async () => Promise.reject(new Error("rpc unavailable")));
    const first = await pass(failing);
    expect(first.outcomes).toEqual([{ actionId, result: expect.objectContaining({ status: "PENDING", reason: "rpc unavailable" }) }]);
    expect(getRecoveryAction(db, actionId)?.state).toBe("RECORD_PENDING");
    expect(getCase(db, setup.caseId)?.status).toBe("RECORD_PENDING");
    expect((await chain.registry.readCase(caseKey))?.state).toBe("RESERVED_REPAY");
    expect(await request(setup, using)).toMatchObject({ status: "ALREADY_REQUESTED", action: { state: "RECORD_PENDING" } });

    expect((await pass()).outcomes).toEqual([{ actionId, result: expect.objectContaining({ status: "RECORDED" }) }]);
    expect(getCase(db, setup.caseId)?.status).toBe("REPAID");
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
  });

  it("completes from the chain when the registry receipt is lost", async () => {
    const { setup, actionId, caseKey } = await reserved();
    await request(setup, payments());
    ticks(6);
    const lostReceipt = withCompletion(async (key, tx, evidence) => {
      await chain.registry.completeRepayment(key, tx, evidence);
      throw new (await import("@settleback/adapters")).RegistryOutcomeUnknownError(`0x${"9".repeat(64)}`, "receipt lost");
    });
    expect((await pass(lostReceipt)).outcomes[0]?.result?.status).toBe("RECORDED");
    expect(getRecoveryAction(db, actionId)).toMatchObject({ state: "COMPLETED", registryTx: null });
    expect((await chain.registry.readCase(caseKey))?.state).toBe("REPAID");
  });

  it("does not close on a transfer that does not verify", async () => {
    const { setup, actionId, caseKey } = await reserved();
    const using = payments();
    const requested = await request(setup, using);
    sim.gateway.injectFault(requested.attempt?.paymentRequestId ?? "", { kind: "wrong-receipt", field: "amount" } satisfies GatewayFault);
    ticks(8);
    const run = await pass();
    expect(run.attempts[0]?.result?.attempt.state).toBe("UNKNOWN");
    expect(run.outcomes).toEqual([{ actionId, result: expect.objectContaining({ status: "PENDING", reason: "the repayment transfer is UNKNOWN, not verified" }) }]);
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
    expect(db.prepare("SELECT count(*) AS n FROM proof_allocations WHERE action_id = ?").get(actionId)?.n).toBe(0);
    expect((await chain.registry.readCase(caseKey))?.state).toBe("RESERVED_REPAY");
    expect(await request(setup, using)).toMatchObject({ status: "ALREADY_REQUESTED" });
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
  });

  it("refuses a transaction already bound as another operation's payment", async () => {
    const { setup, actionId } = await reserved();
    const requested = await request(setup, payments());
    ticks(6);
    await reconcilePending({ db, rail: sim.rail, registry: undefined, now: clock, requiredLevel: "FINAL" });
    const txHash = getPaymentAttempt(db, requested.attempt?.id ?? "")?.txHash ?? "";
    const other = await setupFixtureCase(db, "lost-response");
    immediateTransaction(db, () =>
      insertProofAllocation(db, { deploymentId: "local-registry", chainId: 133, proofId: txHash, proofType: "ORIGINAL_PAYMENT", operationId: other.operationId, actionId: null, actor: "test", now: new Date().toISOString() }),
    );
    expect(await refusal(completeRepayment(db, { actionId, registry: chain.registry, now: clock }))).toBe("PROOF_ALREADY_ALLOCATED");
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
    expect(getCase(db, setup.caseId)?.status).toBe("EXECUTION_REQUESTED");
  });

  it("answers concurrent requests that reach the permit together with the one repayment", async () => {
    const { setup } = await reserved();
    const using = payments();
    // Every request is held inside order creation until all twenty are there, so they all reach the permit.
    let arrived = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rail: PaymentRail = {
      ...using.rail,
      prepare: async (input) => {
        arrived += 1;
        if (arrived === 20) release();
        await gate;
        return using.rail.prepare(input);
      },
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => request(setup, { ...using, rail })));
    expect(arrived).toBe(20);
    expect(results.filter((result) => result.status === "SUBMITTED")).toHaveLength(1);
    expect(results.filter((result) => result.status === "ALREADY_REQUESTED")).toHaveLength(19);
    expect(using.calls).toEqual({ sign: 1, submit: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM execution_permits").get()?.n).toBe(1);
  });

  it("does not close on a transaction hash without a verified transfer", async () => {
    const { setup, actionId } = await reserved();
    const requested = await request(setup, payments());
    db.prepare("UPDATE payment_attempts SET tx_hash = ?, revision = revision + 1 WHERE id = ?").run(`0x${"6".repeat(64)}`, requested.attempt?.id ?? "");
    expect(await completeRepayment(db, { actionId, registry: chain.registry, now: clock })).toMatchObject({ status: "PENDING", reason: "the repayment transfer is SIGNING_REQUESTED, not verified" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
  });

  it("refuses to record against registry terms that differ from the proposal", async () => {
    const { setup, actionId } = await reserved();
    await request(setup, payments());
    ticks(6);
    await reconcilePending({ db, rail: sim.rail, registry: undefined, now: clock, requiredLevel: "FINAL" });
    const altered = Object.create(chain.registry) as RegistryGateway;
    altered.readCase = async (key) => {
      const onChain = await chain.registry.readCase(key);
      return onChain === undefined ? undefined : { ...onChain, amountBaseUnits: "999999" };
    };
    expect(await refusal(completeRepayment(db, { actionId, registry: altered, now: clock }))).toBe("REGISTRY_TERMS_MISMATCH");
    expect(getRecoveryAction(db, actionId)?.state).toBe("VERIFIED");
  });

  it("records nothing for a quarantined case", async () => {
    const { setup, actionId, caseKey } = await reserved();
    await request(setup, payments());
    ticks(6);
    await reconcilePending({ db, rail: sim.rail, registry: undefined, now: clock, requiredLevel: "FINAL" });
    immediateTransaction(db, () => {
      const record = readCaseEvidence(db, setup.caseId).case;
      moveCase(db, record, "QUARANTINED", { actor: "operator", evidenceRef: "incident-10" }, "operator:ops", "CASE_QUARANTINED", new Date().toISOString(), {});
    });
    expect(await refusal(completeRepayment(db, { actionId, registry: chain.registry, now: clock }))).toBe("CASE_NOT_READY");
    expect((await chain.registry.readCase(caseKey))?.state).toBe("RESERVED_REPAY");
  });

  it("refuses to record over a different outcome on the registry", async () => {
    const { setup, actionId, caseKey } = await reserved();
    await request(setup, payments());
    ticks(6);
    await reconcilePending({ db, rail: sim.rail, registry: undefined, now: clock, requiredLevel: "FINAL" });
    await chain.registry.completeRepayment(caseKey, `0x${"7".repeat(64)}`, "8".repeat(64));
    expect(await refusal(completeRepayment(db, { actionId, registry: chain.registry, now: clock }))).toBe("REGISTRY_OUTCOME_MISMATCH");
    expect(getRecoveryAction(db, actionId)?.state).toBe("VERIFIED");
  });
});

describe("refusals before anything is paid", () => {
  const LATE_CLAIM = { submittedBy: "buyer" as const, source: "buyer-claim" as const, mediaType: "text/plain" as const, sourceEventId: "late-claim", content: "Still nothing.", observedAt: null };

  it("refuses anyone but the seller, and a repayment that is not reserved", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const using = payments();
    const prepared = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock });
    expect(await refusal(request(setup, using))).toBe("WRONG_ACTION_STATE");
    for (const requestedBy of [BUYER, "0x00000000000000000000000000000000000000c1"]) {
      expect(await refusal(request(setup, using, { requestedBy })), requestedBy).toBe("ROLE_FORBIDDEN");
    }
    if (prepared.sellerCall === null) throw new Error("expected a seller call");
    const hash = await chain.sendAs(SELLER as Address, prepared.sellerCall);
    await chain.mined(hash);
    await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: hash, registry: chain.registry, now: clock });
    expect(await refusal(request(setup, using, { registry: undefined }))).toBe("REGISTRY_REQUIRED");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
    expect(repaymentAttempts(setup.operationId)).toBe(0);
  });

  it("refuses an expired reservation", async () => {
    const { setup } = await reserved();
    const using = payments();
    expect(await refusal(request(setup, using, { now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) }))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
    expect(repaymentAttempts(setup.operationId)).toBe(0);
  });

  it("refuses once the evidence has changed", async () => {
    const { setup } = await reserved();
    const using = payments();
    ingestEvidence(db, { ...LATE_CLAIM, operationId: setup.operationId, now: new Date().toISOString() });
    expect(await refusal(request(setup, using))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
    expect(repaymentAttempts(setup.operationId)).toBe(0);
  });

  it("refuses a quarantined case", async () => {
    const { setup } = await reserved();
    const using = payments();
    immediateTransaction(db, () => {
      const record = readCaseEvidence(db, setup.caseId).case;
      moveCase(db, record, "QUARANTINED", { actor: "operator", evidenceRef: "incident-9" }, "operator:ops", "CASE_QUARANTINED", new Date().toISOString(), {});
    });
    expect(await refusal(request(setup, using))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
  });

  it("rechecks the reservation inside the claim, so one that goes stale mid-request is not paid", async () => {
    const { setup, actionId } = await reserved();
    const using = payments();
    // The evidence changes while the order is being created, after the first checks passed.
    const rail: PaymentRail = {
      ...using.rail,
      prepare: async (input) => {
        ingestEvidence(db, { ...LATE_CLAIM, operationId: setup.operationId, now: new Date().toISOString() });
        return using.rail.prepare(input);
      },
    };
    expect(await refusal(request(setup, { ...using, rail }))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
    const action = getRecoveryAction(db, actionId);
    expect(action?.state).toBe("RESERVED");
    expect(db.prepare("SELECT count(*) AS n FROM execution_permits").get()?.n).toBe(0);
    expect(action === undefined ? undefined : liveAttempt(db, action)?.state).toBe("PREPARED");
  });

  it("refuses a cart from a receiving agent the seller's Payment Agent does not trust", async () => {
    const { setup, actionId } = await reserved();
    const wrongMerchant = payments({ merchant: { merchantName: "Someone Else", publicKey: sim.merchantPublicKey } });
    expect(await refusal(request(setup, wrongMerchant))).toBe("CART_REJECTED");
    expect(wrongMerchant.calls).toEqual({ sign: 0, submit: 0 });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");
    const using = payments();
    expect((await request(setup, using)).status).toBe("SUBMITTED");
    expect(repaymentAttempts(setup.operationId)).toBe(1);
  });

  it("leaves a standing-policy repayment to the seller's guarded signer", async () => {
    // A seller of its own, so its policy cannot route the other tests' repayments.
    const policySeller = "0x00000000000000000000000000000000000000a9" as Address;
    const delegate = chain.addressOf(chain.keys[4] as `0x${string}`);
    const block = (await chain.rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const chainNow = Number(BigInt(block.timestamp));
    const activation = chain.registry.activatePolicyCall({
      delegate,
      signer: chain.addressOf(chain.keys[6] as `0x${string}`),
      token: TOKEN as Address,
      paymentChainId: 133,
      servicePolicySha256: TERMS.get("extraction-delivery-v1")?.sha256 ?? "",
      eligibilityRulesSha256: eligibilityRulesSha256("RULES_BASELINE"),
      maxPerCaseBaseUnits: "2000000",
      dailyLimitBaseUnits: "10000000",
      validFrom: new Date((chainNow - 60) * 1000).toISOString(),
      validUntil: new Date((chainNow + 7 * 86_400) * 1000).toISOString(),
    });
    await chain.mined(await chain.sendAs(policySeller, activation));
    const setup = await setupFixtureCase(db, "refundable-failure-standing-policy", { buyer: BUYER, seller: policySeller });
    const prepared = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: policySeller }, registry: chain.registry, terms: TERMS, now: clock });
    expect(prepared.action.authorizationMode).toBe("STANDING_POLICY");
    if (prepared.delegateCall === null) throw new Error("expected a delegate call");
    const byDelegate = await chain.sendAs(delegate, prepared.delegateCall);
    await chain.mined(byDelegate);
    expect(await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: byDelegate, registry: chain.registry, now: clock })).toMatchObject({ status: "CONFIRMED" });

    const using = payments();
    expect(await refusal(request(setup, using, { requestedBy: policySeller }))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
    expect(repaymentAttempts(setup.operationId)).toBe(0);
  });

  it("refuses to pay through an attempt made for another action", async () => {
    const { setup } = await reserved();
    db.prepare(
      `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units,
         intent_sha256, deployment_id, created_at, updated_at)
       VALUES ('foreign', ?, 'REPAYMENT', 'CREATED', ?, ?, 133, ?, '1000000', ?, 'local-registry', ?, ?)`,
    ).run(setup.operationId, SELLER, BUYER, TOKEN, "f".repeat(64), new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE payment_attempts SET cart_mandate_id = 'cart-foreign', payment_request_id = 'pr-foreign', revision = revision + 1 WHERE id = 'foreign'").run();
    const using = payments();
    await expect(request(setup, using)).rejects.toMatchObject({ code: "ACTION_INTEGRITY", message: expect.stringMatching(/is not for recovery action/) });
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
  });

  it("refuses when the registry no longer holds the reservation", async () => {
    const { setup } = await reserved();
    const using = payments();
    const altered = Object.create(chain.registry) as RegistryGateway;
    altered.readCase = async (key) => {
      const onChain = await chain.registry.readCase(key);
      return onChain === undefined ? undefined : { ...onChain, state: "OPEN" };
    };
    expect(await refusal(request(setup, using, { registry: altered }))).toBe("NOT_EXECUTABLE");
    expect(using.calls).toEqual({ sign: 0, submit: 0 });
  });
});

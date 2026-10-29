import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProvenanceViolationError,
  RailUnavailableError,
  createSimulatedAdapters,
  signSimulatedPayload,
  validateCartMandate,
  type GatewayFault,
  type PaymentRail,
  type RailObservation,
  type SimulatedAdapters,
  type ValidatedCart,
} from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";
import { immediateTransaction, openDatabase } from "../../src/db/database.ts";
import { getPaymentAttempt, moveAttempt } from "../../src/db/payments.ts";
import { ExecutionRefusedError, claimExecution, executePayment, type PaymentSigner } from "../../src/payments/execution.ts";
import { quoteOperation, type Quote } from "../../src/payments/quote.ts";
import { reconcileAttempt } from "../../src/payments/reconcile.ts";
import { reconcilePending, startReconciler } from "../../src/payments/reconciler.ts";
import { BUYER, NOW, SELLER, TOKEN, memoryDatabase, seedOperation } from "../db/helpers.ts";

let db: DatabaseSync;
let sim: SimulatedAdapters;
let operationId: string;

beforeEach(() => {
  db = memoryDatabase();
  sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret" });
  operationId = seedOperation(db);
});

afterEach(() => {
  db.close();
});

const now = () => sim.clock.now();

/** The quote and the buyer Payment Agent's validated cart for it. */
async function quoted(target: DatabaseSync = db, operation = operationId): Promise<{ quote: Quote; cart: ValidatedCart }> {
  const quote = await quoteOperation(target, { operationId: operation, rail: sim.rail, deploymentId: "local-registry", coin: "USDC", label: "Structured extraction job", now });
  const validation = validateCartMandate({
    cartMandate: quote.cartMandate,
    merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
    intent: { cartMandateId: quote.cartMandateId, paymentRequestId: quote.paymentRequestId, payee: SELLER as Address, chainId: 133, token: TOKEN as Address, tokenDecimals: 6, priceUsd: "1.00" },
    policy: { payeeAllowlist: [SELLER as Address], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0", maxFeeBaseUnits: "100000", usdRate: "1" },
    now: sim.clock.now(),
  });
  if (!validation.ok) throw new Error(validation.rejections.map((entry) => entry.message).join("; "));
  return { quote, cart: validation.cart };
}

/** The simulated signer and rail, counting every signature and submission they make. */
function counted(options: { signFails?: boolean } = {}): { signer: PaymentSigner; rail: PaymentRail; calls: { sign: number; submit: number } } {
  const calls = { sign: 0, submit: 0 };
  return {
    calls,
    signer: {
      provenance: "SIMULATED",
      sign: async (payload) => {
        calls.sign += 1;
        if (options.signFails === true) throw new Error("signer connection reset");
        return signSimulatedPayload(payload);
      },
    },
    rail: {
      provenance: "SIMULATED",
      prepare: (input) => sim.rail.prepare(input),
      submit: async (signed) => {
        calls.submit += 1;
        return sim.rail.submit(signed);
      },
      observe: (paymentRequestId) => sim.rail.observe(paymentRequestId),
    },
  };
}

function execute(attemptId: string, cart: ValidatedCart, tools: ReturnType<typeof counted>, overrides: Partial<Parameters<typeof executePayment>[1]> = {}) {
  return executePayment(db, { attemptId, requestedBy: BUYER, cart, signer: tools.signer, rail: tools.rail, now, ...overrides });
}

function reconcile(attemptId: string, requiredLevel: "SAFE" | "FINAL" = "FINAL") {
  return reconcileAttempt(db, { attemptId, rail: sim.rail, now, requiredLevel });
}

function permits(target: DatabaseSync = db): Record<string, unknown>[] {
  return target.prepare("SELECT attempt_id, fencing_token, state FROM execution_permits").all() as Record<string, unknown>[];
}

function attemptEvents(attemptId: string): string[] {
  return db
    .prepare("SELECT event_type FROM events WHERE entity_type = 'payment_attempt' AND entity_id = ? ORDER BY seq")
    .all(attemptId)
    .map((row) => String(row.event_type));
}

function ticks(count: number): void {
  for (let index = 0; index < count; index += 1) sim.gateway.tick();
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof ProvenanceViolationError ? "PROVENANCE" : "UNEXPECTED");
  }
  return "accepted";
}

describe("payment execution", () => {
  it("signs and submits once under a consumed permit, then reconciles to VERIFIED from the gateway and the chain", async () => {
    const { quote, cart } = await quoted();
    const tools = counted();
    const outcome = await execute(quote.attemptId, cart, tools);
    expect(outcome).toMatchObject({ status: "SUBMITTED", attempt: { state: "SIGNING_REQUESTED" } });
    expect(tools.calls).toEqual({ sign: 1, submit: 1 });
    expect(permits()).toEqual([{ attempt_id: quote.attemptId, fencing_token: 2, state: "CONSUMED" }]);
    const signed = getPaymentAttempt(db, quote.attemptId);
    expect(signed?.paymentMandateSha256).toBe(outcome.paymentMandateSha256);

    const submitted = await reconcile(quote.attemptId);
    expect(submitted).toMatchObject({ moved: ["SUBMITTED"], observed: "SUBMITTED", attempt: { state: "SUBMITTED" } });
    expect(submitted.attempt.flowId).not.toBeNull();
    expect(submitted.attempt.requestId).not.toBeNull();

    ticks(6);
    const verified = await reconcile(quote.attemptId);
    expect(verified).toMatchObject({ moved: ["OBSERVED", "VERIFIED"], verdict: "VERIFIED", attempt: { state: "VERIFIED" } });
    expect(verified.attempt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(attemptEvents(quote.attemptId)).toEqual([
      "PAYMENT_ATTEMPT_CREATED",
      "PAYMENT_ATTEMPT_PREPARED",
      "PAYMENT_SIGNING_REQUESTED",
      "PAYMENT_SUBMITTED",
      "PAYMENT_OBSERVED",
      "PAYMENT_VERIFIED",
    ]);
    expect(await reconcile(quote.attemptId)).toMatchObject({ moved: [], reason: "the attempt is VERIFIED" });
    expect(tools.calls).toEqual({ sign: 1, submit: 1 });
  });

  it("records the digest of exactly the mandate it signed", async () => {
    const { quote, cart } = await quoted();
    let signedPayload: unknown;
    const tools = counted();
    const signer: PaymentSigner = { provenance: "SIMULATED", sign: async (payload) => ((signedPayload = payload), tools.signer.sign(payload)) };
    const outcome = await execute(quote.attemptId, cart, tools, { signer });
    expect(outcome.paymentMandateSha256).toBe(sha256Hex(canonicalJson(signedPayload as CanonicalValue)));
    expect(signedPayload).toMatchObject({ payer: BUYER, payee: SELLER, cartSha256: quote.cartSha256, paymentRequestId: quote.paymentRequestId, amountBaseUnits: "1000000" });
  });

  it("invokes the signer and the gateway at most once for twenty concurrent commands", async () => {
    const { quote, cart } = await quoted();
    const tools = counted();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => execute(quote.attemptId, cart, tools)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.flatMap((result) => (result.status === "rejected" ? [(result.reason as ExecutionRefusedError).code] : []));
    expect(refused).toEqual(Array.from({ length: 19 }, () => "PERMIT_CONSUMED"));
    expect(tools.calls).toEqual({ sign: 1, submit: 1 });
    expect(permits()).toHaveLength(1);
  });

  it("grants one claim across separate database connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settleback-claim-"));
    try {
      const path = join(dir, "settleback-local.db");
      const file = openDatabase({ path, environment: "local", now: () => NOW });
      let prepared: { quote: Quote; cart: ValidatedCart };
      try {
        prepared = await quoted(file, seedOperation(file, "op-key-file"));
      } finally {
        file.close();
      }
      const { quote, cart } = prepared;
      const gate = new SharedArrayBuffer(4);
      const workers = Array.from(
        { length: 12 },
        () => new Worker(new URL("./claim-worker.ts", import.meta.url), { workerData: { path, attemptId: quote.attemptId, payer: BUYER, cart, now: NOW, gate } }),
      );
      const results = workers.map(
        (worker) =>
          new Promise<{ fencingToken?: number; code?: string; message?: string }>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const settled = await Promise.all(results);
      await Promise.all(workers.map((worker) => worker.terminate()));

      expect(settled.filter((result) => result.fencingToken !== undefined)).toHaveLength(1);
      expect(settled.filter((result) => result.fencingToken === undefined).map((result) => result.code)).toEqual(Array.from({ length: 11 }, () => "PERMIT_CONSUMED"));
      const check = openDatabase({ path, environment: "local", now: () => NOW });
      try {
        expect(permits(check)).toHaveLength(1);
        expect(check.prepare("SELECT state FROM payment_attempts WHERE id = ?").get(quote.attemptId)?.state).toBe("SIGNING_REQUESTED");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("freezes after a consumed permit's response is lost: no second signature, no new attempt, only observation", async () => {
    const { quote, cart } = await quoted();
    const crashing = counted({ signFails: true });
    const lost = await execute(quote.attemptId, cart, crashing);
    expect(lost).toMatchObject({ status: "OUTCOME_UNKNOWN", attempt: { state: "SIGNING_REQUESTED" } });
    expect(lost.status === "OUTCOME_UNKNOWN" ? lost.reason : "").toMatch(/signer connection reset/);

    const retry = counted();
    expect(await refusal(execute(quote.attemptId, cart, retry))).toBe("PERMIT_CONSUMED");
    expect(await refusal(quoted())).toBe("ATTEMPT_NOT_QUOTABLE");
    const frozen = await reconcilePending({ db, rail: sim.rail, registry: undefined, now, requiredLevel: "FINAL" });
    expect(frozen.attempts).toEqual([{ attemptId: quote.attemptId, result: expect.objectContaining({ moved: [], reason: "the gateway has not received the payment" }) }]);
    ticks(10);
    expect((await reconcile(quote.attemptId)).attempt.state).toBe("SIGNING_REQUESTED");
    expect({ crashing: crashing.calls, retry: retry.calls }).toEqual({ crashing: { sign: 1, submit: 0 }, retry: { sign: 0, submit: 0 } });
    expect(db.prepare("SELECT count(*) AS n FROM payment_attempts").get()?.n).toBe(1);
  });

  it("never signs a fresh mandate after a submission timeout; observation finds the payment", async () => {
    const { quote, cart } = await quoted();
    sim.gateway.injectFault(quote.paymentRequestId, { kind: "lose-submit-response" });
    sim.gateway.injectFault(quote.paymentRequestId, { kind: "query-unavailable", times: 1 });
    const tools = counted();
    const outcome = await execute(quote.attemptId, cart, tools);
    expect(outcome).toMatchObject({ status: "OUTCOME_UNKNOWN", reason: "the submission response was lost and the gateway shows no payment yet" });
    expect(await refusal(execute(quote.attemptId, cart, tools))).toBe("PERMIT_CONSUMED");

    ticks(6);
    const run = await reconcilePending({ db, rail: sim.rail, registry: undefined, now, requiredLevel: "FINAL" });
    expect(run.attempts[0]?.result?.attempt.state).toBe("VERIFIED");
    expect(tools.calls).toEqual({ sign: 1, submit: 1 });
  });

  it("refuses before consuming the permit when the payer, cart, state, provenance, or precondition is wrong", async () => {
    const { quote, cart } = await quoted();
    const tools = counted();
    const cases: [string, Promise<unknown>][] = [
      ["ROLE_FORBIDDEN", execute(quote.attemptId, cart, tools, { requestedBy: SELLER })],
      ["CART_MISMATCH", execute(quote.attemptId, { ...cart, amountBaseUnits: "999999" }, tools)],
      ["CART_MISMATCH", execute(quote.attemptId, { ...cart, payee: `0x${"c1".repeat(20)}` as Address }, tools)],
      ["CART_MISMATCH", execute(quote.attemptId, { ...cart, cartSha256: "0".repeat(64) }, tools)],
      ["ATTEMPT_NOT_FOUND", execute("missing", cart, tools)],
      ["PROVENANCE", execute(quote.attemptId, cart, tools, { signer: { provenance: "LIVE", sign: tools.signer.sign } })],
      [
        "ATTEMPT_NOT_EXECUTABLE",
        execute(quote.attemptId, cart, tools, {
          precondition: () => {
            throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", "the reservation is no longer executable");
          },
        }),
      ],
    ];
    for (const [expected, work] of cases) expect(await refusal(work), expected).toBe(expected);
    expect(permits()).toEqual([]);
    expect(tools.calls).toEqual({ sign: 0, submit: 0 });
    expect(getPaymentAttempt(db, quote.attemptId)?.state).toBe("PREPARED");
    expect((await execute(quote.attemptId, cart, tools)).status).toBe("SUBMITTED");
  });

  it("will not execute an attempt that was never prepared", async () => {
    const down: PaymentRail = { provenance: "SIMULATED", prepare: async () => Promise.reject(new RailUnavailableError("create order")), submit: (signed) => sim.rail.submit(signed), observe: (id) => sim.rail.observe(id) };
    await expect(quoteOperation(db, { operationId, rail: down, deploymentId: "local-registry", coin: "USDC", label: "job", now })).rejects.toBeInstanceOf(RailUnavailableError);
    const created = getPaymentAttempt(db, String(db.prepare("SELECT id FROM payment_attempts").get()?.id));
    if (created === undefined) throw new Error("expected the created attempt");
    const cart: ValidatedCart = {
      cartMandateId: created.cartMandateId ?? "",
      paymentRequestId: created.paymentRequestId ?? "",
      cartSha256: "0".repeat(64),
      methodIndex: 0,
      payee: SELLER as Address,
      chainId: 133,
      token: TOKEN as Address,
      totalUsd: "1.00",
      amountBaseUnits: "1000000",
      grossLimitBaseUnits: "1100000",
    };
    const tools = counted();
    expect(await refusal(execute(created.id, cart, tools))).toBe("ATTEMPT_NOT_EXECUTABLE");
    expect(permits()).toEqual([]);
    expect(tools.calls).toEqual({ sign: 0, submit: 0 });
  });
});

describe("reconciliation", () => {
  async function submitted(fault?: GatewayFault): Promise<string> {
    const { quote, cart } = await quoted();
    if (fault !== undefined) sim.gateway.injectFault(quote.paymentRequestId, fault);
    expect((await execute(quote.attemptId, cart, counted())).status).toBe("SUBMITTED");
    return quote.attemptId;
  }

  it("verifies only at the required level", async () => {
    const attemptId = await submitted();
    ticks(4);
    expect(sim.gateway.query(getPaymentAttempt(db, attemptId)?.paymentRequestId ?? "").status).toBe("payment-safe");
    expect(await reconcile(attemptId, "FINAL")).toMatchObject({ moved: ["SUBMITTED", "OBSERVED"], verdict: "PENDING", attempt: { state: "OBSERVED" } });
    expect(await reconcile(attemptId, "SAFE")).toMatchObject({ moved: ["VERIFIED"], verdict: "VERIFIED" });
  });

  it("waits through delayed finality without changing its answer", async () => {
    const attemptId = await submitted({ kind: "delayed-finality", extraTicks: 3 });
    ticks(4);
    expect((await reconcile(attemptId)).attempt.state).toBe("OBSERVED");
    ticks(1);
    expect((await reconcile(attemptId)).moved).toEqual([]);
    ticks(4);
    expect((await reconcile(attemptId)).attempt.state).toBe("VERIFIED");
  });

  it("makes contradictions UNKNOWN and never VERIFIED", async () => {
    const expectations: [GatewayFault, string][] = [
      [{ kind: "wrong-receipt", field: "amount" }, "MISMATCH"],
      [{ kind: "wrong-receipt", field: "payee" }, "MISMATCH"],
      [{ kind: "unknown-transaction" }, "INCONSISTENT"],
      [{ kind: "broadcast-never-succeeds" }, "NO_TRANSFER_FOUND"],
      [{ kind: "included-then-failed" }, "INCONSISTENT"],
    ];
    for (const [fault, verdict] of expectations) {
      db.close();
      db = memoryDatabase();
      sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret" });
      operationId = seedOperation(db);
      const attemptId = await submitted(fault);
      const states: string[] = [];
      let last;
      for (let round = 0; round < 8; round += 1) {
        ticks(1);
        last = await reconcile(attemptId);
        states.push(last.attempt.state);
      }
      expect(states, fault.kind).not.toContain("VERIFIED");
      expect(last?.attempt.state, fault.kind).toBe("UNKNOWN");
      expect(last?.verdict, fault.kind).toBe(verdict);
      expect(getPaymentAttempt(db, attemptId)?.txHash, fault.kind).toBeNull();
    }
  });

  it("changes nothing while the gateway cannot be reached", async () => {
    const attemptId = await submitted();
    sim.gateway.injectFault(getPaymentAttempt(db, attemptId)?.paymentRequestId ?? "", { kind: "query-unavailable", times: 2 });
    ticks(6);
    for (let round = 0; round < 2; round += 1) {
      expect(await reconcile(attemptId)).toMatchObject({ moved: [], reason: "the gateway could not be reached; observe again later", attempt: { state: "SIGNING_REQUESTED" } });
    }
    expect((await reconcile(attemptId)).attempt.state).toBe("VERIFIED");
  });

  it("records each step once when observations run concurrently", async () => {
    const attemptId = await submitted();
    ticks(6);
    const results = await Promise.all(Array.from({ length: 5 }, () => reconcile(attemptId)));
    expect(results.filter((result) => result.moved.length > 0)).toHaveLength(1);
    expect(getPaymentAttempt(db, attemptId)?.state).toBe("VERIFIED");
    expect(attemptEvents(attemptId).filter((event) => event === "PAYMENT_VERIFIED")).toHaveLength(1);
  });

  function altered(change: (observation: RailObservation) => RailObservation | Promise<RailObservation>): PaymentRail {
    return {
      provenance: "SIMULATED",
      prepare: (input) => sim.rail.prepare(input),
      submit: (signed) => sim.rail.submit(signed),
      observe: async (paymentRequestId) => change(await sim.rail.observe(paymentRequestId)),
    };
  }

  function reconcileWith(attemptId: string, rail: PaymentRail) {
    return reconcileAttempt(db, { attemptId, rail, now, requiredLevel: "FINAL" });
  }

  it("does not believe a gateway that changes its account of an order", async () => {
    const attemptId = await submitted();
    const otherOrder = await reconcileWith(attemptId, altered((observation) => ({ ...observation, record: { ...observation.record, payment_request_id: "pr-someone-else" } })));
    expect(otherOrder).toMatchObject({ moved: [], reason: "the gateway answered with a record for a different order", attempt: { state: "SIGNING_REQUESTED" } });

    expect((await reconcile(attemptId)).attempt.state).toBe("SUBMITTED");
    const otherFlow = await reconcileWith(attemptId, altered((observation) => ({ ...observation, record: { ...observation.record, flow_id: "flow-rewritten" } })));
    expect(otherFlow).toMatchObject({ moved: ["UNKNOWN"], reason: "the gateway reports a different flow for this order" });
    expect(getPaymentAttempt(db, attemptId)?.flowId).not.toBe("flow-rewritten");
    ticks(6);
    expect((await reconcile(attemptId)).attempt.state).toBe("VERIFIED");
  });

  it("makes a submitted payment that the gateway no longer shows UNKNOWN", async () => {
    const attemptId = await submitted();
    expect((await reconcile(attemptId)).attempt.state).toBe("SUBMITTED");
    const vanished = await reconcileWith(attemptId, altered((observation) => ({ ...observation, kind: "AWAITING_PAYER", record: { ...observation.record, status: "payment-required" } })));
    expect(vanished).toMatchObject({ moved: ["UNKNOWN"], reason: "the gateway no longer shows the submitted payment" });
  });

  it("refuses an observation labeled live in the local environment", async () => {
    const attemptId = await submitted();
    await expect(reconcileWith(attemptId, altered((observation) => ({ ...observation, provenance: "LIVE" })))).rejects.toBeInstanceOf(ProvenanceViolationError);
    expect(getPaymentAttempt(db, attemptId)?.state).toBe("SIGNING_REQUESTED");
  });

  it("discards an observation that the attempt has moved past while it was taken", async () => {
    const attemptId = await submitted();
    ticks(6);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stale = reconcileWith(
      attemptId,
      altered(async (observation) => {
        await gate;
        return { ...observation, kind: "FAILED_NO_TRANSACTION", transfer: null, record: { ...observation.record, status: "payment-failed", tx_signature: null } };
      }),
    );
    expect((await reconcile(attemptId)).attempt.state).toBe("VERIFIED");
    release();
    expect(await stale).toMatchObject({ moved: [], reason: "the attempt changed while it was being observed; observe again", attempt: { state: "VERIFIED" } });
  });

  it("leaves attempts that were never executed alone", async () => {
    const { quote } = await quoted();
    expect(await reconcile(quote.attemptId)).toMatchObject({ moved: [], reason: "the attempt is PREPARED" });
    expect((await reconcilePending({ db, rail: sim.rail, registry: undefined, now, requiredLevel: "FINAL" })).attempts).toEqual([]);
  });
});

describe("attempt moves", () => {
  it("refuse a stale copy of the attempt and record nothing", async () => {
    const { quote } = await quoted();
    const stale = getPaymentAttempt(db, quote.attemptId);
    if (stale === undefined) throw new Error("expected the attempt");
    const move = { to: "SIGNING_REQUESTED" as const, actor: "server" as const, actorLabel: "test", eventType: "PAYMENT_SIGNING_REQUESTED", payloadSha256: "a".repeat(64), now: NOW };
    immediateTransaction(db, () => moveAttempt(db, stale, move));
    const events = attemptEvents(quote.attemptId).length;
    expect(() => immediateTransaction(db, () => moveAttempt(db, stale, move))).toThrow(/changed concurrently/);
    expect(attemptEvents(quote.attemptId)).toHaveLength(events);
    expect(getPaymentAttempt(db, quote.attemptId)?.revision).toBe(stale.revision + 1);
  });
});

describe("the reconciler loop", () => {
  it("runs passes on its interval without overlapping them", async () => {
    const attemptId = await (async () => {
      const { quote, cart } = await quoted();
      await execute(quote.attemptId, cart, counted());
      return quote.attemptId;
    })();
    ticks(6);
    const runs: number[] = [];
    const reconciler = startReconciler({ db, rail: sim.rail, registry: undefined, now, requiredLevel: "FINAL", intervalMs: 5, onRun: (run) => runs.push(run.attempts.length) });
    try {
      const [first, second] = [reconciler.runOnce(), reconciler.runOnce()];
      expect(first).toBe(second);
      await first;
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      await reconciler.stop();
    }
    expect(getPaymentAttempt(db, attemptId)?.state).toBe("VERIFIED");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((count) => count === 0)).toBe(true);
  });
});

import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryOutcomeUnknownError, RegistryRevertError } from "@settleback/adapters";
import { getRecoveryAction } from "../../src/db/actions.ts";
import { getCase, readCaseEvidence } from "../../src/db/cases.ts";
import { immediateTransaction } from "../../src/db/database.ts";
import { ingestEvidence } from "../../src/db/evidence.ts";
import { assessCase } from "../../src/recovery/assessment.ts";
import { confirmRepaymentReservation, ensureRegistered, moveCase, prepareRecovery, strandRecovery } from "../../src/recovery/actions.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { acknowledgeDelivery, recordRetrievalOutcome, retrieveResult, type ResultLookup } from "../../src/recovery/retrieval.ts";
import { BUYER, SELLER, memoryDatabase } from "../db/helpers.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";
import { ScriptedProvider, TERMS, lineWith, registerFixturePolicies, reply, setupFixtureCase, type FixtureCaseSetup } from "./helpers.ts";

const OTHER_BUYER = "0x00000000000000000000000000000000000000b2";
const clock = () => new Date();
let chain: LocalChain;
let otherChain: LocalChain;
let db: DatabaseSync;

beforeAll(async () => {
  // Another deployment: same deployer and nonce, so the same address, on another chain.
  [chain, otherChain] = await Promise.all([startLocalChain(), startLocalChain({ chainId: 31_338 })]);
}, 120_000);

afterAll(() => {
  chain?.stop();
  otherChain?.stop();
});

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
});

afterEach(() => {
  db.close();
});

/** A reserved retrieval for the lost-response fixture: the job completed, the response never arrived. */
async function reservedRetrieval(fixture = "lost-response"): Promise<{ setup: FixtureCaseSetup; actionId: string; digest: string }> {
  const setup = await setupFixtureCase(db, fixture);
  const { action } = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock });
  expect(action.state).toBe("RESERVED");
  return { setup, actionId: action.id, digest: action.proposal.artifactSha256 ?? "" };
}

function retrieve(setup: FixtureCaseSetup, overrides: Partial<Parameters<typeof retrieveResult>[1]> = {}) {
  return retrieveResult(db, { operationId: setup.operationId, buyer: BUYER, registry: chain.registry, lookup: setup.lookup, now: clock, ...overrides });
}

function acknowledge(setup: FixtureCaseSetup, artifactSha256: string, overrides: Partial<Parameters<typeof acknowledgeDelivery>[1]> = {}) {
  return acknowledgeDelivery(db, { operationId: setup.operationId, buyer: BUYER, artifactSha256, registry: chain.registry, now: clock, ...overrides });
}

function actionEvents(actionId: string): string[] {
  return db
    .prepare("SELECT event_type FROM events WHERE entity_type = 'recovery_action' AND entity_id = ? ORDER BY seq")
    .all(actionId)
    .map((row) => String(row.event_type));
}

function paymentAttempts(operationId: string): number {
  return Number(db.prepare("SELECT count(*) AS n FROM payment_attempts WHERE operation_id = ?").get(operationId)?.n);
}

function quarantine(caseId: string): void {
  immediateTransaction(db, () => {
    const record = readCaseEvidence(db, caseId).case;
    moveCase(db, record, "QUARANTINED", { actor: "operator", evidenceRef: "incident-7" }, "operator:ops", "CASE_QUARANTINED", new Date().toISOString(), {});
  });
}

/** The registry, except that completing a retrieval behaves as given. */
function withCompletion(completeRetrieval: typeof chain.registry.completeRetrieval): typeof chain.registry {
  const registry = Object.create(chain.registry) as typeof chain.registry;
  registry.completeRetrieval = completeRetrieval;
  return registry;
}

/** The registry, except that reading a case returns what the given function makes of the chain's answer. */
function withReadCase(alter: (onChain: Awaited<ReturnType<typeof chain.registry.readCase>>) => Awaited<ReturnType<typeof chain.registry.readCase>>): typeof chain.registry {
  const registry = Object.create(chain.registry) as typeof chain.registry;
  registry.readCase = async (key) => alter(await chain.registry.readCase(key));
  return registry;
}

const unavailable = () => withCompletion(async () => Promise.reject(new Error("rpc unavailable")));

/** The fixture's services, with a side effect the first time the artifact's bytes are read. */
function duringFetch(setup: FixtureCaseSetup, effect: () => void): ResultLookup {
  let done = false;
  return {
    ...setup.lookup,
    artifactBytes: async (sha256, signal) => {
      if (!done) {
        done = true;
        effect();
      }
      return setup.lookup.artifactBytes(sha256, signal);
    },
  };
}

const LATE_CLAIM = {
  submittedBy: "buyer" as const,
  source: "buyer-claim" as const,
  mediaType: "text/plain" as const,
  sourceEventId: "late-claim",
  content: "The result never arrived.",
  observedAt: null,
};

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: String((error as { code?: unknown }).code), message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("result recovery", () => {
  it("delivers the existing artifact to its buyer without new work, then records RECOVERED once acknowledged", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    const run = setup.composed.serviceRun;
    if (run === null) throw new Error("the fixture ran the service");
    const stored = run.store.get(digest);
    expect(run.service.invocations(setup.operationId)).toBe(1);
    const attempts = paymentAttempts(setup.operationId);

    // Only the operation's buyer receives the result, and nothing can be acknowledged before delivery.
    expect(await refusal(retrieve(setup, { buyer: OTHER_BUYER }))).toMatchObject({ code: "ROLE_FORBIDDEN" });
    expect(await refusal(retrieve(setup, { buyer: SELLER }))).toMatchObject({ code: "ROLE_FORBIDDEN" });
    expect(await refusal(acknowledge(setup, digest))).toMatchObject({ code: "WRONG_ACTION_STATE" });
    expect(await refusal(retrieve(setup, { operationId: "missing" }))).toMatchObject({ code: "ACTION_NOT_FOUND" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");

    // Two concurrent requests release the result once.
    const [first, second] = await Promise.all([retrieve(setup), retrieve(setup)]);
    expect(Buffer.from(first.content).toString("utf8")).toBe(stored);
    expect(second.content).toEqual(first.content);
    expect(first.artifactSha256).toBe(digest);
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
    expect(getCase(db, setup.caseId)?.status).toBe("EXECUTION_REQUESTED");
    expect(actionEvents(actionId).filter((type) => type === "RECOVERY_RESULT_RELEASED")).toHaveLength(1);

    // The response or acknowledgement was lost: the buyer asks again and gets the same bytes.
    const again = await retrieve(setup);
    expect(again.content).toEqual(first.content);
    expect(await refusal(acknowledge(setup, "f".repeat(64)))).toMatchObject({ code: "ACK_DIGEST_MISMATCH" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");

    const acked = await acknowledge(setup, digest.toUpperCase());
    expect(acked.outcome).toMatchObject({ status: "RECORDED", action: { state: "COMPLETED", registryTx: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
    const onChain = await chain.registry.readCase(acked.outcome.action.proposal.caseKey);
    expect(onChain).toMatchObject({ state: "RECOVERED", outcomeRef: `0x${digest}`, outcomeCommitment: acked.acknowledgementSha256 });
    expect(db.prepare("SELECT buyer, artifact_sha256 FROM delivery_acks WHERE operation_id = ?").all(setup.operationId)).toEqual([{ buyer: BUYER, artifact_sha256: digest }]);

    // A repeated acknowledgement returns the stored one and changes nothing.
    const events = actionEvents(actionId);
    const repeated = await acknowledge(setup, digest);
    expect(repeated).toEqual({ ...acked, outcome: { status: "RECORDED", action: repeated.outcome.action } });
    expect(repeated.outcome.action.revision).toBe(acked.outcome.action.revision);
    expect(actionEvents(actionId)).toEqual(events);
    expect(events).toEqual([
      "RECOVERY_PREPARED",
      "RECOVERY_RETRIEVAL_RESERVED",
      "RECOVERY_RESULT_RELEASED",
      "RECOVERY_DELIVERY_ACKNOWLEDGED",
      "RECOVERY_OUTCOME_PENDING",
      "RECOVERY_RETRIEVAL_RECORDED",
    ]);

    // The buyer can still download its result; no work ran and nothing was paid along the way.
    expect((await retrieve(setup)).content).toEqual(first.content);
    expect(run.service.invocations(setup.operationId)).toBe(1);
    expect(paymentAttempts(setup.operationId)).toBe(attempts);
  });

  it("recovers a result found through a verified artifact lead, end to end", async () => {
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
    await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock });

    const result = await retrieve(setup);
    expect(result.artifactSha256).toBe(digest);
    const acked = await acknowledge(setup, digest);
    expect(acked.outcome).toMatchObject({ status: "RECORDED", action: { state: "COMPLETED" } });
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
    expect(setup.composed.serviceRun?.service.invocations(setup.operationId)).toBe(1);
  });
});

describe("delivery checks", () => {
  it("keeps the delivery pending whenever the artifact or its binding does not verify", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    const run = setup.composed.serviceRun;
    if (run === null) throw new Error("the fixture ran the service");
    const record = run.store.record(digest);
    const lookup = (overrides: Partial<ResultLookup>): ResultLookup => ({ ...setup.lookup, ...overrides });
    const cases: [Partial<ResultLookup>, string, RegExp][] = [
      [{ artifactBytes: async () => Buffer.from("other bytes") }, "ARTIFACT_MISMATCH", /do not hash to the expected digest/],
      [{ artifactBytes: async () => null }, "ARTIFACT_MISMATCH", /no bytes/],
      [{ artifactRecords: async () => "[]" }, "ARTIFACT_MISMATCH", /holds no artifact/],
      [{ artifactRecords: async () => JSON.stringify([{ ...record, writer: "wk-other" }]) }, "ARTIFACT_MISMATCH", /written by wk-other/],
      [{ artifactRecords: async () => JSON.stringify([{ ...record, currentSha256: "e".repeat(64) }]) }, "ARTIFACT_MISMATCH", /no longer match/],
      [{ jobStatus: async () => null }, "ARTIFACT_MISMATCH", /no job for this operation/],
      [{ artifactRecords: async () => "not json" }, "DEPENDENCY_UNAVAILABLE", /unreadable/],
      [{ jobStatus: async () => Promise.reject(new Error("connection refused")) }, "DEPENDENCY_UNAVAILABLE", /connection refused/],
    ];
    for (const [overrides, code, message] of cases) {
      expect(await refusal(retrieve(setup, { lookup: lookup(overrides) })), String(message)).toMatchObject({ code, message: expect.stringMatching(message) });
    }
    const hanging = lookup({ artifactBytes: (_sha256, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
    expect(await refusal(retrieve(setup, { lookup: hanging, timeoutMs: 50 }))).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");
    expect(getCase(db, setup.caseId)?.status).toBe("RESERVED");

    // After release, every repeated delivery is checked again: altered bytes are never handed over.
    await retrieve(setup);
    run.store.corrupt(digest);
    expect(await refusal(retrieve(setup))).toMatchObject({ code: "ARTIFACT_MISMATCH", message: expect.stringMatching(/no longer match/) });
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
  });

  it("never releases a reservation made stale by new evidence, and asks the services nothing", async () => {
    const { setup, actionId } = await reservedRetrieval();
    ingestEvidence(db, { ...LATE_CLAIM, operationId: setup.operationId, now: new Date().toISOString() });
    let calls = 0;
    const counting: ResultLookup = {
      jobStatus: async (...args) => (calls++, setup.lookup.jobStatus(...args)),
      artifactRecords: async (...args) => (calls++, setup.lookup.artifactRecords(...args)),
      artifactBytes: async (...args) => (calls++, setup.lookup.artifactBytes(...args)),
    };
    expect(await refusal(retrieve(setup, { lookup: counting }))).toMatchObject({ code: "NOT_EXECUTABLE", message: expect.stringMatching(/STALE_EVIDENCE/) });
    expect(calls).toBe(0);
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");
  });

  it("checks the reservation again when releasing, after the artifact was fetched", async () => {
    const changed = await reservedRetrieval();
    const lookup = duringFetch(changed.setup, () => ingestEvidence(db, { ...LATE_CLAIM, operationId: changed.setup.operationId, now: new Date().toISOString() }));
    expect(await refusal(retrieve(changed.setup, { lookup }))).toMatchObject({ code: "NOT_EXECUTABLE", message: expect.stringMatching(/STALE_EVIDENCE/) });
    expect(getRecoveryAction(db, changed.actionId)?.state).toBe("RESERVED");
  });

  it("does not release an action stranded while the artifact was fetched", async () => {
    const { setup, actionId } = await reservedRetrieval();
    const lookup = duringFetch(setup, () => strandRecovery(db, { actionId, operator: "ops", reason: "stopped by an operator", now: clock }));
    expect(await refusal(retrieve(setup, { lookup }))).toMatchObject({ code: "WRONG_ACTION_STATE" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("STRANDED");
  });

  it("never releases an expired reservation, and a stranded one has nothing to deliver", async () => {
    const { setup, actionId } = await reservedRetrieval();
    const deadline = Date.parse(getRecoveryAction(db, actionId)?.deadline ?? "");
    expect(await refusal(retrieve(setup, { now: () => new Date(deadline + 1_000) }))).toMatchObject({ code: "NOT_EXECUTABLE", message: expect.stringMatching(/EXPIRED/) });
    strandRecovery(db, { actionId, operator: "ops", reason: "expired before delivery", now: clock });
    expect(await refusal(retrieve(setup))).toMatchObject({ code: "WRONG_ACTION_STATE" });
  });

  it("releases only what the registry still holds as reserved for this proposal", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    const caseKey = getRecoveryAction(db, actionId)?.proposal.caseKey ?? "";
    const altered = Object.create(chain.registry) as typeof chain.registry;
    altered.readCase = async (key) => {
      const onChain = await chain.registry.readCase(key);
      return onChain === undefined ? undefined : { ...onChain, actionDigest: "d".repeat(64) };
    };
    expect(await refusal(retrieve(setup, { registry: altered }))).toMatchObject({ code: "REGISTRY_TERMS_MISMATCH", message: expect.stringMatching(/action digest/) });

    await chain.registry.completeRetrieval(caseKey, digest, "e".repeat(64));
    expect(await refusal(retrieve(setup))).toMatchObject({ code: "NOT_EXECUTABLE", message: expect.stringMatching(/RECOVERED, not reserved/) });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");
  });

  it("stops delivery and acknowledgement for a quarantined case", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    quarantine(setup.caseId);
    expect(await refusal(retrieve(setup))).toMatchObject({ code: "CASE_NOT_READY" });
    expect(await refusal(acknowledge(setup, digest))).toMatchObject({ code: "CASE_NOT_READY" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
  });
});

describe("registry outcome", () => {
  it("completes from the chain when the write landed but its receipt was lost", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    const lostReceipt = withCompletion(async (...args) => {
      const write = await chain.registry.completeRetrieval(...args);
      throw new RegistryOutcomeUnknownError(write.txHash, "receipt lost");
    });
    const acked = await acknowledge(setup, digest, { registry: lostReceipt });
    expect(acked.outcome).toMatchObject({ status: "RECORDED", action: { state: "COMPLETED", registryTx: null } });
    expect(getRecoveryAction(db, actionId)?.state).toBe("COMPLETED");
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
  });

  it("keeps the acknowledgement and retries a failed write without a second acknowledgement", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    const acked = await acknowledge(setup, digest, { registry: unavailable() });
    expect(acked.outcome).toMatchObject({ status: "PENDING", reason: "rpc unavailable", action: { state: "RECORD_PENDING" } });
    expect(getCase(db, setup.caseId)?.status).toBe("RECORD_PENDING");
    expect(await refusal(recordRetrievalOutcome(db, { actionId, registry: unavailable(), now: clock }))).toMatchObject({ message: "rpc unavailable" });

    const retried = await acknowledge(setup, digest);
    expect(retried.acknowledgementSha256).toBe(acked.acknowledgementSha256);
    expect(retried.acknowledgedAt).toBe(acked.acknowledgedAt);
    expect(retried.outcome).toMatchObject({ status: "RECORDED", action: { state: "COMPLETED" } });
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
    expect(db.prepare("SELECT count(*) AS n FROM delivery_acks WHERE operation_id = ?").get(setup.operationId)?.n).toBe(1);
    expect(actionEvents(actionId).filter((type) => type === "RECOVERY_DELIVERY_ACKNOWLEDGED")).toHaveLength(1);
    expect(await recordRetrievalOutcome(db, { actionId, registry: chain.registry, now: clock })).toMatchObject({ status: "RECORDED", action: { revision: retried.outcome.action.revision } });
  });

  it("records a pending outcome on the next reconciliation pass, without the buyer acting again", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    expect((await acknowledge(setup, digest, { registry: unavailable() })).outcome).toMatchObject({ status: "PENDING" });
    const failed = await reconcilePending({ db, rail: undefined, registry: unavailable(), now: clock, requiredLevel: "FINAL" });
    expect(failed.outcomes).toEqual([{ actionId, error: "Error: rpc unavailable" }]);
    const run = await reconcilePending({ db, rail: undefined, registry: chain.registry, now: clock, requiredLevel: "FINAL" });
    expect(run.outcomes).toEqual([{ actionId, result: expect.objectContaining({ status: "RECORDED" }) }]);
    expect(getRecoveryAction(db, actionId)?.state).toBe("COMPLETED");
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
    expect((await reconcilePending({ db, rail: undefined, registry: chain.registry, now: clock, requiredLevel: "FINAL" })).outcomes).toEqual([]);
  });

  it("refuses to complete when the registry already recorded a different outcome, before moving anything", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    const unreadable = withReadCase(() => {
      throw new Error("rpc unavailable");
    });
    expect((await acknowledge(setup, digest, { registry: unreadable })).outcome).toMatchObject({ status: "PENDING", action: { state: "DELIVERY_ACKED" } });
    await chain.registry.completeRetrieval(getRecoveryAction(db, actionId)?.proposal.caseKey ?? "", digest, "e".repeat(64));
    expect(await refusal(recordRetrievalOutcome(db, { actionId, registry: chain.registry, now: clock }))).toMatchObject({ code: "REGISTRY_OUTCOME_MISMATCH" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("DELIVERY_ACKED");
    expect(getCase(db, setup.caseId)?.status).toBe("DELIVERY_ACKED");
  });

  it("refuses to complete when a concurrent write recorded a different outcome first", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    const raced = withCompletion(async (caseKey, artifactSha256, acknowledgement) => {
      await chain.registry.completeRetrieval(caseKey, artifactSha256, "e".repeat(64));
      return chain.registry.completeRetrieval(caseKey, artifactSha256, acknowledgement);
    });
    expect((await acknowledge(setup, digest, { registry: raced })).outcome).toMatchObject({ status: "PENDING", reason: expect.stringMatching(/different retrieval outcome/) });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RECORD_PENDING");
  });

  it("reports a refused write when the registry did not record the outcome", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    const refused = withCompletion(async () => Promise.reject(new RegistryRevertError("InvalidTerms")));
    expect((await acknowledge(setup, digest, { registry: refused })).outcome).toMatchObject({ status: "PENDING", reason: "Registry reverted: InvalidTerms" });
    await expect(recordRetrievalOutcome(db, { actionId, registry: refused, now: clock })).rejects.toThrow("InvalidTerms");
    expect(getRecoveryAction(db, actionId)?.state).toBe("RECORD_PENDING");
  });

  it("records only against the registry case its proposal registered", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    await acknowledge(setup, digest, { registry: unavailable() });
    const record = (registry: typeof chain.registry) => refusal(recordRetrievalOutcome(db, { actionId, registry, now: clock }));
    expect(await record(withReadCase(() => undefined))).toMatchObject({ code: "REGISTRY_TERMS_MISMATCH", message: expect.stringMatching(/holds no case/) });
    expect(await record(withReadCase((onChain) => onChain && { ...onChain, evidenceDigest: "d".repeat(64) }))).toMatchObject({ code: "REGISTRY_TERMS_MISMATCH", message: expect.stringMatching(/evidence digest/) });
    expect(await record(withReadCase((onChain) => onChain && { ...onChain, state: "OPEN" }))).toMatchObject({ code: "REGISTRY_TERMS_MISMATCH", message: expect.stringMatching(/OPEN, not reserved/) });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RECORD_PENDING");
  });

  it("completes once when two attempts record the outcome at the same time", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    await acknowledge(setup, digest, { registry: unavailable() });
    const outcomes = await Promise.all([1, 2].map(() => recordRetrievalOutcome(db, { actionId, registry: chain.registry, now: clock })));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["RECORDED", "RECORDED"]);
    expect(actionEvents(actionId).filter((type) => type === "RECOVERY_RETRIEVAL_RECORDED")).toHaveLength(1);
    expect(getCase(db, setup.caseId)?.status).toBe("RECOVERED");
  });

  it("records nothing for a quarantined case", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    await retrieve(setup);
    await acknowledge(setup, digest, { registry: unavailable() });
    quarantine(setup.caseId);
    expect(await refusal(recordRetrievalOutcome(db, { actionId, registry: chain.registry, now: clock }))).toMatchObject({ code: "CASE_NOT_READY" });
    expect((await chain.registry.readCase(getRecoveryAction(db, actionId)?.proposal.caseKey ?? ""))?.state).toBe("RESERVED_RETRIEVE");
  });
});

describe("registry configuration", () => {
  it("refuses every step without the registry or with another deployment", async () => {
    const { setup, actionId, digest } = await reservedRetrieval();
    expect(await refusal(retrieve(setup, { registry: undefined }))).toMatchObject({ code: "REGISTRY_REQUIRED" });
    expect(otherChain.registry.address).toBe(chain.registry.address);
    expect(await refusal(retrieve(setup, { registry: otherChain.registry }))).toMatchObject({ code: "WRONG_REGISTRY" });
    const elsewhere = Object.create(chain.registry, { address: { value: "0x00000000000000000000000000000000000000e1" } }) as typeof chain.registry;
    expect(await refusal(retrieve(setup, { registry: elsewhere }))).toMatchObject({ code: "WRONG_REGISTRY" });
    await retrieve(setup);
    expect(await refusal(acknowledge(setup, digest, { registry: undefined }))).toMatchObject({ code: "REGISTRY_REQUIRED" });
    expect(await refusal(acknowledge(setup, digest, { registry: otherChain.registry }))).toMatchObject({ code: "WRONG_REGISTRY" });
    expect(await refusal(recordRetrievalOutcome(db, { actionId, registry: otherChain.registry, now: clock }))).toMatchObject({ code: "WRONG_REGISTRY" });
    expect(await refusal(ensureRegistered(db, { actionId, registry: otherChain.registry, now: clock }))).toMatchObject({ code: "WRONG_REGISTRY" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("EXECUTION_REQUESTED");
  });

  it("confirms a repayment reservation only against the registry its proposal names", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case");
    const { action } = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: clock });
    const reservation = `0x${"1".repeat(64)}`;
    expect(await refusal(confirmRepaymentReservation(db, { actionId: action.id, txHash: reservation, registry: otherChain.registry, now: clock }))).toMatchObject({
      code: "WRONG_REGISTRY",
    });
    expect(await refusal(ensureRegistered(db, { actionId: action.id, registry: otherChain.registry, now: clock }))).toMatchObject({ code: "WRONG_REGISTRY" });
    expect(getRecoveryAction(db, action.id)?.state).toBe("PREPARED");
  });
});

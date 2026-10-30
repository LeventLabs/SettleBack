import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSimulatedAdapters, eip3009TypedData, signSimulatedPayload, type GatewayFault, type SimulatedAdapters } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import { readCaseEvidence } from "../../src/db/cases.ts";
import { DemoPurchases, RESPONSE_DEADLINE_MS, type PurchaseScenario } from "../../src/demo/purchases.ts";
import { executePayment } from "../../src/payments/execution.ts";
import { quoteForBuyer, requestPaymentSignature, submitPaymentSignature, type BuyerPaymentAgent } from "../../src/payments/purchase.ts";
import { simulatedPurchasePayments } from "../../src/payments/purchase-payments.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { TOKEN, memoryDatabase } from "../db/helpers.ts";
import { TERMS, registerFixturePolicies } from "../recovery/helpers.ts";

const buyer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"a1".repeat(32)}`).address.toLowerCase() as Address;
const stranger = privateKeyToAccount(`0x${"c3".repeat(32)}`).address.toLowerCase();
const source = loadSources()[0];
const policy = TERMS.get("extraction-delivery-v1");
if (source === undefined || policy === undefined) throw new Error("fixtures missing");

let db: DatabaseSync;
let sim: SimulatedAdapters;
let purchases: DemoPurchases;
let buyerAgent: BuyerPaymentAgent;
let keys = 0;

function agent(overrides: Partial<BuyerPaymentAgent["policy"]> = {}): BuyerPaymentAgent {
  return {
    rail: sim.rail,
    merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
    policy: { payeeAllowlist: [seller], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", maxFeeBaseUnits: "100000", usdRate: "1", ...overrides },
    deploymentId: "local-demo",
    coin: "USDC",
    label: "Structured extraction job",
  };
}

function demoPurchases(using: BuyerPaymentAgent = agent()): DemoPurchases {
  buyerAgent = using;
  return new DemoPurchases(db, {
    seller,
    payments: simulatedPurchasePayments(using, { chainId: 133, token: TOKEN as Address, tokenDecimals: 6 }),
    source: { id: source!.id, text: loadSourceBytes(source!).toString("utf8"), sha256: source!.sourceSha256 },
    policy: { id: policy!.id, sha256: policy!.sha256 },
    now: () => sim.clock.now(),
  });
}

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
  sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret", start: "2026-10-30T09:00:00.000Z" });
  purchases = demoPurchases();
});

afterEach(() => db.close());

function key(): string {
  keys += 1;
  return `purchase-key-${String(keys).padStart(8, "0")}`;
}

/** Buys a job and pays it from the buyer's wallet, through the gateway simulator, to a verified payment. */
async function paid(scenario: PurchaseScenario): Promise<string> {
  const record = await purchases.create({ buyer: buyer.address, scenario, idempotencyKey: key() });
  const requested = await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() });
  if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected a mandate");
  const signature = await buyer.signTypedData(eip3009TypedData(requested.payload));
  expect((await submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature, agent: buyerAgent })).status).toBe("SUBMITTED");
  for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
  await reconcile();
  expect(purchases.attempt(record.operationId)?.state).toBe("VERIFIED");
  return record.operationId;
}

function reconcile() {
  return reconcilePending({ db, rail: sim.rail, registry: undefined, now: () => sim.clock.now(), requiredLevel: "FINAL" });
}

async function after(ms: number): Promise<void> {
  sim.clock.advance(ms);
  await purchases.tick();
}

function kinds(operationId: string): string[] {
  return purchases.get(operationId)?.events.map((event) => event.kind) ?? [];
}

function evidence(operationId: string) {
  const caseId = purchases.get(operationId)?.caseId;
  if (caseId === undefined) throw new Error("no case");
  return readCaseEvidence(db, caseId);
}

describe("buying a job from the workspace", () => {
  it("quotes with every Payment Agent check reported, and the same key returns the same purchase", async () => {
    const purchaseKey = key();
    const first = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: purchaseKey });
    expect(first.quote?.grossLimitBaseUnits).toBe("1100000");
    expect(first.checks).toHaveLength(12);
    expect(new Set(first.checks.map((check) => check.status))).toEqual(new Set(["passed"]));
    const again = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: purchaseKey });
    expect(again.operationId).toBe(first.operationId);
    expect(Number(db.prepare("SELECT count(*) AS n FROM payment_attempts").get()?.n)).toBe(1);
    // A scenario is bound before anything is signed; another one is another job.
    await expect(purchases.create({ buyer: buyer.address, scenario: "job-fails", idempotencyKey: purchaseKey })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(purchases.create({ buyer: seller, scenario: "response-lost", idempotencyKey: key() })).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
  });

  it("blocks signing when a check fails, and says which one and why", async () => {
    purchases = demoPurchases(agent({ perPaymentCapBaseUnits: "500000" }));
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    expect(record.checks.find((check) => check.id === "per-payment-cap")).toMatchObject({ status: "blocked", reason: "the gross amount exceeds the per-payment cap" });
    await expect(requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() })).rejects.toMatchObject({ code: "CART_REJECTED" });
    expect(purchases.attempt(record.operationId)?.state).toBe("PREPARED");
  });

  it("counts authorized payments against today's cap, but not quotes that were never authorized", async () => {
    // Each payment counts as its price plus the maximum fee: 1.10 + 1.10 exceeds 2.15, while 1.00 + 1.10 would not.
    purchases = demoPurchases(agent({ dailyCapBaseUnits: "2150000" }));
    await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    const quotedOnly = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    expect(quotedOnly.checks.find((check) => check.id === "daily-cap")?.status).toBe("passed");
    await paid("response-lost");
    const over = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    expect(over.checks.find((check) => check.id === "daily-cap")).toMatchObject({ status: "blocked", reason: "the gross amount would exceed today's cap" });
  });

  it("answers concurrent authorization requests with the one mandate, and refuses a signature before one was requested", async () => {
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    await expect(submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature: `0x${"11".repeat(65)}`, agent: buyerAgent })).rejects.toMatchObject({ code: "ATTEMPT_NOT_EXECUTABLE" });
    const results = await Promise.all(Array.from({ length: 5 }, () => requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() })));
    const payloads = results.map((result) => (result.status === "SIGNATURE_REQUIRED" ? JSON.stringify(result.payload) : result.status));
    expect(new Set(payloads).size).toBe(1);
    expect(payloads[0]).not.toBe("ALREADY_REQUESTED");
    expect(Number(db.prepare("SELECT count(*) AS n FROM execution_permits").get()?.n)).toBe(1);
  });

  it("lets only the buyer authorize, offers one mandate, and submits one payment however often it is sent", async () => {
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    const ask = (who: string) => requestPaymentSignature(db, { operationId: record.operationId, buyer: who, agent: buyerAgent, now: () => sim.clock.now() });
    await expect(ask(stranger)).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    await expect(quoteForBuyer(db, { operationId: record.operationId, buyer: stranger, agent: buyerAgent, now: () => sim.clock.now() })).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    const first = await ask(buyer.address);
    const second = await ask(buyer.address);
    if (first.status !== "SIGNATURE_REQUIRED" || second.status !== "SIGNATURE_REQUIRED") throw new Error("expected a mandate");
    expect(second.payload).toEqual(first.payload);
    expect(first.payload.authorization).toMatchObject({ from: buyer.address.toLowerCase(), to: seller, value: "1000000" });
    const signature = await buyer.signTypedData(eip3009TypedData(first.payload));
    const forged = await privateKeyToAccount(`0x${"c3".repeat(32)}`).signTypedData(eip3009TypedData(first.payload));
    await expect(submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature: forged, agent: buyerAgent })).rejects.toMatchObject({ code: "MANDATE_SIGNATURE_INVALID" });
    const results = await Promise.all(Array.from({ length: 10 }, () => submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature, agent: buyerAgent })));
    expect(results.filter((result) => result.status === "SUBMITTED")).toHaveLength(1);
    expect(results.filter((result) => result.status === "ALREADY_REQUESTED")).toHaveLength(9);
  });

  it("does not offer a wallet a mandate that was claimed for a server-side signer", async () => {
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    const { attempt, validation } = await quoteForBuyer(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() });
    if (!validation.ok) throw new Error("expected a valid quote");
    const signer = { provenance: "SIMULATED" as const, sign: async (payload: Parameters<typeof signSimulatedPayload>[0]) => signSimulatedPayload(payload) };
    expect((await executePayment(db, { attemptId: attempt.id, requestedBy: buyer.address, cart: validation.cart, signer, rail: sim.rail, now: () => sim.clock.now() })).status).toBe("SUBMITTED");
    expect((await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() })).status).toBe("ALREADY_REQUESTED");
  });

  it("starts the job only once the payment is verified", async () => {
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    const requested = await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() });
    if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected a mandate");
    await submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature: await buyer.signTypedData(eip3009TypedData(requested.payload)), agent: buyerAgent });
    await after(1_000);
    expect(purchases.get(record.operationId)?.run).toBeUndefined();
    for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
    await reconcile();
    await after(1_000);
    expect(kinds(record.operationId)).toEqual(["payment-verified", "job-started"]);
    // Once paid, asking again authorizes nothing new, and the same purchase key returns the same purchase.
    expect((await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() })).status).toBe("ALREADY_REQUESTED");
  });

  it("returns the same purchase for its key after the payment, without quoting again", async () => {
    const purchaseKey = key();
    const record = await purchases.create({ buyer: buyer.address, scenario: "succeeds", idempotencyKey: purchaseKey });
    const requested = await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() });
    if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected a mandate");
    await submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature: await buyer.signTypedData(eip3009TypedData(requested.payload)), agent: buyerAgent });
    expect((await purchases.create({ buyer: buyer.address, scenario: "succeeds", idempotencyKey: purchaseKey })).operationId).toBe(record.operationId);
  });

  it("never starts the job when the payment's outcome is unknown", async () => {
    const record = await purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
    const requested = await requestPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, agent: buyerAgent, now: () => sim.clock.now() });
    if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected a mandate");
    sim.gateway.injectFault(requested.payload.paymentRequestId, { kind: "wrong-receipt", field: "amount" } satisfies GatewayFault);
    await submitPaymentSignature(db, { operationId: record.operationId, buyer: buyer.address, signature: await buyer.signTypedData(eip3009TypedData(requested.payload)), agent: buyerAgent });
    for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
    await reconcile();
    expect(purchases.attempt(record.operationId)?.state).toBe("UNKNOWN");
    await after(RESPONSE_DEADLINE_MS * 2);
    expect(kinds(record.operationId)).toEqual(["payment-unknown"]);
    expect(purchases.get(record.operationId)?.run).toBeUndefined();
    expect(purchases.get(record.operationId)?.caseId).toBeUndefined();
  });

  it("opens the case at the deadline when the response was lost, with the records showing the job completed", async () => {
    const operationId = await paid("response-lost");
    // The job starts on this pass; the deadline is twelve seconds later.
    await after(1_000);
    await after(RESPONSE_DEADLINE_MS - 1_000);
    expect(purchases.get(operationId)?.caseId).toBeUndefined();
    await after(1_000);
    expect(kinds(operationId)).toEqual(["payment-verified", "job-started", "deadline-passed", "case-opened"]);
    const { items } = evidence(operationId);
    const sources = items.map((item) => item.source);
    expect(sources).toEqual(expect.arrayContaining(["policy", "gateway-record", "edge-log", "worker-log", "service-status", "artifact-store"]));
    expect(items.find((item) => item.source === "edge-log")?.content).toMatch(/ 499 /);
    // The edge wrote 499 because the buyer's connection was gone: the buyer received no response.
    expect(purchases.get(operationId)?.response).toBeUndefined();
    expect(items.find((item) => item.source === "service-status")?.content).toMatch(/"COMPLETED"/);
    // The scenario is never evidence.
    expect(items.filter((item) => /response-lost|Response lost after completion|scenario/i.test(item.content ?? "")).map((item) => item.source)).toEqual([]);
  });

  it("opens the case on the error response when the job fails, before the deadline", async () => {
    const operationId = await paid("job-fails");
    await after(1_000);
    await after(4_500);
    expect(kinds(operationId)).toEqual(["payment-verified", "job-started", "error-response", "case-opened"]);
    expect(evidence(operationId).items.find((item) => item.source === "edge-log")?.content).toMatch(/ 502 /);
  });

  it("adds records written after the deadline to the same case", async () => {
    const operationId = await paid("finishes-late");
    await after(1_000);
    await after(RESPONSE_DEADLINE_MS);
    const caseId = purchases.get(operationId)?.caseId;
    const opened = evidence(operationId).case.evidence.revision;
    expect(evidence(operationId).items.find((item) => item.source === "artifact-store")?.content).toBe("[]");
    await after(5_000);
    expect(purchases.get(operationId)?.caseId).toBe(caseId);
    expect(kinds(operationId)).toContain("records-updated");
    expect(evidence(operationId).case.evidence.revision).toBeGreaterThan(opened);
    expect(evidence(operationId).items.filter((item) => item.source === "artifact-store").some((item) => item.content !== "[]")).toBe(true);
    // Nothing changes later, so nothing more is added.
    const settled = evidence(operationId).case.evidence.revision;
    await after(5_000);
    expect(evidence(operationId).case.evidence.revision).toBe(settled);
    expect(purchases.get(operationId)?.done).toBe(false);
    await after(60_000);
    expect(purchases.get(operationId)?.done).toBe(true);
  });

  it("delivers a normal run and opens no case", async () => {
    const operationId = await paid("succeeds");
    await after(1_000);
    await after(6_000);
    expect(kinds(operationId)).toEqual(["payment-verified", "job-started", "delivered"]);
    expect(purchases.get(operationId)?.caseId).toBeUndefined();
    await after(RESPONSE_DEADLINE_MS);
    expect(purchases.get(operationId)?.caseId).toBeUndefined();
  });
});

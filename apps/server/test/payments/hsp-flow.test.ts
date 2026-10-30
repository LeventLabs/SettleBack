import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ManualClock, type ChainTransfer } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import { openDatabase } from "../../src/db/database.ts";
import { DemoPurchases, type PurchaseRecord } from "../../src/demo/purchases.ts";
import { hspPurchasePayments } from "../../src/payments/purchase-payments.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { TERMS, registerFixturePolicies } from "../recovery/helpers.ts";
import { FakeHsp } from "./fake-hsp.ts";

const buyer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const BUYER = buyer.address.toLowerCase();
const seller = privateKeyToAccount(`0x${"a1".repeat(32)}`).address.toLowerCase() as Address;
const stranger = privateKeyToAccount(`0x${"c3".repeat(32)}`).address.toLowerCase();
const source = loadSources()[0];
const policy = TERMS.get("extraction-delivery-v1");
if (source === undefined || policy === undefined) throw new Error("fixtures missing");

let db: DatabaseSync;
let clock: ManualClock;
let hsp: FakeHsp;
let purchases: DemoPurchases;
let wrongNonce: boolean;
let keys = 0;

/** The payment chain as it would look after HSP's gateway executed the last prepared authorization. */
const transfers = {
  async transfer(txHash: string, expect: { from: string; to: string }): Promise<ChainTransfer | null> {
    const order = [...hsp.orders.values()].find((entry) => entry.tx === txHash);
    if (order === undefined) return null;
    const executed = hsp.lastPrepared(order.paymentRequestId);
    return { txHash, chainId: 133, token: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6", from: expect.from, to: expect.to, amountBaseUnits: executed.value, blockNumber: 10, confirmations: 6, status: "success", authorizationNonce: wrongNonce ? `0x${"00".repeat(32)}` : executed.nonce };
  },
};

beforeEach(() => {
  db = openDatabase({ path: ":memory:", environment: "testnet" });
  registerFixturePolicies(db);
  clock = new ManualClock(new Date().toISOString());
  hsp = new FakeHsp(clock);
  wrongNonce = false;
  purchases = new DemoPurchases(db, {
    seller,
    payments: hspPurchasePayments({
      rail: hsp.rail(transfers),
      limits: { payeeAllowlist: [seller], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", maxFeeBaseUnits: "100000" },
      deploymentId: "hsp-test",
      label: "Structured extraction job",
    }),
    source: { id: source.id, text: loadSourceBytes(source).toString("utf8"), sha256: source.sourceSha256 },
    policy: { id: policy.id, sha256: policy.sha256 },
    now: () => clock.now(),
  });
});

afterEach(() => db.close());

function key(): string {
  keys += 1;
  return `hsp-purchase-${String(keys).padStart(8, "0")}`;
}

async function bought(): Promise<PurchaseRecord> {
  return purchases.create({ buyer: buyer.address, scenario: "response-lost", idempotencyKey: key() });
}

async function typedDataFor(record: PurchaseRecord): Promise<unknown> {
  const requested = await purchases.requestSignature(record, buyer.address);
  if (requested.status !== "SIGNATURE_REQUIRED") throw new Error(`expected an authorization to sign, got ${requested.status}`);
  return requested.typedData;
}

const sign = (typedData: unknown, account = buyer) => account.signTypedData(typedData as never);
const reconcile = () => reconcilePending({ db, rail: purchases.payments.observer, registry: undefined, now: () => clock.now(), requiredLevel: "FINAL" });
const count = (tool: string) => hsp.calls.filter((call) => call === tool).length;

describe("buying a job paid through HSP Agentic Payment", () => {
  it("orders through HSP, checks HSP's authorization before the wallet signs, submits it once, and verifies the executed transfer on chain", async () => {
    const record = await bought();
    const attempt = purchases.attempt(record.operationId);
    expect(attempt).toMatchObject({ state: "PREPARED", flowId: `flow-${attempt?.paymentRequestId}` });
    expect(record.quote).toMatchObject({ merchantName: "SettleBack", flowId: attempt?.flowId, grossLimitBaseUnits: "1100000" });
    // Before HSP prepares the authorization, only the buyer's limits can be checked.
    expect(record.checks.filter((check) => check.status === "passed").map((check) => check.id)).toEqual(["payee-allowlist", "per-payment-cap", "daily-cap"]);
    expect(record.checks.filter((check) => check.status === "not-checked")).toHaveLength(8);

    const typedData = await typedDataFor(record);
    expect(record.checks.every((check) => check.status === "passed")).toBe(true);
    expect(record.authorization).toMatchObject({ recipient: seller, payer: BUYER, amountBaseUnits: "1000000", preparedBy: "hsp" });
    expect(await typedDataFor(record)).toEqual(typedData);
    expect(count("prepare_payment")).toBe(1);

    await expect(purchases.submitSignature(record, buyer.address, await sign(typedData, privateKeyToAccount(`0x${"c3".repeat(32)}`)))).rejects.toMatchObject({ code: "MANDATE_SIGNATURE_INVALID" });
    expect(purchases.attempt(record.operationId)?.state).toBe("PREPARED");
    expect(count("finalize_payment")).toBe(0);

    const signature = await sign(typedData);
    expect(await purchases.submitSignature(record, buyer.address, signature)).toEqual({ status: "SUBMITTED" });
    expect(await purchases.submitSignature(record, buyer.address, signature)).toEqual({ status: "ALREADY_REQUESTED" });
    expect([count("finalize_payment"), count("submit_payment")]).toEqual([1, 1]);
    expect(purchases.attempt(record.operationId)?.state).toBe("SIGNING_REQUESTED");

    await reconcile();
    expect(purchases.attempt(record.operationId)?.state).toBe("SUBMITTED");
    hsp.settle(purchases.attempt(record.operationId)?.paymentRequestId ?? "", "payment-finalized");
    await reconcile();
    const verified = purchases.attempt(record.operationId);
    expect(verified?.state).toBe("VERIFIED");
    expect(verified?.txHash).toBe(hsp.orders.get(verified?.paymentRequestId ?? "")?.tx);
    await purchases.tick();
    expect(purchases.get(record.operationId)?.events.map((event) => event.kind)).toEqual(["payment-verified", "job-started"]);
  });

  it("accepts a network fee inside the authorization up to the buyer's maximum and verifies exactly the authorized amount", async () => {
    hsp.feeBaseUnits = 50_000n;
    const record = await bought();
    const typedData = await typedDataFor(record);
    expect(record.authorization?.amountBaseUnits).toBe("1050000");
    await purchases.submitSignature(record, buyer.address, await sign(typedData));
    hsp.settle(purchases.attempt(record.operationId)?.paymentRequestId ?? "", "payment-finalized");
    await reconcile();
    expect(purchases.attempt(record.operationId)?.state).toBe("VERIFIED");

    hsp.feeBaseUnits = 100_001n;
    const over = await bought();
    expect(await purchases.requestSignature(over, buyer.address)).toMatchObject({ status: "REFUSED" });
    expect(over.checks.find((check) => check.id === "amount")).toMatchObject({ status: "blocked" });
    expect(purchases.attempt(over.operationId)?.state).toBe("PREPARED");
    expect(Number(db.prepare("SELECT count(*) AS n FROM payment_offers WHERE attempt_id = ?").get(purchases.attempt(over.operationId)?.id ?? "")?.n)).toBe(0);
  });

  it("refuses an authorization that pays anyone but the seller, and says which check blocked it", async () => {
    const record = await bought();
    hsp.tamper = { to: stranger };
    expect(await purchases.requestSignature(record, buyer.address)).toMatchObject({ status: "REFUSED" });
    expect(record.checks.filter((check) => check.status === "blocked").map((check) => check.id)).toEqual(["recipient", "payee-allowlist"]);
    expect(count("finalize_payment")).toBe(0);
  });

  it("refuses a signature too close to the quote's expiry, then prepares a new authorization the old signature cannot pay", async () => {
    const record = await bought();
    const first = await typedDataFor(record);
    const oldSignature = await sign(first);
    clock.advance(4 * 60_000 + 45_000);
    await expect(purchases.submitSignature(record, buyer.address, oldSignature)).rejects.toMatchObject({ code: "CART_REJECTED" });
    expect(count("finalize_payment")).toBe(0);

    const second = await typedDataFor(record);
    expect(second).not.toEqual(first);
    expect(count("prepare_payment")).toBe(2);
    await expect(purchases.submitSignature(record, buyer.address, oldSignature)).rejects.toMatchObject({ code: "MANDATE_SIGNATURE_INVALID" });
    expect(await purchases.submitSignature(record, buyer.address, await sign(second))).toEqual({ status: "SUBMITTED" });
    expect(count("submit_payment")).toBe(1);
  });

  it("leaves a lost submission to reconciliation and never prepares, signs, or submits that payment again", async () => {
    const record = await bought();
    const typedData = await typedDataFor(record);
    hsp.loseNextSubmit = true;
    expect(await purchases.submitSignature(record, buyer.address, await sign(typedData))).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(purchases.attempt(record.operationId)?.state).toBe("SIGNING_REQUESTED");
    expect(await purchases.requestSignature(record, buyer.address)).toEqual({ status: "ALREADY_REQUESTED" });
    expect(await purchases.submitSignature(record, buyer.address, await sign(typedData))).toEqual({ status: "ALREADY_REQUESTED" });
    expect([count("prepare_payment"), count("submit_payment")]).toEqual([1, 1]);

    hsp.settle(purchases.attempt(record.operationId)?.paymentRequestId ?? "", "payment-finalized");
    await reconcile();
    expect(purchases.attempt(record.operationId)?.state).toBe("VERIFIED");
  });

  it("does not count a transfer as paid when the transaction executed a different authorization", async () => {
    const record = await bought();
    await purchases.submitSignature(record, buyer.address, await sign(await typedDataFor(record)));
    hsp.settle(purchases.attempt(record.operationId)?.paymentRequestId ?? "", "payment-finalized");
    wrongNonce = true;
    const run = await reconcile();
    expect(run.attempts[0]?.result?.verdict).toBe("MISMATCH");
    expect(purchases.attempt(record.operationId)?.state).toBe("UNKNOWN");
    await purchases.tick();
    expect(purchases.get(record.operationId)?.events.map((event) => event.kind)).toEqual(["payment-unknown"]);
  });

  it("lets only the buyer authorize its purchase", async () => {
    const record = await bought();
    await expect(purchases.requestSignature(record, stranger)).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    await expect(purchases.create({ buyer: seller, scenario: "response-lost", idempotencyKey: key() })).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
  });
});

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProvenanceViolationError,
  RailUnavailableError,
  buildSimulatedPaymentMandate,
  createSimulatedAdapters,
  signSimulatedPayload,
  submitPaymentMandate,
  validateCartMandate,
  verifySettlement,
  type CartMandate,
  type PaymentRail,
  type SimulatedAdapters,
  type ValidateCartInput,
} from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { openDatabase } from "../../src/db/database.ts";
import { createOperation } from "../../src/db/operations.ts";
import { quoteOperation, type QuoteInput } from "../../src/payments/quote.ts";
import { BUYER, NOW, SELLER, TOKEN, memoryDatabase, sampleIntent, seedOperation, seedPolicy } from "../db/helpers.ts";

let db: DatabaseSync;
let sim: SimulatedAdapters;
let operationId: string;

beforeEach(() => {
  db = memoryDatabase();
  sim = createSimulatedAdapters({ environment: "local", verifier: "0x00000000000000000000000000000000000000f0", webhookSecret: "app-secret" });
  operationId = seedOperation(db);
});

afterEach(() => {
  db.close();
});

function quoteInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return { operationId, rail: sim.rail, deploymentId: "local-registry", coin: "USDC", label: "Structured extraction job", now: () => sim.clock.now(), ...overrides };
}

function attempts() {
  return db.prepare("SELECT id, state, cart_mandate_id, payment_request_id, cart_sha256, revision FROM payment_attempts WHERE operation_id = ?").all(operationId);
}

/** The buyer's Payment Agent: the merchant key and limits it pinned, and the intent it agreed to. */
function buyerCheck(cartMandate: unknown, ids: { cartMandateId: string; paymentRequestId: string }, overrides: Partial<ValidateCartInput> = {}) {
  return validateCartMandate({
    cartMandate,
    merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
    intent: { ...ids, payee: SELLER as Address, chainId: 133, token: TOKEN as Address, tokenDecimals: 6, priceUsd: "1.00" },
    policy: { payeeAllowlist: [SELLER as Address], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0", maxFeeBaseUnits: "100000", usdRate: "1" },
    now: sim.clock.now(),
    ...overrides,
  });
}

describe("A2A payment through the simulated gateway", () => {
  it("quotes, validates, signs once, settles, and verifies against the chain", async () => {
    const quote = await quoteOperation(db, quoteInput());
    expect(attempts()).toEqual([
      expect.objectContaining({ state: "PREPARED", cart_mandate_id: quote.cartMandateId, payment_request_id: quote.paymentRequestId, cart_sha256: quote.cartSha256, revision: 1 }),
    ]);

    const validation = buyerCheck(quote.cartMandate, quote);
    if (!validation.ok) throw new Error(validation.rejections.map((entry) => entry.message).join("; "));
    expect(await submitPaymentMandate(sim.rail, signSimulatedPayload(buildSimulatedPaymentMandate(validation.cart, BUYER as Address)))).toBe("SUBMITTED");

    for (let tick = 0; tick < 5; tick += 1) sim.gateway.tick();
    const observation = await sim.rail.observe(quote.paymentRequestId);
    const verdict = verifySettlement({
      expected: { payer: BUYER as Address, payee: SELLER as Address, chainId: 133, token: TOKEN as Address, amountBaseUnits: "1000000" },
      tokenDecimals: 6,
      record: observation.record,
      transfer: observation.transfer,
      requiredLevel: "FINAL",
    });
    expect(verdict.status).toBe("VERIFIED");
    expect(observation.record).toMatchObject({ cart_mandate_id: quote.cartMandateId, product_amount: "1.00", pay_amount: "1.01", usd_amount_rate: "1" });
  });

  it("answers a repeated quote from the same attempt and order", async () => {
    const first = await quoteOperation(db, quoteInput());
    const second = await quoteOperation(db, quoteInput());
    expect(second).toMatchObject({ attemptId: first.attemptId, cartSha256: first.cartSha256, recovered: true });
    expect(attempts()).toHaveLength(1);
    expect(sim.gateway.orderCount()).toBe(1);
    expect(buyerCheck(second.cartMandate, second).ok).toBe(true);
  });

  it("recovers a lost order response by querying the stored identifiers", async () => {
    sim.gateway.injectFault(`pr-fixed-id`, { kind: "lose-create-response" });
    const quote = await quoteOperation(db, quoteInput({ newId: () => "fixed-id" }));
    expect(quote).toMatchObject({ paymentRequestId: "pr-fixed-id", recovered: true });
    expect(attempts()).toEqual([expect.objectContaining({ state: "PREPARED" })]);
    expect(sim.gateway.orderCount()).toBe(1);
  });

  it("keeps the identifiers when the gateway cannot be reached, and prepares the same attempt later", async () => {
    const down: PaymentRail = { ...sim.rail, provenance: "SIMULATED", prepare: async () => Promise.reject(new RailUnavailableError("create order")), submit: sim.rail.submit.bind(sim.rail), observe: sim.rail.observe.bind(sim.rail) };
    await expect(quoteOperation(db, quoteInput({ rail: down }))).rejects.toBeInstanceOf(RailUnavailableError);
    const [stored] = attempts();
    expect(stored).toMatchObject({ state: "CREATED", cart_sha256: null });
    const quote = await quoteOperation(db, quoteInput());
    expect(quote.attemptId).toBe(stored?.id);
    expect(attempts()).toEqual([expect.objectContaining({ state: "PREPARED", payment_request_id: stored?.payment_request_id })]);
  });

  it("rejects an altered cart before anything is signed or sent", async () => {
    const quote = await quoteOperation(db, quoteInput());
    const altered: CartMandate = structuredClone(quote.cartMandate);
    const method = altered.contents.payment_request.method_data[0];
    if (method === undefined) throw new Error("no payment option");
    method.data.pay_to = "0x00000000000000000000000000000000000000c1";
    const validation = buyerCheck(altered, quote);
    expect(validation.ok).toBe(false);
    expect(validation.ok ? [] : validation.rejections.map((entry) => entry.code)).toEqual(expect.arrayContaining(["MERCHANT_SIGNATURE", "NO_MATCHING_OPTION"]));
    expect((await sim.rail.observe(quote.paymentRequestId)).record.status).toBe("payment-required");
  });

  it("will not quote an attempt that has moved past preparation", async () => {
    const quote = await quoteOperation(db, quoteInput());
    db.prepare("UPDATE payment_attempts SET state = 'SIGNING_REQUESTED', revision = revision + 1 WHERE id = ?").run(quote.attemptId);
    await expect(quoteOperation(db, quoteInput())).rejects.toMatchObject({ code: "ATTEMPT_NOT_QUOTABLE" });
  });

  it("refuses a simulated rail for an operation in a live environment", async () => {
    const testnet = openDatabase({ path: ":memory:", environment: "testnet", now: () => NOW });
    try {
      const policySha256 = seedPolicy(testnet);
      const { operation } = createOperation(testnet, { actor: BUYER, idempotencyKey: "op-key-testnet", intent: sampleIntent(policySha256), environment: "testnet", now: NOW });
      await expect(quoteOperation(testnet, quoteInput({ operationId: operation.id }))).rejects.toBeInstanceOf(ProvenanceViolationError);
      expect(testnet.prepare("SELECT count(*) AS n FROM payment_attempts").get()?.n).toBe(0);
      expect(sim.gateway.orderCount()).toBe(0);
    } finally {
      testnet.close();
    }
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { Address, TransferTerms } from "@settleback/domain";
import {
  RailUnavailableError,
  WEBHOOK_RETRY_DELAYS_MS,
  buildSimulatedPaymentMandate,
  createSimulatedAdapters,
  signSimulatedPayload,
  submitPaymentMandate,
  validateCartMandate,
  verifySettlement,
  verifyWebhook,
  type PreparedPayment,
  type PrepareInput,
  type SignedPayload,
  type SimulatedAdapters,
} from "../src/index.ts";

const BUYER = "0x00000000000000000000000000000000000000b1" as Address;
const SELLER = "0x00000000000000000000000000000000000000a1" as Address;
const VERIFIER = "0x00000000000000000000000000000000000000f0" as Address;
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const SECRET = "sim-webhook-secret";

const order: PrepareInput = {
  cartMandateId: "cart-0001",
  paymentRequestId: "pr-0001",
  payee: SELLER,
  chainId: 133,
  token: TOKEN,
  coin: "USDC",
  tokenDecimals: 6,
  priceUsd: "1.00",
  label: "Structured extraction job",
  expiresAt: "2026-10-30T12:00:00Z",
};

const expected: TransferTerms = { payer: BUYER, payee: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" };

let sim: SimulatedAdapters;

beforeEach(() => {
  sim = createSimulatedAdapters({ environment: "local", verifier: VERIFIER, webhookSecret: SECRET });
});

/** The Payment Agent's side: validate the received Cart Mandate, then sign the mandate built from it. */
function signFor(prepared: PreparedPayment): SignedPayload {
  const validation = validateCartMandate({
    cartMandate: prepared.cartMandate,
    merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
    intent: order,
    policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0", maxFeeBaseUnits: "100000", usdRate: "1" },
    now: sim.clock.now(),
  });
  if (!validation.ok) throw new Error(validation.rejections.map((entry) => entry.code).join(", "));
  return signSimulatedPayload(buildSimulatedPaymentMandate(validation.cart, BUYER));
}

async function payOnce(): Promise<void> {
  await sim.rail.submit(signFor(await sim.rail.prepare(order)));
}

function ticks(count: number): void {
  for (let i = 0; i < count; i += 1) sim.gateway.tick();
}

async function verdict(level: "SAFE" | "FINAL" = "FINAL") {
  const observation = await sim.rail.observe(order.paymentRequestId);
  return verifySettlement({ expected, tokenDecimals: 6, record: observation.record, transfer: observation.transfer, requiredLevel: level });
}

describe("simulated gateway: normal payment", () => {
  it("moves through the documented statuses to a verified, finalized payment", async () => {
    await payOnce();
    const seen = [(await sim.rail.observe(order.paymentRequestId)).record.status];
    for (let i = 0; i < 5; i += 1) {
      sim.gateway.tick();
      seen.push((await sim.rail.observe(order.paymentRequestId)).record.status);
    }
    expect(seen).toEqual([
      "payment-submitted",
      "payment-verified",
      "payment-processing",
      "payment-included",
      "payment-safe",
      "payment-finalized",
    ]);
    expect(await verdict()).toEqual(expect.objectContaining({ status: "VERIFIED" }));
    const record = (await sim.rail.observe(order.paymentRequestId)).record;
    expect(record.order_amount).toBe("1.00");
    expect(record.pay_amount).toBe("1.01");
  });

  it("delivers signed webhooks that verify against the raw body", async () => {
    const received: string[] = [];
    sim.gateway.setWebhookReceiver((header, rawBody) => {
      const check = verifyWebhook(header, rawBody, SECRET, Math.floor(sim.clock.now().getTime() / 1000));
      if (!check.ok) return 401;
      received.push((JSON.parse(rawBody) as { status: string }).status);
      return 200;
    });
    await payOnce();
    ticks(5);
    await sim.gateway.deliverDueWebhooks();
    expect(received).toEqual(["payment-included", "payment-safe", "payment-finalized"]);
  });
});

describe("simulated gateway: faults", () => {
  it("recovers a lost create-order response without creating a second order", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "lose-create-response" });
    // The response is lost after the gateway created the order; prepare reads it back by the same IDs.
    const prepared = await sim.rail.prepare(order);
    expect(prepared).toMatchObject({ paymentRequestId: order.paymentRequestId, recovered: true, paymentUrl: null });
    expect(sim.gateway.orderCount()).toBe(1);
    // The recovered Cart Mandate hashes to the same contents, so the payment can proceed on the one order.
    await sim.rail.submit(signFor(prepared));
    expect((await sim.rail.observe(order.paymentRequestId)).kind).toBe("SUBMITTED");
  });

  it("refuses an order that reuses identifiers with different terms", async () => {
    await sim.rail.prepare(order);
    await expect(sim.rail.prepare({ ...order, priceUsd: "2.00" })).rejects.toMatchObject({ code: "ORDER_CONFLICT" });
  });

  it("after a lost submit response, observation shows the submission and a second submission is refused", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "lose-submit-response" });
    const signed = signFor(await sim.rail.prepare(order));
    expect(await submitPaymentMandate(sim.rail, signed)).toBe("SUBMITTED");
    expect((await sim.rail.observe(order.paymentRequestId)).kind).toBe("SUBMITTED");
    await expect(sim.rail.submit(signed)).rejects.toMatchObject({ code: "40001" });
  });

  it("reports a broadcast that never succeeded as failed without a transaction", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "broadcast-never-succeeds" });
    await payOnce();
    ticks(3);
    const observation = await sim.rail.observe(order.paymentRequestId);
    expect(observation.kind).toBe("FAILED_NO_TRANSACTION");
    expect(observation.record.status_reason).toMatch(/broadcast never succeeded/);
    expect((await verdict()).status).toBe("NO_TRANSFER_FOUND");
  });

  it("flags inclusion followed by failure as inconsistent", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "included-then-failed" });
    await payOnce();
    ticks(4);
    expect((await sim.rail.observe(order.paymentRequestId)).kind).toBe("FAILED_AFTER_INCLUSION");
    expect((await verdict()).status).toBe("INCONSISTENT");
  });

  it("holds a delayed finality at included for the extra ticks", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "delayed-finality", extraTicks: 3 });
    await payOnce();
    ticks(6);
    expect((await sim.rail.observe(order.paymentRequestId)).record.status).toBe("payment-included");
    expect((await verdict("SAFE")).status).toBe("PENDING");
    ticks(2);
    expect((await verdict()).status).toBe("VERIFIED");
  });

  it("never verifies a receipt with the wrong amount, payee, or token", async () => {
    for (const field of ["amount", "payee", "token"] as const) {
      sim = createSimulatedAdapters({ environment: "local", verifier: VERIFIER, webhookSecret: SECRET });
      sim.gateway.injectFault(order.paymentRequestId, { kind: "wrong-receipt", field });
      await payOnce();
      ticks(5);
      expect((await verdict()).status, field).toBe("MISMATCH");
    }
  });

  it("flags a gateway transaction that is not on chain as inconsistent", async () => {
    sim.gateway.injectFault(order.paymentRequestId, { kind: "unknown-transaction" });
    await payOnce();
    ticks(5);
    expect((await verdict()).status).toBe("INCONSISTENT");
  });

  it("surfaces a query outage as unavailable, not as unpaid, and recovers", async () => {
    await payOnce();
    sim.gateway.injectFault(order.paymentRequestId, { kind: "query-unavailable", times: 2 });
    await expect(sim.rail.observe(order.paymentRequestId)).rejects.toBeInstanceOf(RailUnavailableError);
    await expect(sim.rail.observe(order.paymentRequestId)).rejects.toBeInstanceOf(RailUnavailableError);
    expect((await sim.rail.observe(order.paymentRequestId)).kind).toBe("SUBMITTED");
  });

  it("stops webhook delivery after the documented retries while polling still sees the finalized payment", async () => {
    sim.gateway.setWebhookReceiver(() => 200);
    sim.gateway.injectFault(order.paymentRequestId, { kind: "webhook-unreachable" });
    await payOnce();
    ticks(5);
    for (let i = 0; i < 40; i += 1) {
      await sim.gateway.deliverDueWebhooks();
      sim.clock.advance(60 * 60 * 1000);
    }
    const finalizedAttempts = sim.gateway.webhookAttempts(order.paymentRequestId).filter((a) => a.status === "payment-finalized");
    expect(finalizedAttempts).toHaveLength(WEBHOOK_RETRY_DELAYS_MS.length + 1);
    expect(finalizedAttempts.every((a) => a.outcome === "failed")).toBe(true);
    expect(sim.gateway.webhookStates(order.paymentRequestId)).toEqual(["FAILED", "FAILED", "FAILED"]);
    const elapsed = Date.parse(finalizedAttempts.at(-1)?.at ?? "") - Date.parse(finalizedAttempts[0]?.at ?? "");
    expect(elapsed).toBeGreaterThanOrEqual(WEBHOOK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
    expect((await verdict()).status).toBe("VERIFIED");
  });
});

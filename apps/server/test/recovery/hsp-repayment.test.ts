import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ManualClock, type ChainTransfer } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { getRecoveryAction } from "../../src/db/actions.ts";
import { getCase } from "../../src/db/cases.ts";
import { openDatabase } from "../../src/db/database.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { confirmRepaymentReservation, prepareRecovery } from "../../src/recovery/actions.ts";
import { liveAttempt, requestHspRepaymentSignature, submitHspRepaymentSignature, type HspRepaymentPayments } from "../../src/recovery/repayment.ts";
import { FakeHsp } from "../payments/fake-hsp.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";
import { TERMS, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup } from "./helpers.ts";

const sellerAccount = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const buyerAccount = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const SELLER = sellerAccount.address.toLowerCase() as Address;
const BUYER = buyerAccount.address.toLowerCase() as Address;

let chain: LocalChain;
let db: DatabaseSync;
let clock: ManualClock;
let hsp: FakeHsp;
let payments: HspRepaymentPayments;

/** The payment chain after HSP's gateway executed the last prepared authorization. */
const transfers = {
  async transfer(txHash: string, expect: { from: string; to: string }): Promise<ChainTransfer | null> {
    const order = [...hsp.orders.values()].find((entry) => entry.tx === txHash);
    if (order === undefined) return null;
    const executed = hsp.lastPrepared(order.paymentRequestId);
    return { txHash, chainId: 133, token: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6", from: expect.from, to: expect.to, amountBaseUnits: executed.value, blockNumber: 10, confirmations: 6, status: "success", authorizationNonce: executed.nonce };
  },
};

beforeAll(async () => {
  chain = await startLocalChain();
}, 120_000);
afterAll(() => chain?.stop());

beforeEach(() => {
  db = openDatabase({ path: ":memory:", environment: "testnet" });
  registerFixturePolicies(db);
  clock = new ManualClock(new Date().toISOString());
  hsp = new FakeHsp(clock);
  payments = { kind: "hsp-agentic", rail: hsp.rail(transfers), deploymentId: "hsp-test", maxFeeBaseUnits: "100000" };
});
afterEach(() => db.close());

/** A per-case repayment of a live operation, reserved on the registry from the seller's own account. */
async function reserved(deadlineMs?: number): Promise<{ setup: FixtureCaseSetup; actionId: string }> {
  const setup = await setupFixtureCase(db, "refundable-failure-per-case", { buyer: BUYER, seller: SELLER }, "testnet");
  const prepared = await prepareRecovery(db, { caseId: setup.caseId, requestedBy: { role: "seller", identity: SELLER }, registry: chain.registry, terms: TERMS, now: () => clock.now(), ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  if (prepared.sellerCall === null) throw new Error("expected a seller call");
  const hash = await chain.sendAs(SELLER, prepared.sellerCall);
  await chain.mined(hash);
  expect(await confirmRepaymentReservation(db, { actionId: prepared.action.id, txHash: hash, registry: chain.registry, now: () => clock.now() })).toMatchObject({ status: "CONFIRMED" });
  return { setup, actionId: prepared.action.id };
}

const ask = (setup: FixtureCaseSetup, requestedBy: string = SELLER) => requestHspRepaymentSignature(db, { caseId: setup.caseId, requestedBy, registry: chain.registry, payments, now: () => clock.now() });
const submit = (setup: FixtureCaseSetup, signature: string) => submitHspRepaymentSignature(db, { caseId: setup.caseId, requestedBy: SELLER, signature, registry: chain.registry, payments, now: () => clock.now() });
const count = (tool: string) => hsp.calls.filter((call) => call === tool).length;

async function typedData(setup: FixtureCaseSetup): Promise<unknown> {
  const requested = await ask(setup);
  if (requested.status !== "SIGNATURE_REQUIRED") throw new Error(`expected an authorization, got ${requested.status}`);
  return requested.typedData;
}

describe("a repayment paid through HSP Agentic Payment", () => {
  it("pays the buyer exactly the principal through HSP once, verifies it on chain, and records REPAID on the registry", async () => {
    const { setup, actionId } = await reserved();
    const requested = await ask(setup);
    expect(requested).toMatchObject({ status: "SIGNATURE_REQUIRED", action: { state: "RESERVED" }, authorization: { recipient: BUYER, payer: SELLER, amountBaseUnits: "1000000", preparedBy: "hsp" } });
    if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected an authorization");
    // The authorization never outlives the recovery deadline it pays under.
    const action = getRecoveryAction(db, actionId);
    const order = [...hsp.orders.values()][0];
    expect(order).toBeDefined();
    expect(BigInt((requested.typedData as { message: { validBefore: string } }).message.validBefore) * 1000n <= BigInt(Date.parse(action?.deadline ?? ""))).toBe(true);
    expect(await typedData(setup)).toEqual(requested.typedData);
    expect(count("prepare_payment")).toBe(1);

    await expect(submit(setup, await buyerAccount.signTypedData(requested.typedData as never))).rejects.toMatchObject({ code: "MANDATE_SIGNATURE_INVALID" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");

    const signature = await sellerAccount.signTypedData(requested.typedData as never);
    expect(await submit(setup, signature)).toMatchObject({ status: "SUBMITTED", action: { state: "EXECUTION_REQUESTED" } });
    expect(getCase(db, setup.caseId)?.status).toBe("EXECUTION_REQUESTED");
    expect(await submit(setup, signature)).toMatchObject({ status: "ALREADY_REQUESTED" });
    expect(await ask(setup)).toMatchObject({ status: "ALREADY_REQUESTED" });
    expect([count("finalize_payment"), count("submit_payment")]).toEqual([1, 1]);

    const attempt = liveAttempt(db, getRecoveryAction(db, actionId) as NonNullable<ReturnType<typeof getRecoveryAction>>);
    hsp.settle(attempt?.paymentRequestId ?? "", "payment-finalized");
    for (let pass = 0; pass < 3 && getRecoveryAction(db, actionId)?.state !== "COMPLETED"; pass++) {
      await reconcilePending({ db, rail: payments.rail, registry: chain.registry, now: () => clock.now(), requiredLevel: "FINAL" });
    }
    expect(getRecoveryAction(db, actionId)?.state).toBe("COMPLETED");
    expect(getCase(db, setup.caseId)?.status).toBe("REPAID");
    const onChain = await chain.registry.readCase((getRecoveryAction(db, actionId) as NonNullable<ReturnType<typeof getRecoveryAction>>).proposal.caseKey);
    expect(onChain).toMatchObject({ state: "REPAID", outcomeRef: hsp.orders.get(attempt?.paymentRequestId ?? "")?.tx });
  }, 60_000);

  it("never lets the authorization outlive the recovery deadline, even when the gateway keeps it valid until the cart expires", async () => {
    hsp.validUntilCartExpiry = true;
    const { setup, actionId } = await reserved(10 * 60_000);
    const requested = await ask(setup);
    if (requested.status !== "SIGNATURE_REQUIRED") throw new Error("expected an authorization");
    const deadline = Date.parse(getRecoveryAction(db, actionId)?.deadline ?? "");
    const validBefore = Number((requested.typedData as { message: { validBefore: string } }).message.validBefore) * 1000;
    expect(validBefore).toBeLessThanOrEqual(deadline);
    expect(validBefore).toBeLessThan(Date.parse(requested.attempt.createdAt) + 30 * 60_000);
  }, 60_000);

  it("refuses an authorization that would refund more than the principal plus the seller's maximum fee, and lets only the seller ask", async () => {
    const { setup, actionId } = await reserved();
    await expect(ask(setup, BUYER)).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    hsp.feeBaseUnits = 100_001n;
    await expect(ask(setup)).rejects.toMatchObject({ code: "CART_REJECTED" });
    expect(getRecoveryAction(db, actionId)?.state).toBe("RESERVED");
    expect(count("finalize_payment")).toBe(0);
  }, 60_000);
});

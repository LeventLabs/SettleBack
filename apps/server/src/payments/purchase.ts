import type { DatabaseSync } from "node:sqlite";
import { validateCartMandate, type Ap2MandatePayload, type BuyerSpendPolicy, type CartValidation, type PaymentRail, type PinnedMerchant } from "@settleback/adapters";
import { readTransaction } from "../db/database.ts";
import { OperationNotFoundError } from "../db/errors.ts";
import { getOperation, type OperationRecord } from "../db/operations.ts";
import { getOriginalPayment, getPaymentAttempt, type PaymentAttemptRecord } from "../db/payments.ts";
import { ExecutionRefusedError, claimExecution, mandateDigest } from "./execution.ts";
import { quoteOperation, type Quote } from "./quote.ts";
import { attemptMandate, submitWalletSignature } from "./wallet-signing.ts";

/**
 * The buyer's Payment Agent when the buyer authorizes in its own wallet: the rail it pays through,
 * the merchant key it pinned before any quote, and the buyer's spending limits. Today's spend is
 * read from the database at each check, never supplied by a request.
 */
export interface BuyerPaymentAgent {
  rail: PaymentRail;
  merchant: PinnedMerchant;
  policy: Omit<BuyerSpendPolicy, "spentTodayBaseUnits">;
  deploymentId: string;
  coin: string;
  label: string;
}

export interface BuyerQuote {
  quote: Quote;
  attempt: PaymentAttemptRecord;
  validation: CartValidation;
}

/**
 * The receiving agent's quote for the buyer's operation, and the Payment Agent's checks of it.
 * Quoting again returns the same order and cart. Nothing here signs or moves money.
 */
export async function quoteForBuyer(db: DatabaseSync, input: { operationId: string; buyer: string; agent: BuyerPaymentAgent; now: () => Date }): Promise<BuyerQuote> {
  const operation = requireBuyer(db, input.operationId, input.buyer);
  const quote = await quoteOperation(db, { operationId: operation.id, rail: input.agent.rail, deploymentId: input.agent.deploymentId, coin: input.agent.coin, label: input.agent.label, now: input.now });
  const attempt = requireAttempt(db, quote.attemptId);
  return { quote, attempt, validation: checkQuote(db, operation, attempt, quote, input.agent, input.now()) };
}

export type PaymentSignatureRequest =
  | { status: "SIGNATURE_REQUIRED"; attempt: PaymentAttemptRecord; payload: Ap2MandatePayload }
  | { status: "ALREADY_REQUESTED"; attempt: PaymentAttemptRecord };

/**
 * The first wallet step. The quote is checked again (its expiry and every term), then the
 * attempt's one execution permit is consumed and the buyer receives the AP2 Payment Mandate with
 * its EIP-3009 authorization to sign. Until a signature arrives the same mandate is offered again,
 * checked against the digest recorded with the permit; its nonce lets the token execute it once.
 */
export async function requestPaymentSignature(db: DatabaseSync, input: { operationId: string; buyer: string; agent: BuyerPaymentAgent; now: () => Date }): Promise<PaymentSignatureRequest> {
  const operation = requireBuyer(db, input.operationId, input.buyer);
  const pending = awaitingSignature(db, operation, input.agent);
  if (pending !== undefined) return pending;
  const live = liveOriginalAttempt(db, operation.id);
  if (live !== undefined && live.state !== "CREATED" && live.state !== "PREPARED") return { status: "ALREADY_REQUESTED", attempt: live };

  const { attempt, validation } = await quoteForBuyer(db, input);
  if (!validation.ok) {
    throw new ExecutionRefusedError("CART_REJECTED", `The quote does not pass the Payment Agent's checks: ${validation.rejections.map((entry) => entry.message).join("; ")}.`);
  }
  try {
    const claim = claimExecution(db, {
      attemptId: attempt.id,
      requestedBy: input.buyer,
      cart: validation.cart,
      provenances: [input.agent.rail.provenance],
      now: input.now().toISOString(),
      mandate: (_cart, current) => attemptMandate(current, operation.priceUsd, input.agent.merchant.merchantName, input.agent.rail.provenance),
    });
    if (claim.payload.kind !== "ap2-eip3009") throw new Error("expected an AP2 mandate");
    return { status: "SIGNATURE_REQUIRED", attempt: claim.attempt, payload: claim.payload };
  } catch (error) {
    // A concurrent request consumed the permit first: offer its mandate.
    if (error instanceof ExecutionRefusedError && error.code === "PERMIT_CONSUMED") {
      return awaitingSignature(db, operation, input.agent) ?? { status: "ALREADY_REQUESTED", attempt: requireAttempt(db, attempt.id) };
    }
    throw error;
  }
}

export type PaymentSubmission =
  | { status: "SUBMITTED"; attempt: PaymentAttemptRecord }
  | { status: "OUTCOME_UNKNOWN"; attempt: PaymentAttemptRecord; reason: string }
  | { status: "ALREADY_REQUESTED"; attempt: PaymentAttemptRecord };

/**
 * The second wallet step: the buyer's EIP-712 signature of the recorded mandate, verified and then
 * submitted once. A repeat after a lost response is answered from the gateway; an attempt that has
 * moved on, including one reconciliation froze, is never submitted again.
 */
export async function submitPaymentSignature(db: DatabaseSync, input: { operationId: string; buyer: string; signature: string; agent: BuyerPaymentAgent }): Promise<PaymentSubmission> {
  const operation = requireBuyer(db, input.operationId, input.buyer);
  const attempt = liveOriginalAttempt(db, operation.id);
  if (attempt === undefined || attempt.state === "CREATED" || attempt.state === "PREPARED") {
    throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", "Request the payment mandate before signing it.");
  }
  if (attempt.state !== "SIGNING_REQUESTED") return { status: "ALREADY_REQUESTED", attempt };
  const payload = attemptMandate(attempt, operation.priceUsd, input.agent.merchant.merchantName, input.agent.rail.provenance);
  const outcome = await submitWalletSignature(attempt, payload, input.signature, input.agent.rail);
  const after = requireAttempt(db, attempt.id);
  if (outcome.status === "OUTCOME_UNKNOWN") return { status: "OUTCOME_UNKNOWN", attempt: after, reason: outcome.reason };
  return { status: outcome.status, attempt: after };
}

/** The operation's original payment attempt that is still live, if any. */
export function liveOriginalAttempt(db: DatabaseSync, operationId: string): PaymentAttemptRecord | undefined {
  const facts = getOriginalPayment(db, operationId);
  if (facts === undefined || facts.state === "REJECTED_NO_SEND" || facts.state === "FAILED") return undefined;
  return getPaymentAttempt(db, facts.id);
}

function checkQuote(db: DatabaseSync, operation: OperationRecord, attempt: PaymentAttemptRecord, quote: Quote, agent: BuyerPaymentAgent, now: Date): CartValidation {
  return validateCartMandate({
    cartMandate: quote.cartMandate,
    merchant: agent.merchant,
    intent: {
      cartMandateId: quote.cartMandateId,
      paymentRequestId: quote.paymentRequestId,
      payee: operation.seller,
      chainId: operation.chainId,
      token: operation.token,
      tokenDecimals: operation.tokenDecimals,
      priceUsd: operation.priceUsd,
    },
    policy: { ...agent.policy, spentTodayBaseUnits: spentToday(db, operation.buyer, attempt.id, agent.policy.maxFeeBaseUnits, now) },
    now,
  });
}

/**
 * The buyer's gross spend today (amount plus the maximum fee) on other original payments that are
 * not closed, including uncertain ones: an unknown payment still counts against the cap.
 */
export function spentToday(db: DatabaseSync, buyer: string, exceptAttemptId: string, maxFeeBaseUnits: string, now: Date): string {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows = db
    .prepare(
      `SELECT amount_base_units FROM payment_attempts
       WHERE payer = ? AND purpose = 'ORIGINAL' AND id <> ? AND created_at >= ? AND state NOT IN ('CREATED', 'PREPARED', 'REJECTED_NO_SEND', 'FAILED')`,
    )
    .all(buyer.toLowerCase(), exceptAttemptId, dayStart);
  return rows.reduce((sum, row) => sum + BigInt(String(row.amount_base_units)) + BigInt(maxFeeBaseUnits), 0n).toString();
}

function awaitingSignature(db: DatabaseSync, operation: OperationRecord, agent: BuyerPaymentAgent): PaymentSignatureRequest | undefined {
  const attempt = liveOriginalAttempt(db, operation.id);
  if (attempt?.state !== "SIGNING_REQUESTED") return undefined;
  const payload = attemptMandate(attempt, operation.priceUsd, agent.merchant.merchantName, agent.rail.provenance);
  // A mandate of another kind (a server-side signer's) was claimed; it is not offered to a wallet.
  if (mandateDigest(payload) !== attempt.paymentMandateSha256) return { status: "ALREADY_REQUESTED", attempt };
  return { status: "SIGNATURE_REQUIRED", attempt, payload };
}

export function requireBuyer(db: DatabaseSync, operationId: string, buyer: string): OperationRecord {
  const operation = readTransaction(db, () => getOperation(db, operationId));
  if (operation === undefined) throw new OperationNotFoundError(operationId);
  if (operation.buyer !== buyer.toLowerCase()) throw new ExecutionRefusedError("ROLE_FORBIDDEN", "Only the operation's buyer pays for it.");
  return operation;
}

function requireAttempt(db: DatabaseSync, attemptId: string): PaymentAttemptRecord {
  const attempt = getPaymentAttempt(db, attemptId);
  if (attempt === undefined) throw new Error(`payment attempt ${attemptId} disappeared`);
  return attempt;
}

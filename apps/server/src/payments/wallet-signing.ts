import { buildEip3009PaymentMandate, submitPaymentMandate, verifyEip3009Signature, type Ap2MandatePayload, type PaymentRail, type Provenance } from "@settleback/adapters";
import { ActionIntegrityError } from "../db/errors.ts";
import type { PaymentAttemptRecord } from "../db/payments.ts";
import { ExecutionRefusedError, mandateDigest } from "./execution.ts";
import { CART_LIFETIME_MS } from "./quote.ts";

/** When an attempt's cart stops being payable; its authorization is valid until then and not after. */
export function cartExpiryOf(attempt: PaymentAttemptRecord): string {
  return new Date(Date.parse(attempt.createdAt) + CART_LIFETIME_MS).toISOString();
}

/**
 * The AP2 Payment Mandate an attempt's payer signs in a wallet, rebuilt only from what the attempt
 * fixes (order, cart hash, payer, payee, chain, token, amount, creation time) and the agreed price,
 * so it is the same mandate every time it is built.
 */
export function attemptMandate(attempt: PaymentAttemptRecord, priceUsd: string, merchantName: string, provenance: Provenance): Ap2MandatePayload {
  if (attempt.cartMandateId === null || attempt.paymentRequestId === null || attempt.cartSha256 === null) {
    throw new ActionIntegrityError(`payment attempt ${attempt.id} has no prepared cart`);
  }
  return buildEip3009PaymentMandate({
    provenance,
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: attempt.paymentRequestId,
    cartSha256: attempt.cartSha256,
    payer: attempt.payer,
    payee: attempt.payee,
    chainId: attempt.chainId,
    token: attempt.token,
    amountBaseUnits: attempt.amountBaseUnits,
    totalUsd: priceUsd,
    cartExpiry: cartExpiryOf(attempt),
    merchantName,
    issuedAt: attempt.createdAt,
  });
}

export type WalletSubmission = { status: "SUBMITTED" } | { status: "OUTCOME_UNKNOWN"; reason: string } | { status: "ALREADY_REQUESTED" };

/**
 * Submits a wallet's signature of the mandate recorded with an attempt's permit. The mandate must
 * still match the recorded digest, and the signature must recover to the authorization's `from`
 * over exactly that mandate; only then is it submitted, once. A refusal because the same
 * authorization already reached the gateway is that payment, not a failure; anything else
 * uncertain is left to reconciliation.
 */
export async function submitWalletSignature(attempt: PaymentAttemptRecord, payload: Ap2MandatePayload, signature: string, rail: PaymentRail): Promise<WalletSubmission> {
  if (mandateDigest(payload) !== attempt.paymentMandateSha256) throw new ActionIntegrityError(`payment attempt ${attempt.id} no longer matches the mandate recorded with its permit`);
  if (!(await verifyEip3009Signature(payload, signature))) {
    throw new ExecutionRefusedError("MANDATE_SIGNATURE_INVALID", "The signature is not the payer's signature of this payment's authorization.");
  }
  try {
    const submission = await submitPaymentMandate(rail, { payload, signature });
    return submission === "SUBMITTED" ? { status: "SUBMITTED" } : { status: "OUTCOME_UNKNOWN", reason: "the submission response was lost and the gateway shows no payment yet" };
  } catch (error) {
    if (attempt.paymentRequestId !== null && (await gatewayMovedOn(rail, attempt.paymentRequestId))) return { status: "ALREADY_REQUESTED" };
    return { status: "OUTCOME_UNKNOWN", reason: `the gateway did not accept the submission (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)})` };
  }
}

/** Whether the gateway shows the order past payment-required; an unreachable gateway counts as no. */
export async function gatewayMovedOn(rail: PaymentRail, paymentRequestId: string): Promise<boolean> {
  try {
    return (await rail.observe(paymentRequestId)).record.status !== "payment-required";
  } catch {
    return false;
  }
}

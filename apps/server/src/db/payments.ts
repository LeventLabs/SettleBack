import type { DatabaseSync } from "node:sqlite";
import type { Address, PaymentAttemptState, PaymentFacts } from "@settleback/domain";

/**
 * The operation's original payment: its live attempt if there is one, otherwise the most recent
 * closed attempt. At most one original attempt can be live at a time (see the partial unique index).
 */
export function getOriginalPayment(db: DatabaseSync, operationId: string): PaymentFacts | undefined {
  const row = db
    .prepare(
      `SELECT id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units
       FROM payment_attempts WHERE operation_id = ? AND purpose = 'ORIGINAL'
       ORDER BY state NOT IN ('REJECTED_NO_SEND', 'FAILED') DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(operationId);
  if (row === undefined) return undefined;
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    purpose: "ORIGINAL",
    state: String(row.state) as PaymentAttemptState,
    payer: String(row.payer) as Address,
    payee: String(row.payee) as Address,
    chainId: Number(row.chain_id),
    token: String(row.token) as Address,
    amountBaseUnits: String(row.amount_base_units),
  };
}

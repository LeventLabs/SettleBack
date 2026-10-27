// Shapes follow the public HashKey Merchant documentation (payment record and webhook fields).
// Field names stay in the gateway's snake_case because these are external records.

export const GATEWAY_STATUSES = [
  "payment-required",
  "payment-submitted",
  "payment-verified",
  "payment-processing",
  "payment-included",
  "payment-safe",
  "payment-finalized",
  "payment-failed",
] as const;

export type GatewayStatus = (typeof GATEWAY_STATUSES)[number];

export interface GatewayPaymentRecord {
  payment_request_id: string;
  cart_mandate_id: string;
  flow_id: string;
  request_id: string | null;
  status: GatewayStatus;
  status_reason: string | null;
  tx_signature: string | null;
  payer_address: string | null;
  to_pay_address: string;
  token: string;
  token_address: string;
  /** CAIP-2, for example "eip155:133". */
  chain: string;
  network: string;
  /** Token-denominated decimal strings. order_amount is the principal here; pay_amount adds fees. */
  product_amount: string;
  order_amount: string;
  pay_amount: string;
  created_at: string;
  included_at: string | null;
  completed_at: string | null;
}

/** What a gateway status means for our records; see the status mapping in the design. */
export type ObservationKind =
  | "AWAITING_PAYER"
  | "SUBMITTED"
  | "INCLUDED"
  | "SAFE"
  | "FINAL"
  | "FAILED_NO_TRANSACTION"
  | "FAILED_AFTER_INCLUSION";

export function classifyGatewayRecord(record: GatewayPaymentRecord): ObservationKind {
  switch (record.status) {
    case "payment-required":
      return "AWAITING_PAYER";
    case "payment-submitted":
    case "payment-verified":
    case "payment-processing":
      return "SUBMITTED";
    case "payment-included":
      return "INCLUDED";
    case "payment-safe":
      return "SAFE";
    case "payment-finalized":
      return "FINAL";
    case "payment-failed":
      return record.tx_signature === null ? "FAILED_NO_TRANSACTION" : "FAILED_AFTER_INCLUSION";
  }
}

export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

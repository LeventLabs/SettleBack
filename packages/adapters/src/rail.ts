import type { Address } from "@settleback/domain";
import type { GatewayPaymentRecord, ObservationKind } from "./gateway.ts";
import type { CartMandate } from "./hsp/cart-mandate.ts";
import type { Provenance } from "./provenance.ts";
import type { ChainTransfer } from "./settlement.ts";

/** The request may or may not have taken effect; observe before doing anything else. */
export class RailTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation}: response lost; the outcome is unknown`);
    this.name = "RailTimeoutError";
  }
}

/** The dependency could not be reached; nothing is known to have changed. */
export class RailUnavailableError extends Error {
  constructor(operation: string) {
    super(`${operation}: dependency unavailable`);
    this.name = "RailUnavailableError";
  }
}

/** A definite refusal; the request did not take effect. */
export class RailRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RailRejectedError";
    this.code = code;
  }
}

/** The receiving agent's terms for one order, fixed by the operation intent. */
export interface PrepareInput {
  cartMandateId: string;
  paymentRequestId: string;
  payee: Address;
  chainId: number;
  token: Address;
  /** Token symbol as the gateway lists it, for example "USDC". */
  coin: string;
  tokenDecimals: number;
  priceUsd: string;
  /** Line-item label shown to the payer. */
  label: string;
  expiresAt: string;
}

export interface PreparedPayment {
  provenance: Provenance;
  /** The merchant-signed Cart Mandate the receiving agent sends to the Payment Agent. */
  cartMandate: CartMandate;
  cartMandateId: string;
  paymentRequestId: string;
  cartSha256: string;
  /** Hosted checkout for a human payer; null when the order was recovered by query after a lost response. */
  paymentUrl: string | null;
  recovered: boolean;
}

/**
 * What the payer signs, built from a validated Cart Mandate and never from gateway responses. The
 * live Payment Mandate format is not publicly documented yet, so the simulated payload is labeled
 * and must not be mistaken for the gateway's real schema.
 */
export interface ExecutionPayload {
  provenance: Provenance;
  kind: "simulated-payment-mandate" | "payment-mandate";
  cartMandateId: string;
  cartSha256: string;
  paymentRequestId: string;
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
  nonce: string;
}

export interface SignedPayload {
  payload: ExecutionPayload;
  signature: string;
}

export interface RailObservation {
  provenance: Provenance;
  record: GatewayPaymentRecord;
  kind: ObservationKind;
  transfer: ChainTransfer | null;
  observedAt: string;
}

/** Application-facing payment interface; settlement verification is the pure `verifySettlement`. */
export interface PaymentRail {
  readonly provenance: Provenance;
  /** Signs the Cart Mandate and creates the order once; repeating it with the same identifiers recovers the same order. */
  prepare(input: PrepareInput): Promise<PreparedPayment>;
  /** Never call twice for one attempt; after a timeout, observe instead. */
  submit(signed: SignedPayload): Promise<void>;
  observe(paymentRequestId: string): Promise<RailObservation>;
}

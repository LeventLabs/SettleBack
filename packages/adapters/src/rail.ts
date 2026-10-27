import type { Address } from "@settleback/domain";
import type { GatewayPaymentRecord, ObservationKind } from "./gateway.ts";
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

export interface PrepareInput {
  cartMandateId: string;
  paymentRequestId: string;
  payee: Address;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  priceUsd: string;
  expiresAt: string;
}

export interface PreparedPayment {
  provenance: Provenance;
  cartMandateId: string;
  paymentRequestId: string;
  flowId: string;
  paymentUrl: string;
  /** Null when the order was recovered after a lost response and the gateway did not return it. */
  cartSha256: string | null;
}

/**
 * What the payer signs. The live Payment Mandate format is not publicly documented yet, so the
 * simulated payload is labeled and must not be mistaken for the gateway's real schema.
 */
export interface ExecutionPayload {
  provenance: Provenance;
  kind: "simulated-payment-mandate" | "payment-mandate";
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
  /** Creates the order once; repeating it with the same identifiers returns the same order. */
  prepare(input: PrepareInput): Promise<PreparedPayment>;
  executionPayload(prepared: PreparedPayment, payer: Address): Promise<ExecutionPayload>;
  /** Never call twice for one attempt; after a timeout, observe instead. */
  submit(signed: SignedPayload): Promise<void>;
  observe(paymentRequestId: string): Promise<RailObservation>;
}

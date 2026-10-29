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

interface PayloadTerms {
  provenance: Provenance;
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

/**
 * A placeholder mandate with a placeholder signature, kept for fixtures and server-side test
 * signers. It is labeled simulated and must not be mistaken for the gateway's schema.
 */
export interface SimulatedMandatePayload extends PayloadTerms {
  kind: "simulated-payment-mandate" | "payment-mandate";
}

/** EIP-3009 TransferWithAuthorization, field for field as the token contract checks it. Integers are decimal strings. */
export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  /** bytes32, 0x-prefixed. */
  nonce: string;
}

/** The token's EIP-712 domain, which the payer's signature commits to. */
export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * The AP2 Payment Mandate in the shape the official HashKey Merchant SDK defines, carrying the
 * payer's EIP-3009 authorization of exactly the cart's transfer. The submission endpoint is not
 * documented yet, so only the simulated gateway accepts it; the signature itself is real.
 */
export interface Ap2PaymentMandate {
  payment_mandate_contents: {
    /** Equals the order's payment_request_id. */
    payment_mandate_id: string;
    payment_details_id: string;
    payment_details_total: { label: string; amount: { currency: string; value: string } };
    payment_response: {
      request_id: string;
      method_name: string;
      details: { x402Version: 2; scheme: "exact"; network: string; chain_id: number; protocol: "eip3009"; authorization: TransferAuthorization };
    };
    merchant_agent: string;
    timestamp: string;
  };
}

export interface Ap2MandatePayload extends PayloadTerms {
  kind: "ap2-eip3009";
  authorization: TransferAuthorization;
  domain: TokenDomain;
  mandate: Ap2PaymentMandate;
}

/** What the payer signs, built from a validated Cart Mandate and never from gateway responses. */
export type ExecutionPayload = SimulatedMandatePayload | Ap2MandatePayload;

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

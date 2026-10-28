import type { Address } from "@settleback/domain";
import type { Provenance } from "./provenance.ts";

export type RegistryCaseState = "OPEN" | "RESERVED_REPAY" | "RESERVED_RETRIEVE" | "REPAID" | "RECOVERED";
export type RegistryReservationMode = "NONE" | "PER_CASE" | "STANDING_POLICY";
export type RegistryPolicyStatus = "ACTIVE" | "PAUSED" | "REVOKED" | "REPLACED";

/** A settlement reference always carries its chain, so a testnet payment cannot pass as a mainnet one. */
export interface ChainRef {
  chainId: number;
  /** 0x-prefixed 32-byte transaction hash. */
  txHash: string;
}

/**
 * Fixed terms of a case. Digests are lowercase SHA-256 hex without a prefix, as the application
 * computes them; the gateway converts them to bytes32.
 */
export interface RegisterCaseInput {
  /** 0x-prefixed 32-byte key. */
  caseKey: string;
  buyer: Address;
  seller: Address;
  token: Address;
  amountBaseUnits: string;
  originalRef: ChainRef;
  policySha256: string;
  eligibilityRulesSha256: string;
  autoEligible: boolean;
  actionDigest: string;
  evidenceDigest: string;
  actionKind: "REPAY" | "RETRIEVE";
  /** ISO time; stored on chain in whole seconds. */
  deadline: string;
}

export interface RegistryCase extends RegisterCaseInput {
  state: RegistryCaseState;
  mode: RegistryReservationMode;
  /** 0 unless reserved under a standing policy. */
  authorizationId: number;
  /** Repayment transaction hash, or the delivered artifact's digest. */
  outcomeRef: string | null;
  /** Evidence bundle digest, or the acknowledgement digest. */
  outcomeCommitment: string | null;
}

export interface RegistryPolicyTerms {
  delegate: Address;
  signer: Address;
  token: Address;
  paymentChainId: number;
  servicePolicySha256: string;
  eligibilityRulesSha256: string;
  maxPerCaseBaseUnits: string;
  dailyLimitBaseUnits: string;
  validFrom: string;
  validUntil: string;
}

export interface RegistryPolicy {
  authorizationId: number;
  seller: Address;
  terms: RegistryPolicyTerms;
  status: RegistryPolicyStatus;
}

/** Confirmed contract state for one seller, payment chain, and token; never authority by itself. */
export interface RegistryBudget {
  scope: string;
  /** UTC day number, floor(timestamp / 86400). */
  day: number;
  bookedOnDayBaseUnits: string;
  outstandingBaseUnits: string;
}

export interface RegistryWrite {
  txHash: string;
  blockNumber: number;
}

/** A transaction for the seller's wallet or delegate to sign; the application never signs it. */
export interface WalletCall {
  chainId: number;
  to: Address;
  data: string;
}

export interface ReservationExpectation {
  caseKey: string;
  mode: "PER_CASE" | "STANDING_POLICY";
  /** The account that must have sent the reservation: the seller, or the policy's delegate. */
  reservedBy: Address;
  /** Required for STANDING_POLICY. */
  authorizationId?: number;
}

export type ReservationConfirmation =
  | { status: "CONFIRMED"; txHash: string; blockNumber: number; confirmations: number; amountBaseUnits: string; scope: string }
  | { status: "PENDING"; reason: string }
  | { status: "REJECTED"; reason: string };

export class RegistryRevertError extends Error {
  /** The contract's custom error name, for example "WrongState". */
  readonly reason: string;

  constructor(reason: string) {
    super(`Registry reverted: ${reason}`);
    this.name = "RegistryRevertError";
    this.reason = reason;
  }
}

/** A registry transaction was sent but its receipt was not observed; reconcile by reading state. */
export class RegistryOutcomeUnknownError extends Error {
  readonly txHash: string;

  constructor(txHash: string, message: string) {
    super(message);
    this.name = "RegistryOutcomeUnknownError";
    this.txHash = txHash;
  }
}

/**
 * The recovery registry as the application uses it. Verifier writes are signed with the
 * application's verifier key. Seller and delegate actions are only prepared as wallet calls and
 * then confirmed from the chain, so a client-reported transaction is never taken at its word.
 */
export interface RegistryGateway {
  readonly provenance: Provenance;
  readonly chainId: number;
  readonly address: Address;

  readCase(caseKey: string): Promise<RegistryCase | undefined>;
  readPolicy(authorizationId: number): Promise<RegistryPolicy | undefined>;
  activePolicyId(seller: Address, paymentChainId: number, token: Address): Promise<number>;
  readBudget(seller: Address, paymentChainId: number, token: Address, day?: number): Promise<RegistryBudget>;

  registerCase(input: RegisterCaseInput): Promise<RegistryWrite>;
  reserveRetrieval(caseKey: string): Promise<RegistryWrite>;
  completeRepayment(caseKey: string, repaymentTxHash: string, evidenceBundleSha256: string): Promise<RegistryWrite>;
  completeRetrieval(caseKey: string, artifactSha256: string, acknowledgementSha256: string): Promise<RegistryWrite>;

  reserveRepaymentCall(caseKey: string): WalletCall;
  reserveUnderPolicyCall(caseKey: string, authorizationId: number): WalletCall;
  activatePolicyCall(terms: RegistryPolicyTerms): WalletCall;
  pausePolicyCall(authorizationId: number): WalletCall;
  resumePolicyCall(authorizationId: number): WalletCall;
  revokePolicyCall(authorizationId: number): WalletCall;

  confirmReservation(txHash: string, expected: ReservationExpectation): Promise<ReservationConfirmation>;
}

import type { Address } from "@settleback/domain";
import type { Provenance } from "./provenance.ts";

export type RegistryCaseState = "OPEN" | "RESERVED_REPAY" | "RESERVED_RETRIEVE" | "REPAID" | "RECOVERED";

/** A settlement reference always carries its chain, so a testnet payment cannot pass as a mainnet one. */
export interface ChainRef {
  chainId: number;
  txHash: string;
}

export interface RegisterCaseInput {
  caseKey: string;
  buyer: Address;
  seller: Address;
  token: Address;
  amountBaseUnits: string;
  originalRef: ChainRef;
  policySha256: string;
  actionDigest: string;
  evidenceDigest: string;
  actionKind: "REPAY" | "RETRIEVE";
  deadline: string;
}

export interface RegistryCase extends RegisterCaseInput {
  state: RegistryCaseState;
  repaymentRef: ChainRef | null;
  outcomeSha256: string | null;
}

export interface RegistryReceipt {
  txHash: string;
  blockNumber: number;
  confirmations: number;
}

export class RegistryRevertError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Registry reverted: ${reason}`);
    this.name = "RegistryRevertError";
    this.reason = reason;
  }
}

/** Case lifecycle of the recovery registry. Standing-policy methods arrive with their own task. */
export interface RegistryGateway {
  readonly provenance: Provenance;
  readonly chainId: number;
  registerCase(caller: Address, input: RegisterCaseInput): Promise<string>;
  reserveRepayment(caller: Address, caseKey: string): Promise<string>;
  reserveRetrieval(caller: Address, caseKey: string): Promise<string>;
  completeRepayment(caller: Address, caseKey: string, repaymentRef: ChainRef, evidenceBundleSha256: string): Promise<string>;
  completeRetrieval(caller: Address, caseKey: string, artifactSha256: string, acknowledgementSha256: string): Promise<string>;
  readCase(caseKey: string): Promise<RegistryCase | undefined>;
  getReceipt(txHash: string): Promise<RegistryReceipt | undefined>;
}

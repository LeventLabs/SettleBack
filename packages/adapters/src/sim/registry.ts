import type { Address } from "@settleback/domain";
import type { Clock } from "../clock.ts";
import { RailTimeoutError } from "../rail.ts";
import {
  RegistryRevertError,
  type ChainRef,
  type RegisterCaseInput,
  type RegistryCase,
  type RegistryGateway,
  type RegistryReceipt,
} from "../registry.ts";
import type { SimChain } from "./chain.ts";

export type RegistryFault = { kind: "receipt-lost" };

const HEX32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * In-memory model of the recovery registry's case lifecycle with the same authority rules the
 * contract will enforce: only the verifier registers and completes, only the recorded seller
 * reserves a repayment, each case reaches one terminal outcome, and settlement references are unique.
 */
export class SimulatedRegistry implements RegistryGateway {
  readonly provenance = "SIMULATED" as const;
  readonly chainId: number;
  private readonly verifier: Address;
  private readonly clock: Clock;
  private readonly chain: SimChain;
  private readonly cases = new Map<string, RegistryCase>();
  private readonly usedRefs = new Set<string>();
  private readonly receipts = new Map<string, number>();
  private readonly faults: RegistryFault[] = [];

  constructor(options: { chain: SimChain; verifier: Address; clock: Clock }) {
    this.chain = options.chain;
    this.chainId = options.chain.chainId;
    this.verifier = options.verifier.toLowerCase() as Address;
    this.clock = options.clock;
  }

  injectFault(fault: RegistryFault): void {
    this.faults.push(fault);
  }

  async registerCase(caller: Address, input: RegisterCaseInput): Promise<string> {
    this.requireVerifier(caller);
    if (!HEX32.test(input.caseKey)) throw new RegistryRevertError("invalid case key");
    if (this.cases.has(input.caseKey)) throw new RegistryRevertError("case already registered");
    if (!/^[1-9][0-9]*$/.test(input.amountBaseUnits)) throw new RegistryRevertError("amount must be positive");
    if (input.buyer.toLowerCase() === input.seller.toLowerCase()) throw new RegistryRevertError("buyer equals seller");
    if (!SHA256.test(input.policySha256) || !SHA256.test(input.actionDigest) || !SHA256.test(input.evidenceDigest)) {
      throw new RegistryRevertError("invalid commitment");
    }
    if (!(Date.parse(input.deadline) > this.clock.now().getTime())) throw new RegistryRevertError("deadline must be in the future");
    const originalKey = refKey(input.originalRef);
    if (this.usedRefs.has(originalKey)) throw new RegistryRevertError("original payment already bound");

    return this.write(() => {
      this.usedRefs.add(originalKey);
      this.cases.set(input.caseKey, {
        ...input,
        buyer: input.buyer.toLowerCase() as Address,
        seller: input.seller.toLowerCase() as Address,
        token: input.token.toLowerCase() as Address,
        originalRef: normalizeRef(input.originalRef),
        state: "OPEN",
        repaymentRef: null,
        outcomeSha256: null,
      });
    });
  }

  async reserveRepayment(caller: Address, caseKey: string): Promise<string> {
    const record = this.requireCase(caseKey);
    if (caller.toLowerCase() !== record.seller) throw new RegistryRevertError("only the recorded seller can reserve a repayment");
    if (record.state !== "OPEN") throw new RegistryRevertError(`case is ${record.state}`);
    if (record.actionKind !== "REPAY") throw new RegistryRevertError("case is not a repayment");
    this.requireBeforeDeadline(record);
    return this.write(() => {
      record.state = "RESERVED_REPAY";
    });
  }

  async reserveRetrieval(caller: Address, caseKey: string): Promise<string> {
    this.requireVerifier(caller);
    const record = this.requireCase(caseKey);
    if (record.state !== "OPEN") throw new RegistryRevertError(`case is ${record.state}`);
    if (record.actionKind !== "RETRIEVE") throw new RegistryRevertError("case is not a retrieval");
    this.requireBeforeDeadline(record);
    return this.write(() => {
      record.state = "RESERVED_RETRIEVE";
    });
  }

  /** Allowed after the deadline: a transfer issued under valid authority must still be recordable. */
  async completeRepayment(caller: Address, caseKey: string, repaymentRef: ChainRef, evidenceBundleSha256: string): Promise<string> {
    this.requireVerifier(caller);
    const record = this.requireCase(caseKey);
    if (record.state !== "RESERVED_REPAY") throw new RegistryRevertError(`case is ${record.state}`);
    if (!HEX32.test(repaymentRef.txHash.toLowerCase())) throw new RegistryRevertError("invalid repayment reference");
    if (!SHA256.test(evidenceBundleSha256)) throw new RegistryRevertError("invalid evidence commitment");
    const key = refKey(repaymentRef);
    if (this.usedRefs.has(key)) throw new RegistryRevertError("repayment reference already used");
    return this.write(() => {
      this.usedRefs.add(key);
      record.state = "REPAID";
      record.repaymentRef = normalizeRef(repaymentRef);
      record.outcomeSha256 = evidenceBundleSha256;
    });
  }

  async completeRetrieval(caller: Address, caseKey: string, artifactSha256: string, acknowledgementSha256: string): Promise<string> {
    this.requireVerifier(caller);
    const record = this.requireCase(caseKey);
    if (record.state !== "RESERVED_RETRIEVE") throw new RegistryRevertError(`case is ${record.state}`);
    if (!SHA256.test(artifactSha256) || !SHA256.test(acknowledgementSha256)) throw new RegistryRevertError("invalid commitment");
    return this.write(() => {
      record.state = "RECOVERED";
      record.outcomeSha256 = acknowledgementSha256;
    });
  }

  async readCase(caseKey: string): Promise<RegistryCase | undefined> {
    const record = this.cases.get(caseKey);
    return record === undefined ? undefined : structuredClone(record);
  }

  async getReceipt(txHash: string): Promise<RegistryReceipt | undefined> {
    const blockNumber = this.receipts.get(txHash.toLowerCase());
    if (blockNumber === undefined) return undefined;
    return { txHash: txHash.toLowerCase(), blockNumber, confirmations: this.chain.blockNumber - blockNumber };
  }

  /** Applies the change and records a receipt; a receipt-lost fault hides the response, not the effect. */
  private write(apply: () => void): string {
    apply();
    this.chain.mine();
    const txHash = this.chain.nextTxHash();
    this.receipts.set(txHash, this.chain.blockNumber);
    const lost = this.faults.findIndex((fault) => fault.kind === "receipt-lost");
    if (lost !== -1) {
      this.faults.splice(lost, 1);
      throw new RailTimeoutError("registry write");
    }
    return txHash;
  }

  private requireVerifier(caller: Address): void {
    if (caller.toLowerCase() !== this.verifier) throw new RegistryRevertError("only the verifier");
  }

  private requireCase(caseKey: string): RegistryCase {
    const record = this.cases.get(caseKey);
    if (record === undefined) throw new RegistryRevertError("case not registered");
    return record;
  }

  private requireBeforeDeadline(record: RegistryCase): void {
    if (!(this.clock.now().getTime() < Date.parse(record.deadline))) throw new RegistryRevertError("deadline passed");
  }
}

function normalizeRef(ref: ChainRef): ChainRef {
  return { chainId: ref.chainId, txHash: ref.txHash.toLowerCase() };
}

function refKey(ref: ChainRef): string {
  return `${ref.chainId}:${ref.txHash.toLowerCase()}`;
}

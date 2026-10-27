import { createHash } from "node:crypto";
import type { ChainTransfer } from "../settlement.ts";

type StoredTransfer = Omit<ChainTransfer, "confirmations">;

/** An in-memory ledger of token transfers and blocks for one chain. */
export class SimChain {
  readonly chainId: number;
  private block = 0;
  private counter = 0;
  private readonly transfers = new Map<string, StoredTransfer>();

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  get blockNumber(): number {
    return this.block;
  }

  mine(blocks = 1): void {
    this.block += blocks;
  }

  /** Deterministic 32-byte transaction hash, unique per chain. */
  nextTxHash(): string {
    this.counter += 1;
    return `0x${createHash("sha256").update(`sim-chain:${this.chainId}:${this.counter}`).digest("hex")}`;
  }

  includeTransfer(transfer: Omit<StoredTransfer, "blockNumber" | "chainId">): void {
    this.mine();
    this.transfers.set(transfer.txHash.toLowerCase(), { ...transfer, chainId: this.chainId, blockNumber: this.block });
  }

  /** Simulates a reorganization that drops a transaction. */
  dropTransfer(txHash: string): void {
    this.transfers.delete(txHash.toLowerCase());
  }

  getTransfer(txHash: string): ChainTransfer | null {
    const stored = this.transfers.get(txHash.toLowerCase());
    if (stored === undefined) return null;
    return { ...stored, confirmations: this.block - stored.blockNumber };
  }
}

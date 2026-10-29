import { createHash } from "node:crypto";
import type { ChainTransfer } from "../settlement.ts";

type StoredTransfer = Omit<ChainTransfer, "confirmations">;

/** An in-memory ledger of token transfers and blocks for one chain. */
export class SimChain {
  readonly chainId: number;
  private block = 0;
  private counter = 0;
  private readonly transfers = new Map<string, StoredTransfer>();
  private readonly seed: string | undefined;

  /**
   * Without a seed the hashes are fixed per chain, which fixtures with recorded evidence rely on.
   * Anything that keeps payment references across restarts, a database or a registry, must pass a
   * fresh random seed so a restarted simulator never reuses one.
   */
  constructor(chainId: number, seed?: string) {
    this.chainId = chainId;
    this.seed = seed;
  }

  get blockNumber(): number {
    return this.block;
  }

  mine(blocks = 1): void {
    this.block += blocks;
  }

  /** A 32-byte transaction hash, unique per chain and seed. */
  nextTxHash(): string {
    this.counter += 1;
    const label = this.seed === undefined ? `sim-chain:${this.chainId}:${this.counter}` : `sim-chain:${this.chainId}:${this.seed}:${this.counter}`;
    return `0x${createHash("sha256").update(label).digest("hex")}`;
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

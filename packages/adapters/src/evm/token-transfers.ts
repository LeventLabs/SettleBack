import { setTimeout as sleep } from "node:timers/promises";
import { TransactionReceiptNotFoundError, createPublicClient, defineChain, hashDomain, http, parseEventLogs, type Hex, type PublicClient } from "viem";
import type { Address } from "@settleback/domain";
import { EIP712_DOMAIN_TYPE, tokenDomain } from "../hsp/payment-mandate.ts";
import type { ChainTransfer } from "../settlement.ts";

const TOKEN_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      { indexed: true, name: "authorizer", type: "address" },
      { indexed: true, name: "nonce", type: "bytes32" },
    ],
  },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export class TokenConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenConfigurationError";
  }
}

export interface TokenTransferReaderOptions {
  rpcUrl: string;
  chainId: number;
  token: Address;
  timeoutMs: number;
  /** Lookups of a receipt the gateway reported, for RPC nodes that have not seen it yet. */
  receiptAttempts?: number;
  pollMs?: number;
}

/**
 * Reads token transfers from the payment chain itself, so a gateway's report of a payment is
 * checked against the transaction it names: the receipt's status, the token's Transfer event,
 * and the AuthorizationUsed event that shows which signed authorization the transaction executed.
 */
export class TokenTransferReader {
  readonly chainId: number;
  readonly token: Address;
  private readonly client: PublicClient;
  private readonly receiptAttempts: number;
  private readonly pollMs: number;

  private constructor(options: TokenTransferReaderOptions) {
    this.chainId = options.chainId;
    this.token = options.token.toLowerCase() as Address;
    this.receiptAttempts = options.receiptAttempts ?? 4;
    this.pollMs = options.pollMs ?? 1_000;
    const chain = defineChain({ id: options.chainId, name: `chain-${options.chainId}`, nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [options.rpcUrl] } } });
    this.client = createPublicClient({ chain, transport: http(options.rpcUrl, { timeout: options.timeoutMs }) });
  }

  /**
   * Connects and checks that the RPC serves the configured chain and that the token's own
   * DOMAIN_SEPARATOR equals the hash of the pinned EIP-712 domain, so the authorizations a payer
   * signs are the ones this token contract accepts.
   */
  static async connect(options: TokenTransferReaderOptions): Promise<TokenTransferReader> {
    const reader = new TokenTransferReader(options);
    const served = await reader.client.getChainId();
    if (served !== options.chainId) throw new TokenConfigurationError(`the payment RPC serves chain ${served}, not ${options.chainId}`);
    const pinned = tokenDomain(options.chainId, options.token);
    if (pinned === undefined) throw new TokenConfigurationError(`no EIP-712 domain is pinned for token ${options.token} on chain ${options.chainId}`);
    const onChain = await reader.client.readContract({ address: reader.token as Hex, abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR" });
    const expected = hashDomain({ domain: { name: pinned.name, version: pinned.version, chainId: BigInt(pinned.chainId), verifyingContract: pinned.verifyingContract as Hex }, types: { EIP712Domain: EIP712_DOMAIN_TYPE } });
    if (onChain.toLowerCase() !== expected.toLowerCase()) throw new TokenConfigurationError(`the token's DOMAIN_SEPARATOR does not match its pinned EIP-712 domain`);
    return reader;
  }

  async balanceOf(account: Address): Promise<bigint> {
    return this.client.readContract({ address: this.token as Hex, abi: TOKEN_ABI, functionName: "balanceOf", args: [account as Hex] });
  }

  /**
   * The token transfer in a transaction from `from` to `to`, or null when the chain does not have
   * the transaction. A reverted transaction is reported as reverted. A successful one without
   * such a transfer is reported with amount 0 and the transaction's own sender and target, so it
   * can never match a payment.
   */
  async transfer(txHash: string, expect: { from: string; to: string }): Promise<ChainTransfer | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error(`"${txHash}" is not a transaction hash`);
    const hash = txHash.toLowerCase() as Hex;
    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> | undefined;
    for (let attempt = 1; receipt === undefined; attempt++) {
      try {
        receipt = await this.client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        if (attempt >= this.receiptAttempts) return null;
        await sleep(this.pollMs);
      }
    }
    const head = await this.client.getBlockNumber();
    return transferFromReceipt(receipt, { head, chainId: this.chainId, token: this.token, ...expect });
  }
}

export interface ReceiptView {
  transactionHash: string;
  status: "success" | "reverted";
  from: string;
  to: string | null;
  blockNumber: bigint;
  logs: readonly { address: string; topics: readonly Hex[] | [Hex, ...Hex[]] | []; data: Hex }[];
}

/**
 * The transfer from `from` to `to` of `token` in a receipt. A reverted receipt is reported as
 * reverted. A successful one without exactly one such transfer is reported with amount 0 and the
 * transaction's own sender and target, so it can never match a payment.
 */
export function transferFromReceipt(receipt: ReceiptView, at: { head: bigint; chainId: number; token: string; from: string; to: string }): ChainTransfer {
  const token = at.token.toLowerCase();
  // A node behind the one that served the receipt can report an older head.
  const confirmations = Number((at.head > receipt.blockNumber ? at.head : receipt.blockNumber) - receipt.blockNumber) + 1;
  const base = { txHash: receipt.transactionHash.toLowerCase(), chainId: at.chainId, token, blockNumber: Number(receipt.blockNumber), confirmations };
  const unmatched = { from: receipt.from.toLowerCase(), to: (receipt.to ?? "").toLowerCase(), amountBaseUnits: "0" };
  if (receipt.status !== "success") return { ...base, ...unmatched, status: "reverted", authorizationNonce: null };

  const events = parseEventLogs({ abi: TOKEN_ABI, logs: receipt.logs.filter((log) => log.address.toLowerCase() === token) as Parameters<typeof parseEventLogs>[0]["logs"] });
  const from = at.from.toLowerCase();
  const to = at.to.toLowerCase();
  const transfers = events.flatMap((event) => (event.eventName === "Transfer" && event.args.from.toLowerCase() === from && event.args.to.toLowerCase() === to ? [event.args.value] : []));
  const used = events.flatMap((event) => (event.eventName === "AuthorizationUsed" && event.args.authorizer.toLowerCase() === from ? [event.args.nonce.toLowerCase()] : []));
  const authorizationNonce = used.length === 1 ? (used[0] as string) : null;
  if (transfers.length !== 1) return { ...base, ...unmatched, status: "success", authorizationNonce };
  return { ...base, from, to, amountBaseUnits: (transfers[0] as bigint).toString(), status: "success", authorizationNonce };
}

export { TOKEN_ABI as TOKEN_EVENTS_ABI };

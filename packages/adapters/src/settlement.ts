import type { TransferTerms } from "@settleback/domain";
import { decimalToBaseUnits } from "./amounts.ts";
import { caip2, classifyGatewayRecord, type GatewayPaymentRecord } from "./gateway.ts";

export interface ChainTransfer {
  txHash: string;
  chainId: number;
  token: string;
  from: string;
  to: string;
  amountBaseUnits: string;
  blockNumber: number;
  confirmations: number;
  status: "success" | "reverted";
}

/**
 * - VERIFIED: gateway record and on-chain transfer agree with the expected terms at the required level.
 * - PENDING: not yet at the required level; keep observing the same attempt.
 * - NO_TRANSFER_FOUND: the gateway reports failure without a transaction and none was found. The
 *   attempt stays UNKNOWN until an operator closes it with this evidence.
 * - MISMATCH: a transfer exists but does not match the expected terms; never counts as paid.
 * - REVERTED: the transaction reverted on chain; positive evidence that funds did not move.
 * - INCONSISTENT: gateway and chain contradict each other; quarantine, do not spend.
 */
export type SettlementStatus = "VERIFIED" | "PENDING" | "NO_TRANSFER_FOUND" | "MISMATCH" | "REVERTED" | "INCONSISTENT";

export interface SettlementVerdict {
  status: SettlementStatus;
  reasons: string[];
  txHash: string | null;
}

export interface SettlementCheckInput {
  expected: TransferTerms;
  tokenDecimals: number;
  record: GatewayPaymentRecord;
  transfer: ChainTransfer | null;
  requiredLevel: "SAFE" | "FINAL";
}

/**
 * Checks a gateway record against the chain instead of trusting either alone. The comparison
 * assumes the payee receives the principal on chain; how gateway fees appear on chain must be
 * confirmed against the live gateway before relying on this for real funds.
 */
export function verifySettlement(input: SettlementCheckInput): SettlementVerdict {
  const { expected, record, transfer } = input;
  const kind = classifyGatewayRecord(record);
  const txHash = record.tx_signature;

  if (kind === "FAILED_AFTER_INCLUSION") {
    return { status: "INCONSISTENT", reasons: ["gateway reports failure after the transaction was included"], txHash };
  }
  if (kind === "FAILED_NO_TRANSACTION") {
    return transfer === null
      ? { status: "NO_TRANSFER_FOUND", reasons: ["gateway reports no transaction and none was found"], txHash: null }
      : { status: "INCONSISTENT", reasons: ["gateway reports no transaction but a transfer exists"], txHash: transfer.txHash };
  }
  if (kind === "AWAITING_PAYER" || kind === "SUBMITTED" || kind === "INCLUDED" || (kind === "SAFE" && input.requiredLevel === "FINAL")) {
    return { status: "PENDING", reasons: [`gateway status ${record.status} is below ${input.requiredLevel}`], txHash };
  }

  const reasons: string[] = [];
  if (!sameAddress(record.to_pay_address, expected.payee)) reasons.push("gateway payee differs from the expected payee");
  if (record.payer_address === null || !sameAddress(record.payer_address, expected.payer)) {
    reasons.push("gateway payer differs from the expected payer");
  }
  if (!sameAddress(record.token_address, expected.token)) reasons.push("gateway token differs from the expected token");
  if (record.chain !== caip2(expected.chainId)) reasons.push("gateway chain differs from the expected chain");
  if (decimalOrNull(record.order_amount, input.tokenDecimals) !== expected.amountBaseUnits) {
    reasons.push("gateway order amount differs from the expected principal");
  }
  if (reasons.length > 0) return { status: "MISMATCH", reasons, txHash };

  if (txHash === null) return { status: "INCONSISTENT", reasons: ["gateway reports settlement without a transaction hash"], txHash };
  if (transfer === null) return { status: "INCONSISTENT", reasons: ["gateway transaction is not on chain"], txHash };
  if (transfer.txHash.toLowerCase() !== txHash.toLowerCase()) {
    return { status: "INCONSISTENT", reasons: ["chain transfer does not match the gateway transaction hash"], txHash };
  }
  if (transfer.status === "reverted") return { status: "REVERTED", reasons: ["transaction reverted on chain"], txHash };

  if (transfer.chainId !== expected.chainId) reasons.push("transfer is on a different chain");
  if (!sameAddress(transfer.token, expected.token)) reasons.push("transfer moved a different token");
  if (!sameAddress(transfer.from, expected.payer)) reasons.push("transfer came from a different payer");
  if (!sameAddress(transfer.to, expected.payee)) reasons.push("transfer went to a different payee");
  if (transfer.amountBaseUnits !== expected.amountBaseUnits) reasons.push("transfer amount differs from the expected principal");
  if (reasons.length > 0) return { status: "MISMATCH", reasons, txHash };

  return { status: "VERIFIED", reasons: [], txHash };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function decimalOrNull(value: string, decimals: number): string | null {
  try {
    return decimalToBaseUnits(value, decimals);
  } catch {
    return null;
  }
}

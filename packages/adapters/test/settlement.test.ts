import { describe, expect, it } from "vitest";
import type { TransferTerms } from "@settleback/domain";
import { verifySettlement, type ChainTransfer, type GatewayPaymentRecord } from "../src/index.ts";

const BUYER = "0x00000000000000000000000000000000000000b1";
const SELLER = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6";
const TX = `0x${"a".repeat(64)}`;

const expected: TransferTerms = { payer: BUYER, payee: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" };

const finalized: GatewayPaymentRecord = {
  payment_request_id: "pr-1",
  cart_mandate_id: "cart-1",
  flow_id: "flow-1",
  request_id: "req-1",
  status: "payment-finalized",
  status_reason: null,
  tx_signature: TX,
  payer_address: BUYER.toUpperCase().replace("0X", "0x"),
  to_pay_address: SELLER,
  token: "USDC",
  token_address: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
  chain: "eip155:133",
  network: "hashkey-testnet",
  product_amount: "1.00",
  order_amount: "1.00",
  usd_amount_rate: "1",
  pay_amount: "1.01",
  created_at: "2026-10-30T10:00:00Z",
  included_at: "2026-10-30T10:00:30Z",
  completed_at: "2026-10-30T10:03:00Z",
};

const transfer: ChainTransfer = {
  txHash: TX,
  chainId: 133,
  token: TOKEN,
  from: BUYER,
  to: SELLER,
  amountBaseUnits: "1000000",
  blockNumber: 10,
  confirmations: 5,
  status: "success",
};

function check(record: Partial<GatewayPaymentRecord> = {}, chain: ChainTransfer | null = transfer, requiredLevel: "SAFE" | "FINAL" = "FINAL") {
  return verifySettlement({ expected, tokenDecimals: 6, record: { ...finalized, ...record }, transfer: chain, requiredLevel });
}

describe("verifySettlement", () => {
  it("verifies when the gateway record and the chain transfer both match, regardless of address case", () => {
    expect(check()).toEqual({ status: "VERIFIED", reasons: [], txHash: TX });
  });

  it("treats a safe record as enough for SAFE and as pending for FINAL", () => {
    expect(check({ status: "payment-safe" }, transfer, "SAFE").status).toBe("VERIFIED");
    expect(check({ status: "payment-safe" }, transfer, "FINAL").status).toBe("PENDING");
  });

  it("keeps submitted and included payments pending", () => {
    for (const status of ["payment-required", "payment-submitted", "payment-verified", "payment-processing", "payment-included"] as const) {
      expect(check({ status }).status, status).toBe("PENDING");
    }
  });

  it("reports no transfer found only when the gateway failed without a transaction and the chain agrees", () => {
    expect(check({ status: "payment-failed", tx_signature: null }, null)).toEqual(
      expect.objectContaining({ status: "NO_TRANSFER_FOUND", txHash: null }),
    );
    expect(check({ status: "payment-failed", tx_signature: null }, transfer).status).toBe("INCONSISTENT");
  });

  it("flags failure after inclusion and a gateway transaction missing from the chain as inconsistent", () => {
    expect(check({ status: "payment-failed" }).status).toBe("INCONSISTENT");
    expect(check({}, null).status).toBe("INCONSISTENT");
    expect(check({ tx_signature: null }).status).toBe("INCONSISTENT");
    expect(check({}, { ...transfer, txHash: `0x${"b".repeat(64)}` }).status).toBe("INCONSISTENT");
  });

  it("never verifies a transfer to the wrong payee, from the wrong payer, in the wrong token, or for the wrong amount", () => {
    expect(check({}, { ...transfer, to: BUYER }).status).toBe("MISMATCH");
    expect(check({}, { ...transfer, from: SELLER }).status).toBe("MISMATCH");
    expect(check({}, { ...transfer, token: `0x${"e".repeat(40)}` }).status).toBe("MISMATCH");
    expect(check({}, { ...transfer, amountBaseUnits: "999999" }).status).toBe("MISMATCH");
    expect(check({}, { ...transfer, chainId: 177 }).status).toBe("MISMATCH");
  });

  it("checks the gateway record's own terms before looking at the chain", () => {
    expect(check({ order_amount: "1.01" }).status).toBe("MISMATCH");
    expect(check({ to_pay_address: BUYER }).status).toBe("MISMATCH");
    expect(check({ chain: "eip155:177" }).status).toBe("MISMATCH");
    expect(check({ payer_address: null }).status).toBe("MISMATCH");
  });

  it("does not let the fee-inclusive pay amount stand in for the principal", () => {
    expect(check({ order_amount: finalized.pay_amount }).status).toBe("MISMATCH");
  });

  it("reports a reverted transaction as positive evidence that funds did not move", () => {
    expect(check({}, { ...transfer, status: "reverted" }).status).toBe("REVERTED");
  });
});

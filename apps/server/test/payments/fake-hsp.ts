import { randomBytes } from "node:crypto";
import { verifyTypedData, type Hex } from "viem";
import { HspAgenticRail, RailTimeoutError, type ChainTransfer, type HspAgenticTools, type HspPaymentToken, type ManualClock } from "@settleback/adapters";
import type { CartContents } from "@settleback/adapters";

export const USDC_133: HspPaymentToken = { network: "hashkey-testnet", chainId: 133, address: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6", decimals: 6, symbol: "USDC", protocol: "eip3009" };
const DOMAIN = { name: "USD Coin", version: "2", chainId: 133, verifyingContract: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6" };
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

interface Order {
  flowId: string;
  paymentRequestId: string;
  cartMandateId: string;
  payTo: string;
  priceUsd: string;
  cartExpiry: string;
  status: string;
  tx: string | null;
  payer: string | null;
  prepared: Record<string, unknown>[];
}

/**
 * HSP Agentic Payment as its setup guide describes it, in process: orders keyed by payment request,
 * an EIP-3009 authorization prepared per call with a fresh nonce and a five-minute quote, the
 * payer's signature verified at finalize, and a transaction recorded at submit.
 */
export class FakeHsp implements HspAgenticTools {
  readonly orders = new Map<string, Order>();
  readonly calls: string[] = [];
  /** Network fee the payer carries inside the authorization, in base units. */
  feeBaseUnits = 0n;
  /** Overrides applied to the next prepared authorization's message. */
  tamper: Record<string, unknown> | undefined;
  loseNextSubmit = false;
  validForSeconds = 300;
  /** Lets each authorization stay valid until its cart expires, as a gateway may choose to. */
  validUntilCartExpiry = false;
  private readonly clock: ManualClock;

  constructor(clock: ManualClock) {
    this.clock = clock;
  }

  rail(transfers: { transfer(txHash: string, expect: { from: string; to: string }): Promise<ChainTransfer | null> }): HspAgenticRail {
    return new HspAgenticRail({ client: this, transfers, merchantName: "SettleBack", token: USDC_133, clock: this.clock });
  }

  async createOrder(input: { merchantName: string; payTo: string; contents: CartContents }) {
    this.calls.push("create_order");
    const id = input.contents.payment_request.details.id;
    if (this.orders.has(id)) throw new Error("duplicate order");
    this.orders.set(id, { flowId: `flow-${id}`, paymentRequestId: id, cartMandateId: input.contents.id, payTo: input.payTo.toLowerCase(), priceUsd: input.contents.payment_request.details.total.amount.value, cartExpiry: input.contents.cart_expiry, status: "payment-required", tx: null, payer: null, prepared: [] });
    return { flowId: `flow-${id}`, paymentRequestId: id, paymentUrl: null };
  }

  async preparePayment(input: { flowId: string; payer: string; protocol: "eip3009" }) {
    this.calls.push("prepare_payment");
    const order = this.byFlow(input.flowId);
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const value = (BigInt(Math.round(Number(order.priceUsd) * 1e6)) + this.feeBaseUnits).toString();
    const validBefore = this.validUntilCartExpiry ? Math.floor(Date.parse(order.cartExpiry) / 1000) : now + this.validForSeconds;
    const message = { from: input.payer, to: order.payTo, value, validAfter: "0", validBefore: String(validBefore), nonce: `0x${randomBytes(32).toString("hex")}`, ...this.tamper };
    this.tamper = undefined;
    const prepared = {
      eip712: { domain: DOMAIN, types: TYPES, primaryType: "TransferWithAuthorization", message },
      cart_hash: randomBytes(32).toString("hex"),
      token_total_raw: message.value,
      quote_expires_at: new Date(this.clock.now().getTime() + 5 * 60_000).toISOString(),
      pay_to: order.payTo,
      payer: input.payer,
      payment_request_id: order.paymentRequestId,
      payment_payload: { x402Version: 2, payload: { signature: "" } },
      payment_mandate_contents: { payment_mandate_id: order.paymentRequestId },
    };
    order.prepared.push(prepared);
    return prepared;
  }

  async finalizePayment(input: { signature: string; cartHash: string }) {
    this.calls.push("finalize_payment");
    const order = [...this.orders.values()].find((entry) => entry.prepared.some((prepared) => prepared.cart_hash === input.cartHash));
    const prepared = order?.prepared.find((entry) => entry.cart_hash === input.cartHash);
    if (order === undefined || prepared === undefined) throw new Error("unknown cart");
    const typed = prepared.eip712 as { message: { from: string } };
    const valid = await verifyTypedData({ address: typed.message.from as Hex, signature: input.signature as Hex, ...(typed as object) } as never);
    if (!valid) throw new Error("signature does not match the prepared authorization");
    return JSON.stringify({ flow: order.flowId, cartHash: input.cartHash, payer: typed.message.from });
  }

  async submitPayment(mandate: unknown) {
    this.calls.push("submit_payment");
    const { flow, payer } = JSON.parse(String(mandate)) as { flow: string; payer: string };
    const order = this.byFlow(flow);
    order.status = "payment-submitted";
    order.tx = `0x${randomBytes(32).toString("hex")}`;
    order.payer = payer.toLowerCase();
    if (this.loseNextSubmit) {
      this.loseNextSubmit = false;
      throw new RailTimeoutError("HSP submit_payment (the connection failed after the request may have been sent)");
    }
    return { status: "payment-submitted" };
  }

  async queryPayment(input: { paymentRequestId: string; merchantName: string }) {
    this.calls.push("query_payment");
    const order = this.orders.get(input.paymentRequestId);
    if (order === undefined) throw new Error("no such payment");
    return {
      status: order.status,
      attribution_verified: input.merchantName === "SettleBack",
      payment: {
        payment_request_id: order.paymentRequestId,
        cart_mandate_id: order.cartMandateId,
        flow_id: order.flowId,
        tx_signature: order.tx ?? "",
        payer_address: order.payer ?? "",
        to_pay_address: order.payTo,
        token: "USDC",
        token_address: USDC_133.address,
        chain: "eip155:133",
        network: "hashkey-testnet",
        product_amount: order.priceUsd,
        order_amount: order.priceUsd,
        pay_amount: order.priceUsd,
        created_at: "2026-10-30T10:00:00Z",
      },
    };
  }

  /** The last authorization prepared for an order: what a gateway would execute. */
  lastPrepared(paymentRequestId: string): { value: string; nonce: string } {
    const prepared = this.orders.get(paymentRequestId)?.prepared.at(-1);
    if (prepared === undefined) throw new Error("nothing prepared");
    const message = (prepared.eip712 as { message: { value: string; nonce: string } }).message;
    return { value: message.value, nonce: message.nonce };
  }

  settle(paymentRequestId: string, status: string): void {
    const order = this.orders.get(paymentRequestId);
    if (order === undefined) throw new Error("no such payment");
    order.status = status;
  }

  private byFlow(flowId: string): Order {
    const order = [...this.orders.values()].find((entry) => entry.flowId === flowId);
    if (order === undefined) throw new Error("unknown flow");
    return order;
  }
}

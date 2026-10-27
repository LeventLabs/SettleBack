import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "@settleback/domain/hash";
import { baseUnitsToDecimal, decimalToBaseUnits } from "../amounts.ts";
import type { Clock } from "../clock.ts";
import { caip2, type GatewayPaymentRecord } from "../gateway.ts";
import { RailRejectedError, RailTimeoutError, RailUnavailableError, type PrepareInput, type SignedPayload } from "../rail.ts";
import { signWebhook } from "../webhook.ts";
import type { SimChain } from "./chain.ts";

export type GatewayFault =
  | { kind: "lose-create-response" }
  | { kind: "lose-submit-response" }
  | { kind: "broadcast-never-succeeds" }
  | { kind: "included-then-failed" }
  | { kind: "delayed-finality"; extraTicks: number }
  | { kind: "wrong-receipt"; field: "amount" | "payee" | "token" }
  | { kind: "unknown-transaction" }
  | { kind: "query-unavailable"; times: number }
  | { kind: "webhook-unreachable" };

/** Documented retry delays after each failed webhook delivery; the notification is FAILED after the last. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000] as const;

export type WebhookReceiver = (signatureHeader: string, rawBody: string) => Promise<number> | number;

export interface WebhookAttempt {
  at: string;
  status: GatewayPaymentRecord["status"];
  outcome: "delivered" | "failed";
}

interface Notification {
  status: GatewayPaymentRecord["status"];
  rawBody: string;
  attempts: number;
  nextAttemptAt: number;
  state: "PENDING" | "DELIVERED" | "FAILED";
}

interface Order {
  input: PrepareInput;
  cartSha256: string;
  record: GatewayPaymentRecord;
  faults: GatewayFault[];
  delayRemaining: number;
  notifications: Notification[];
  attempts: WebhookAttempt[];
}

/** Gateway error codes from the public documentation. */
export class GatewayError extends RailRejectedError {
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(code, message);
    this.name = "GatewayError";
    this.httpStatus = httpStatus;
  }
}

// The simulator prices tokens at a pinned 1 USD per token and adds a fixed fee to pay_amount.
// The live rate and fee behavior are confirmed against the real gateway before use.
const SIMULATED_FEE_BASE_UNITS = "10000";

/**
 * A deterministic stand-in for the HSP Merchant gateway. It follows the documented order, status,
 * and webhook behavior, and moves only when `tick()` and `deliverDueWebhooks()` are called.
 */
export class SimGateway {
  private readonly clock: Clock;
  private readonly chain: SimChain;
  private readonly webhookSecret: string;
  private readonly orders = new Map<string, Order>();
  private readonly cartIndex = new Map<string, string>();
  private readonly pendingFaults = new Map<string, GatewayFault[]>();
  private receiver: WebhookReceiver | undefined;
  private flowCounter = 0;

  constructor(options: { clock: Clock; chain: SimChain; webhookSecret: string }) {
    this.clock = options.clock;
    this.chain = options.chain;
    this.webhookSecret = options.webhookSecret;
  }

  /** Registers a fault for an order that exists or will be created with this payment request ID. */
  injectFault(paymentRequestId: string, fault: GatewayFault): void {
    const order = this.orders.get(paymentRequestId);
    if (order !== undefined) order.faults.push(fault);
    else this.pendingFaults.set(paymentRequestId, [...(this.pendingFaults.get(paymentRequestId) ?? []), fault]);
  }

  setWebhookReceiver(receiver: WebhookReceiver | undefined): void {
    this.receiver = receiver;
  }

  createOrder(input: PrepareInput): { payment_request_id: string; flow_id: string; payment_url: string; cart_sha256: string } {
    if (this.cartIndex.has(input.cartMandateId)) {
      throw new GatewayError("40001", 400, "Invalid mandate state: cart_mandate_id already used");
    }
    if (this.orders.has(input.paymentRequestId)) {
      throw new GatewayError("10004", 409, "Conflict: duplicate payment_request_id");
    }
    const amountBaseUnits = decimalToBaseUnits(input.priceUsd, input.tokenDecimals);
    const principal = baseUnitsToDecimal(amountBaseUnits, input.tokenDecimals);
    const gross = baseUnitsToDecimal((BigInt(amountBaseUnits) + BigInt(SIMULATED_FEE_BASE_UNITS)).toString(), input.tokenDecimals);
    const cartSha256 = sha256Hex(
      canonicalJson({
        id: input.cartMandateId,
        payment_request_id: input.paymentRequestId,
        pay_to: input.payee,
        chain_id: input.chainId,
        contract_address: input.token,
        total_usd: input.priceUsd,
        cart_expiry: input.expiresAt,
      }),
    );
    this.flowCounter += 1;
    const flowId = `sim-flow-${this.flowCounter}`;
    const faults = this.pendingFaults.get(input.paymentRequestId) ?? [];
    this.pendingFaults.delete(input.paymentRequestId);

    const order: Order = {
      input,
      cartSha256,
      faults,
      delayRemaining: 0,
      notifications: [],
      attempts: [],
      record: {
        payment_request_id: input.paymentRequestId,
        cart_mandate_id: input.cartMandateId,
        flow_id: flowId,
        request_id: null,
        status: "payment-required",
        status_reason: null,
        tx_signature: null,
        payer_address: null,
        to_pay_address: input.payee,
        token: "USDC",
        token_address: input.token,
        chain: caip2(input.chainId),
        network: input.chainId === 177 ? "hashkey" : "hashkey-testnet",
        product_amount: principal,
        order_amount: principal,
        pay_amount: gross,
        created_at: this.clock.now().toISOString(),
        included_at: null,
        completed_at: null,
      },
    };
    this.orders.set(input.paymentRequestId, order);
    this.cartIndex.set(input.cartMandateId, input.paymentRequestId);

    if (this.consumeFault(order, "lose-create-response")) throw new RailTimeoutError("create order");
    return { payment_request_id: input.paymentRequestId, flow_id: flowId, payment_url: `https://sim.invalid/flow/${flowId}`, cart_sha256: cartSha256 };
  }

  query(paymentRequestId: string): GatewayPaymentRecord {
    const order = this.orders.get(paymentRequestId);
    if (order !== undefined) {
      const outage = order.faults.find((fault) => fault.kind === "query-unavailable");
      if (outage?.kind === "query-unavailable" && outage.times > 0) {
        outage.times -= 1;
        throw new RailUnavailableError("query payment");
      }
    }
    if (order === undefined) throw new GatewayError("10003", 404, "Not found");
    return { ...order.record };
  }

  submitPaymentMandate(signed: SignedPayload): void {
    const { payload } = signed;
    const order = this.orders.get(payload.paymentRequestId);
    if (order === undefined) throw new GatewayError("10003", 404, "Not found");
    if (order.record.status !== "payment-required") {
      throw new GatewayError("40001", 400, "Invalid mandate state: payment already submitted");
    }
    const expectedAmount = decimalToBaseUnits(order.input.priceUsd, order.input.tokenDecimals);
    if (
      payload.payee.toLowerCase() !== order.input.payee.toLowerCase() ||
      payload.token.toLowerCase() !== order.input.token.toLowerCase() ||
      payload.chainId !== order.input.chainId ||
      payload.amountBaseUnits !== expectedAmount ||
      signed.signature !== simulatedSignature(payload.payer, payload.nonce)
    ) {
      throw new GatewayError("10001", 400, "Invalid parameters: payment mandate does not match the order");
    }
    order.record = {
      ...order.record,
      status: "payment-submitted",
      payer_address: payload.payer,
      request_id: `sim-req-${payload.nonce.slice(0, 16)}`,
    };
    if (this.consumeFault(order, "lose-submit-response")) throw new RailTimeoutError("submit payment mandate");
  }

  /** Advances every in-flight payment by one documented status step and mines one block. */
  tick(): void {
    this.chain.mine();
    for (const order of this.orders.values()) this.advance(order);
  }

  async deliverDueWebhooks(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const order of this.orders.values()) {
      for (const notification of order.notifications) {
        if (notification.state !== "PENDING" || notification.nextAttemptAt > now) continue;
        const delivered = await this.attemptDelivery(order, notification);
        notification.attempts += 1;
        order.attempts.push({ at: new Date(now).toISOString(), status: notification.status, outcome: delivered ? "delivered" : "failed" });
        if (delivered) {
          notification.state = "DELIVERED";
          continue;
        }
        const delay = WEBHOOK_RETRY_DELAYS_MS[notification.attempts - 1];
        if (delay === undefined) notification.state = "FAILED";
        else notification.nextAttemptAt = now + delay;
      }
    }
  }

  webhookAttempts(paymentRequestId: string): WebhookAttempt[] {
    return [...(this.orders.get(paymentRequestId)?.attempts ?? [])];
  }

  webhookStates(paymentRequestId: string): Notification["state"][] {
    return (this.orders.get(paymentRequestId)?.notifications ?? []).map((n) => n.state);
  }

  orderCount(): number {
    return this.orders.size;
  }

  private advance(order: Order): void {
    const record = order.record;
    switch (record.status) {
      case "payment-submitted":
        this.setStatus(order, "payment-verified");
        return;
      case "payment-verified":
        this.setStatus(order, "payment-processing");
        return;
      case "payment-processing":
        this.broadcast(order);
        return;
      case "payment-included": {
        const delay = order.faults.find((fault) => fault.kind === "delayed-finality");
        if (delay?.kind === "delayed-finality" && order.delayRemaining === 0 && delay.extraTicks > 0) {
          order.delayRemaining = delay.extraTicks;
          delay.extraTicks = 0;
        }
        if (order.delayRemaining > 0) {
          order.delayRemaining -= 1;
          return;
        }
        if (this.consumeFault(order, "included-then-failed")) {
          if (record.tx_signature !== null) this.chain.dropTransfer(record.tx_signature);
          this.setStatus(order, "payment-failed", "transaction dropped by chain reorganization");
          return;
        }
        this.setStatus(order, "payment-safe");
        return;
      }
      case "payment-safe":
        order.record = { ...order.record, completed_at: this.clock.now().toISOString() };
        this.setStatus(order, "payment-finalized", "Block finalized");
        return;
      default:
        return;
    }
  }

  private broadcast(order: Order): void {
    if (this.consumeFault(order, "broadcast-never-succeeds")) {
      this.setStatus(order, "payment-failed", "timeout reconciliation: no tx_signature, broadcast never succeeded");
      return;
    }
    const txHash = this.chain.nextTxHash();
    const payer = order.record.payer_address ?? "";
    const amount = decimalToBaseUnits(order.input.priceUsd, order.input.tokenDecimals);
    if (!this.consumeFault(order, "unknown-transaction")) {
      const wrong = order.faults.find((fault) => fault.kind === "wrong-receipt");
      this.chain.includeTransfer({
        txHash,
        token: wrong?.kind === "wrong-receipt" && wrong.field === "token" ? `0x${"e".repeat(40)}` : order.input.token,
        from: payer,
        to: wrong?.kind === "wrong-receipt" && wrong.field === "payee" ? `0x${"d".repeat(40)}` : order.input.payee,
        amountBaseUnits: wrong?.kind === "wrong-receipt" && wrong.field === "amount" ? (BigInt(amount) - 1n).toString() : amount,
        status: "success",
      });
    }
    order.record = { ...order.record, tx_signature: txHash, included_at: this.clock.now().toISOString() };
    this.setStatus(order, "payment-included");
  }

  private setStatus(order: Order, status: GatewayPaymentRecord["status"], reason: string | null = null): void {
    order.record = { ...order.record, status, status_reason: reason };
    if (status === "payment-included" || status === "payment-safe" || status === "payment-finalized" || status === "payment-failed") {
      order.notifications.push({
        status,
        rawBody: JSON.stringify(webhookPayload(order.record)),
        attempts: 0,
        nextAttemptAt: this.clock.now().getTime(),
        state: "PENDING",
      });
    }
  }

  private async attemptDelivery(order: Order, notification: Notification): Promise<boolean> {
    if (order.faults.some((fault) => fault.kind === "webhook-unreachable") || this.receiver === undefined) return false;
    const header = signWebhook(this.webhookSecret, Math.floor(this.clock.now().getTime() / 1000), notification.rawBody);
    try {
      const status = await this.receiver(header, notification.rawBody);
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  private consumeFault(order: Order, kind: GatewayFault["kind"]): boolean {
    const index = order.faults.findIndex((fault) => fault.kind === kind);
    if (index === -1) return false;
    order.faults.splice(index, 1);
    return true;
  }
}

/** Placeholder signature for simulated payloads; the live signing scheme awaits official documentation. */
export function simulatedSignature(payer: string, nonce: string): string {
  return `sim-signature:${createHash("sha256").update(`${payer.toLowerCase()}:${nonce}`).digest("hex")}`;
}

function webhookPayload(record: GatewayPaymentRecord): Record<string, unknown> {
  return {
    event_type: "payment",
    payment_request_id: record.payment_request_id,
    request_id: record.request_id,
    cart_mandate_id: record.cart_mandate_id,
    payer_address: record.payer_address,
    to_pay_address: record.to_pay_address,
    amount: record.pay_amount,
    order_amount: record.order_amount,
    product_amount: record.product_amount,
    pay_amount: record.pay_amount,
    token: record.token,
    token_address: record.token_address,
    chain: record.chain,
    network: record.network,
    status: record.status,
    status_reason: record.status_reason,
    created_at: record.created_at,
    tx_signature: record.tx_signature,
    included_at: record.included_at,
    completed_at: record.completed_at,
  };
}

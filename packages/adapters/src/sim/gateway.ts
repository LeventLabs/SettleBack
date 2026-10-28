import { createHash, type KeyObject } from "node:crypto";
import { baseUnitsToDecimal, decimalToBaseUnits } from "../amounts.ts";
import type { Clock } from "../clock.ts";
import { GatewayError, caip2, type GatewayPaymentRecord } from "../gateway.ts";
import { CartShapeError, cartAmountProblems, cartHash, effectiveTotal, normalizeMethod, parseCartMandate, X402_METHOD, type CartContents } from "../hsp/cart-mandate.ts";
import { verifyMerchantJwt } from "../hsp/jwt.ts";
import { ORDERS_PATH, PAYMENTS_PATH, type MerchantHttpRequest, type MerchantHttpResponse } from "../hsp/merchant-client.ts";
import { REQUEST_SKEW_SECONDS, verifyMerchantRequest } from "../hsp/request-signing.ts";
import { RailTimeoutError, RailUnavailableError, type SignedPayload } from "../rail.ts";
import { signWebhook } from "../webhook.ts";
import type { SimChain } from "./chain.ts";

export { GatewayError };

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

/** An application registered in the merchant console: HMAC credentials and the merchant's public key. */
export interface SimMerchantApp {
  appKey: string;
  appSecret: string;
  merchantName: string;
  publicKey: KeyObject;
}

interface Notification {
  status: GatewayPaymentRecord["status"];
  rawBody: string;
  attempts: number;
  nextAttemptAt: number;
  state: "PENDING" | "DELIVERED" | "FAILED";
}

interface Order {
  app: SimMerchantApp;
  contents: CartContents;
  cartSha256: string;
  /** The method_data entry the record currently describes; fixed by the payer's submission. */
  methodIndex: number;
  record: GatewayPaymentRecord;
  faults: GatewayFault[];
  delayRemaining: number;
  notifications: Notification[];
  attempts: WebhookAttempt[];
}

// The simulator prices tokens at a pinned 1 USD per token and adds a fixed fee to pay_amount.
// The live rate and fee behavior are confirmed against the real gateway before use.
const SIMULATED_FEE_BASE_UNITS = "10000";
const SIMULATED_USD_RATE = "1";

/**
 * A deterministic stand-in for the HSP Merchant gateway. Merchant calls arrive as HTTP-shaped
 * requests and are checked the way the documentation describes: HMAC request signing with a
 * nonce window, the ES256K merchant JWT against the registered public key, the canonical cart
 * hash, the amount rules, expiry, and one-time cart IDs. Payment Mandate submission is not
 * publicly documented, so it is a labeled simulated call. Time moves only through `tick()`.
 */
export class SimGateway {
  private readonly clock: Clock;
  private readonly chain: SimChain;
  private readonly tokenDecimals: number;
  private readonly apps = new Map<string, SimMerchantApp>();
  private readonly nonces = new Map<string, number>();
  private readonly orders = new Map<string, Order>();
  private readonly cartIndex = new Map<string, string>();
  private readonly pendingFaults = new Map<string, GatewayFault[]>();
  private receiver: WebhookReceiver | undefined;
  private flowCounter = 0;

  constructor(options: { clock: Clock; chain: SimChain; tokenDecimals?: number }) {
    this.clock = options.clock;
    this.chain = options.chain;
    this.tokenDecimals = options.tokenDecimals ?? 6;
  }

  registerApp(app: SimMerchantApp): void {
    this.apps.set(app.appKey, app);
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

  /** The Merchant API over an in-process transport. Throws the transport errors a lost or unreachable request produces. */
  async handle(request: MerchantHttpRequest): Promise<MerchantHttpResponse> {
    const app = this.apps.get(request.headers["X-App-Key"] ?? "");
    if (app === undefined) return envelope(401, 10002, "missing app_key");
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const verified = verifyMerchantRequest(
      { method: request.method, path: request.path, query: request.query, body: request.body },
      request.headers,
      app.appSecret,
      nowSeconds,
      (nonce) => this.seenNonce(app.appKey, nonce, nowSeconds),
    );
    if (!verified.ok) return envelope(401, 10002, `Unauthorized: ${verified.reason}`);

    try {
      if (request.method === "POST" && request.path === ORDERS_PATH && request.query === "") {
        const data = this.createOrder(app, request.body ?? "");
        const order = this.orders.get(data.payment_request_id);
        if (order !== undefined && this.consumeFault(order, "lose-create-response")) throw new RailTimeoutError("create order");
        return envelope(200, 0, "success", data);
      }
      if (request.method === "GET" && request.path === PAYMENTS_PATH) {
        const params = new URLSearchParams(request.query);
        const keys = [...params.keys()];
        if (keys.length !== 1) return envelope(400, 10001, "Invalid parameters: exactly one query parameter");
        const [key] = keys;
        const value = params.get(key ?? "") ?? "";
        if (key === "payment_request_id") return envelope(200, 0, "success", documented(this.queryFor(app, value)));
        if (key === "cart_mandate_id") {
          const id = this.cartIndex.get(value);
          return envelope(200, 0, "success", id === undefined ? [] : [documented(this.queryFor(app, id))]);
        }
        return envelope(400, 10001, "Invalid parameters: unsupported query parameter");
      }
      return envelope(404, 10003, "Not found");
    } catch (error) {
      if (error instanceof GatewayError) return envelope(error.httpStatus, Number(error.code), error.message);
      throw error;
    }
  }

  /** The current record, for the simulated chain observer and tests. */
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

  /**
   * Simulated Payment Mandate submission. It accepts only a payload bound to the order's cart hash,
   * naming one of the cart's payment options, for that option's amount due.
   */
  submitPaymentMandate(signed: SignedPayload): void {
    const { payload } = signed;
    const order = this.orders.get(payload.paymentRequestId);
    if (order === undefined) throw new GatewayError("10003", 404, "Not found");
    if (order.record.status !== "payment-required") throw new GatewayError("40001", 400, "Invalid mandate state: payment already submitted");
    if (Date.parse(order.contents.cart_expiry) <= this.clock.now().getTime()) throw new GatewayError("40001", 400, "Invalid mandate state: cart expired");
    const methodIndex = order.contents.payment_request.method_data.findIndex(
      (method) =>
        method.data.chain_id === payload.chainId &&
        method.data.contract_address.toLowerCase() === payload.token.toLowerCase() &&
        method.data.pay_to.toLowerCase() === payload.payee.toLowerCase(),
    );
    const expectedAmount = methodIndex === -1 ? undefined : decimalToBaseUnits(effectiveTotal(order.contents, methodIndex), this.tokenDecimals);
    if (
      payload.cartMandateId !== order.contents.id ||
      payload.cartSha256 !== order.cartSha256 ||
      methodIndex === -1 ||
      payload.amountBaseUnits !== expectedAmount ||
      signed.signature !== simulatedSignature(payload.payer, payload.nonce)
    ) {
      throw new GatewayError("10001", 400, "Invalid parameters: payment mandate does not match the order");
    }
    order.methodIndex = methodIndex;
    order.record = {
      ...this.describe(order),
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

  private createOrder(app: SimMerchantApp, body: string): { payment_request_id: string; payment_url: string; multi_pay: false } {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new GatewayError("10001", 400, "Invalid parameters: body is not JSON");
    }
    const rawContents = (raw as { cart_mandate?: { contents?: unknown } } | null)?.cart_mandate?.contents;
    let contents: CartContents;
    let authorization: string;
    let hash: string;
    try {
      const mandate = parseCartMandate((raw as { cart_mandate?: unknown }).cart_mandate);
      contents = mandate.contents;
      authorization = mandate.merchant_authorization;
      hash = cartHash(rawContents);
    } catch (error) {
      if (error instanceof CartShapeError || error instanceof Error) throw new GatewayError("10001", 400, `Invalid parameters: ${error.message}`);
      throw error;
    }
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const jwt = verifyMerchantJwt(authorization, app.publicKey, hash, nowSeconds);
    if (!jwt.ok) throw new GatewayError("10002", 401, `Unauthorized: merchant_authorization ${jwt.reason}`);
    if (contents.payment_request.method_data.some((method) => normalizeMethod(method.supported_methods) !== normalizeMethod(X402_METHOD))) {
      throw new GatewayError("10001", 400, "Invalid parameters: only x402 payment methods are supported");
    }
    const problems = cartAmountProblems(contents);
    if (problems.length > 0) throw new GatewayError("10001", 400, `Invalid parameters: ${problems.join("; ")}`);
    const expiry = Date.parse(contents.cart_expiry);
    if (!Number.isFinite(expiry) || expiry <= this.clock.now().getTime()) throw new GatewayError("40001", 400, "Invalid mandate state: cart expired");
    if (this.cartIndex.has(contents.id)) throw new GatewayError("40001", 400, "Invalid mandate state: cart_mandate_id already used");
    const paymentRequestId = contents.payment_request.details.id;
    if (this.orders.has(paymentRequestId)) throw new GatewayError("10004", 409, "Conflict: duplicate payment_request_id");

    this.flowCounter += 1;
    const faults = this.pendingFaults.get(paymentRequestId) ?? [];
    this.pendingFaults.delete(paymentRequestId);
    const order: Order = {
      app,
      contents,
      cartSha256: hash,
      methodIndex: 0,
      faults,
      delayRemaining: 0,
      notifications: [],
      attempts: [],
      record: {} as GatewayPaymentRecord,
    };
    order.record = {
      ...this.describe(order),
      flow_id: `sim-flow-${this.flowCounter}`,
      request_id: null,
      status: "payment-required",
      status_reason: null,
      tx_signature: null,
      payer_address: null,
      created_at: this.clock.now().toISOString(),
      included_at: null,
      completed_at: null,
    };
    this.orders.set(paymentRequestId, order);
    this.cartIndex.set(contents.id, paymentRequestId);
    return { payment_request_id: paymentRequestId, payment_url: `https://sim.invalid/flow/${order.record.flow_id}`, multi_pay: false };
  }

  /** The record fields that follow from the cart and the selected payment option. */
  private describe(order: Order): GatewayPaymentRecord {
    const method = order.contents.payment_request.method_data[order.methodIndex];
    if (method === undefined) throw new Error("unreachable: order has no payment option");
    const product = decimalToBaseUnits(order.contents.payment_request.details.total.amount.value, this.tokenDecimals);
    const due = decimalToBaseUnits(effectiveTotal(order.contents, order.methodIndex), this.tokenDecimals);
    return {
      ...order.record,
      payment_request_id: order.contents.payment_request.details.id,
      cart_mandate_id: order.contents.id,
      to_pay_address: method.data.pay_to,
      token: method.data.coin,
      token_address: method.data.contract_address,
      chain: caip2(method.data.chain_id),
      network: method.data.network,
      product_amount: baseUnitsToDecimal(product, this.tokenDecimals),
      order_amount: baseUnitsToDecimal(due, this.tokenDecimals),
      pay_amount: baseUnitsToDecimal((BigInt(due) + BigInt(SIMULATED_FEE_BASE_UNITS)).toString(), this.tokenDecimals),
      usd_amount_rate: SIMULATED_USD_RATE,
    };
  }

  private queryFor(app: SimMerchantApp, paymentRequestId: string): GatewayPaymentRecord {
    const record = this.query(paymentRequestId);
    if (this.orders.get(paymentRequestId)?.app.appKey !== app.appKey) throw new GatewayError("10003", 404, "Not found");
    return record;
  }

  private seenNonce(appKey: string, nonce: string, nowSeconds: number): boolean {
    for (const [key, at] of this.nonces) if (nowSeconds - at > REQUEST_SKEW_SECONDS) this.nonces.delete(key);
    const key = `${appKey}:${nonce}`;
    if (this.nonces.has(key)) return true;
    this.nonces.set(key, nowSeconds);
    return false;
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
    const amount = decimalToBaseUnits(order.record.order_amount, this.tokenDecimals);
    if (!this.consumeFault(order, "unknown-transaction")) {
      const wrong = order.faults.find((fault) => fault.kind === "wrong-receipt");
      this.chain.includeTransfer({
        txHash,
        token: wrong?.kind === "wrong-receipt" && wrong.field === "token" ? `0x${"e".repeat(40)}` : order.record.token_address,
        from: payer,
        to: wrong?.kind === "wrong-receipt" && wrong.field === "payee" ? `0x${"d".repeat(40)}` : order.record.to_pay_address,
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

  /** Webhooks are signed with the application's app_secret, as documented. */
  private async attemptDelivery(order: Order, notification: Notification): Promise<boolean> {
    if (order.faults.some((fault) => fault.kind === "webhook-unreachable") || this.receiver === undefined) return false;
    const header = signWebhook(order.app.appSecret, Math.floor(this.clock.now().getTime() / 1000), notification.rawBody);
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

function envelope(status: number, code: number, msg: string, data?: unknown): MerchantHttpResponse {
  return { status, body: JSON.stringify(data === undefined ? { code, msg } : { code, msg, data }) };
}

/** The record as the documented query returns it: the cart mandate ID is `content_id`. */
function documented(record: GatewayPaymentRecord): Record<string, unknown> {
  const { cart_mandate_id: cartMandateId, ...rest } = record;
  return { ...rest, content_id: cartMandateId };
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

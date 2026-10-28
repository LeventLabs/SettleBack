import { randomBytes, type KeyObject } from "node:crypto";
import { canonicalJson, type CanonicalValue } from "@settleback/domain/hash";
import type { Clock } from "../clock.ts";
import { GATEWAY_STATUSES, GatewayError, type GatewayPaymentRecord, type GatewayStatus } from "../gateway.ts";
import { RailTimeoutError, RailUnavailableError } from "../rail.ts";
import { cartHash, type CartContents, type CartMandate } from "./cart-mandate.ts";
import { MERCHANT_AUDIENCE, signMerchantJwt } from "./jwt.ts";
import { signMerchantRequest } from "./request-signing.ts";

export const ORDERS_PATH = "/api/v1/merchant/orders";
export const PAYMENTS_PATH = "/api/v1/merchant/payments";

export interface MerchantHttpRequest {
  method: "GET" | "POST";
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface MerchantHttpResponse {
  status: number;
  body: string;
}

/**
 * Carries one request to the gateway. It throws RailTimeoutError when a sent request's outcome is
 * unknown and RailUnavailableError when the request could not be sent.
 */
export type MerchantTransport = (request: MerchantHttpRequest) => Promise<MerchantHttpResponse>;

/** The receiving agent's gateway credentials. The private key and app secret never leave its server. */
export interface MerchantCredentials {
  appKey: string;
  appSecret: string;
  merchantName: string;
  privateKey: KeyObject;
}

export interface CreatedOrder {
  payment_request_id: string;
  payment_url: string;
  multi_pay: boolean;
}

/** How long a merchant authorization stays valid, as in the documentation's example. */
const JWT_LIFETIME_SECONDS = 3600;

/**
 * The receiving agent's side of the Merchant API: it signs Cart Mandates and calls the gateway with
 * HMAC-signed requests. It never retries; callers decide what to do after a timeout.
 */
export class MerchantClient {
  private readonly credentials: MerchantCredentials;
  private readonly transport: MerchantTransport;
  private readonly clock: Clock;

  constructor(options: { credentials: MerchantCredentials; transport: MerchantTransport; clock: Clock }) {
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.clock = options.clock;
  }

  get merchantName(): string {
    return this.credentials.merchantName;
  }

  /** Signs the contents: canonical JSON, SHA-256 cart_hash, then an ES256K merchant JWT over it. */
  signCartMandate(contents: CartContents): CartMandate {
    if (contents.merchant_name !== this.credentials.merchantName) throw new Error("cart merchant_name must match the merchant credentials");
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const jwt = signMerchantJwt(
      {
        iss: this.credentials.merchantName,
        sub: this.credentials.merchantName,
        aud: MERCHANT_AUDIENCE,
        iat,
        exp: iat + JWT_LIFETIME_SECONDS,
        jti: `JWT-${iat}-${randomBytes(8).toString("hex")}`,
        cart_hash: cartHash(contents),
      },
      this.credentials.privateKey,
    );
    return { contents, merchant_authorization: jwt };
  }

  async createOrder(cartMandate: CartMandate, redirectUrl?: string): Promise<CreatedOrder> {
    const body = redirectUrl === undefined ? { cart_mandate: cartMandate } : { cart_mandate: cartMandate, redirect_url: redirectUrl };
    const data = await this.call("POST", ORDERS_PATH, "", body);
    const order = object(data, "order response");
    if (typeof order.payment_request_id !== "string" || typeof order.payment_url !== "string" || typeof order.multi_pay !== "boolean") {
      throw new RailUnavailableError("create order: unexpected response shape");
    }
    return { payment_request_id: order.payment_request_id, payment_url: order.payment_url, multi_pay: order.multi_pay };
  }

  async paymentByRequestId(paymentRequestId: string): Promise<GatewayPaymentRecord> {
    return parsePaymentRecord(await this.call("GET", PAYMENTS_PATH, `payment_request_id=${encodeURIComponent(paymentRequestId)}`, undefined));
  }

  async paymentsByCartMandateId(cartMandateId: string): Promise<GatewayPaymentRecord[]> {
    const data = await this.call("GET", PAYMENTS_PATH, `cart_mandate_id=${encodeURIComponent(cartMandateId)}`, undefined);
    if (!Array.isArray(data)) throw new RailUnavailableError("query payments: expected an array");
    return data.map(parsePaymentRecord);
  }

  private async call(method: "GET" | "POST", path: string, query: string, payload: unknown): Promise<unknown> {
    const body = payload === undefined ? undefined : canonicalJson(payload as CanonicalValue);
    const headers = signMerchantRequest(
      { method, path, query, body, timestampSeconds: Math.floor(this.clock.now().getTime() / 1000), nonce: randomBytes(16).toString("hex") },
      this.credentials.appKey,
      this.credentials.appSecret,
    );
    const response = await this.transport({
      method,
      path,
      query,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body,
    });
    let envelope: unknown;
    try {
      envelope = JSON.parse(response.body);
    } catch {
      throw new RailUnavailableError(`${method} ${path}: response is not JSON (HTTP ${response.status})`);
    }
    const parsed = object(envelope, "envelope");
    if (typeof parsed.code !== "number") throw new RailUnavailableError(`${method} ${path}: response has no code`);
    if (parsed.code !== 0) throw new GatewayError(String(parsed.code), response.status, typeof parsed.msg === "string" ? parsed.msg : "gateway error");
    return parsed.data;
  }
}

/**
 * Maps a documented payment record to the fields reconciliation uses. The query names the cart
 * mandate ID `content_id`; webhooks name it `cart_mandate_id`. Anything malformed is refused.
 */
export function parsePaymentRecord(raw: unknown): GatewayPaymentRecord {
  const value = object(raw, "payment record");
  const text = (key: string): string => {
    const entry = value[key];
    if (typeof entry !== "string" || entry === "") throw new RailUnavailableError(`payment record field ${key} is missing`);
    return entry;
  };
  const optional = (key: string): string | null => {
    const entry = value[key];
    if (entry === undefined || entry === null || entry === "") return null;
    if (typeof entry !== "string") throw new RailUnavailableError(`payment record field ${key} is not a string`);
    return entry;
  };
  const status = text("status");
  if (!(GATEWAY_STATUSES as readonly string[]).includes(status)) throw new RailUnavailableError(`unknown gateway status ${status}`);
  const cartMandateId = optional("content_id") ?? optional("cart_mandate_id");
  if (cartMandateId === null) throw new RailUnavailableError("payment record has no cart mandate ID");
  return {
    payment_request_id: text("payment_request_id"),
    cart_mandate_id: cartMandateId,
    flow_id: text("flow_id"),
    request_id: optional("request_id"),
    status: status as GatewayStatus,
    status_reason: optional("status_reason"),
    tx_signature: optional("tx_signature"),
    payer_address: optional("payer_address"),
    to_pay_address: text("to_pay_address"),
    token: text("token"),
    token_address: text("token_address"),
    chain: text("chain"),
    network: text("network"),
    product_amount: text("product_amount"),
    order_amount: text("order_amount"),
    pay_amount: text("pay_amount"),
    usd_amount_rate: optional("usd_amount_rate"),
    created_at: text("created_at"),
    included_at: optional("included_at"),
    completed_at: optional("completed_at"),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RailUnavailableError(`${label} is not an object`);
  return value as Record<string, unknown>;
}

/**
 * A transport for the live gateway over fetch. A failed POST may still have reached the gateway, so
 * it is reported as an unknown outcome; a failed GET changed nothing and is reported as unavailable.
 */
export function fetchTransport(baseUrl: string, timeoutMs: number): MerchantTransport {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:") throw new Error("the gateway base URL must use HTTPS");
  return async (request) => {
    const url = new URL(request.path, origin);
    url.search = request.query;
    let response: Response;
    try {
      response = await fetch(url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch {
      if (request.method === "POST") throw new RailTimeoutError(`${request.method} ${request.path}`);
      throw new RailUnavailableError(`${request.method} ${request.path}`);
    }
    return { status: response.status, body: await response.text() };
  };
}

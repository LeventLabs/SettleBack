import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hashTypedData, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "@settleback/domain";
import {
  HspAgenticClient,
  HspAgenticRail,
  HspSchemaError,
  HspToolError,
  ManualClock,
  McpHttpClient,
  McpOutcomeUnknownError,
  McpUnavailableError,
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  TOKEN_EVENTS_ABI,
  checkPreparedPayment,
  isQuoteExpired,
  paymentStatusFromQuery,
  payloadOf,
  selectPaymentToken,
  shapeArguments,
  transferFromReceipt,
  verifyEip3009Signature,
  verifySettlement,
  type ChainTransfer,
  type HspPaymentToken,
  type OfferCheckId,
  type OfferExpectations,
  type PrepareInput,
} from "../src/index.ts";

const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const DOMAIN = { name: "USD Coin", version: "2", chainId: 133, verifyingContract: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6" };
const payer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const PAYER = payer.address.toLowerCase() as Address;
const SELLER = "0x00000000000000000000000000000000000000a1" as Address;
const NONCE = `0x${"5e".repeat(32)}`;
const TX = `0x${"7a".repeat(32)}`;
const TEAM = "SettleBack";
const USDC: HspPaymentToken = { network: "hashkey-testnet", chainId: 133, address: TOKEN, decimals: 6, symbol: "USDC", protocol: "eip3009" };

const nowSeconds = () => Math.floor(Date.now() / 1000);

function eip712(overrides: { message?: Record<string, unknown>; domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: unknown } = {}) {
  return {
    domain: { ...DOMAIN, ...overrides.domain },
    types: overrides.types ?? {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: overrides.primaryType ?? "TransferWithAuthorization",
    message: { from: payer.address, to: SELLER, value: "1000000", validAfter: "0", validBefore: String(nowSeconds() + 300), nonce: NONCE, ...overrides.message },
  };
}

function prepared(overrides: Record<string, unknown> = {}, typed = eip712()) {
  return {
    eip712: typed,
    cart_hash: "c".repeat(64),
    token_total_raw: (typed.message as { value: unknown }).value,
    quote_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    pay_to: SELLER,
    payer: payer.address,
    payment_request_id: "pr-1",
    payment_payload: { x402Version: 2, payload: { signature: "" } },
    payment_mandate_contents: { payment_mandate_id: "pr-1" },
    ...overrides,
  };
}

const expectations = (overrides: Partial<OfferExpectations> = {}): OfferExpectations => ({
  paymentRequestId: "pr-1",
  payer: PAYER,
  payee: SELLER,
  chainId: 133,
  token: TOKEN,
  principalBaseUnits: "1000000",
  maxFeeBaseUnits: "100000",
  notAfter: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0" },
  ...overrides,
});

function blocked(raw: unknown, expected = expectations()): OfferCheckId[] {
  const result = checkPreparedPayment(raw, expected, new Date());
  expect(result.ok).toBe(false);
  return result.checks.filter((check) => check.status === "blocked").map((check) => check.id);
}

describe("checkPreparedPayment", () => {
  it("passes HSP's prepared payment and rebuilds typed data that hashes exactly like HSP's", async () => {
    const raw = prepared();
    const result = checkPreparedPayment(raw, expectations(), new Date());
    if (!result.ok) throw new Error(result.reasons.join("; "));
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    const ours = result.offer.walletTypedData;
    const theirs = raw.eip712;
    const digest = (typed: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: unknown; message: Record<string, unknown> }) =>
      hashTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message } as Parameters<typeof hashTypedData>[0]);
    expect(digest(ours as never)).toBe(digest(theirs as never));
    const signature = await payer.signTypedData(ours as never);
    expect(await verifyTypedData({ address: payer.address, signature, ...(theirs as object) } as never)).toBe(true);
    expect(await verifyEip3009Signature(result.offer, signature)).toBe(true);
  });

  it("accepts a fee carried inside the authorization up to the maximum fee", () => {
    const typed = eip712({ message: { value: "1100000" } });
    expect(checkPreparedPayment(prepared({}, typed), expectations(), new Date()).ok).toBe(true);
    expect(blocked(prepared({}, eip712({ message: { value: "1100001" } })))).toEqual(["amount"]);
    expect(blocked(prepared({}, eip712({ message: { value: "999999" } })))).toEqual(["amount"]);
  });

  it("blocks each term that differs from the order, naming the check", () => {
    expect(blocked(prepared({ payment_request_id: "pr-2" }))).toEqual(["order-binding"]);
    expect(blocked(prepared({}, eip712({ message: { from: SELLER } })))).toEqual(["payer"]);
    expect(blocked(prepared({ payer: SELLER }))).toEqual(["payer"]);
    expect(blocked(prepared({}, eip712({ message: { to: PAYER } })))).toEqual(["recipient", "payee-allowlist"]);
    expect(blocked(prepared({ pay_to: PAYER }))).toEqual(["recipient"]);
    expect(blocked(prepared({ token_total_raw: "1000001" }))).toEqual(["amount"]);
    expect(blocked(prepared(), expectations({ policy: { payeeAllowlist: [PAYER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0" } }))).toEqual(["payee-allowlist"]);
    expect(blocked(prepared(), expectations({ policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "999999", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0" } }))).toEqual(["per-payment-cap"]);
    expect(blocked(prepared(), expectations({ policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "19000001" } }))).toEqual(["daily-cap"]);
  });

  it("refuses typed data that is not exactly EIP-3009 under the pinned token domain", () => {
    expect(blocked(prepared({}, eip712({ primaryType: "Permit" })))).toEqual(["typed-data"]);
    const types = eip712().types as { TransferWithAuthorization: { name: string; type: string }[] };
    const swapped = [...types.TransferWithAuthorization];
    [swapped[0], swapped[1]] = [swapped[1] as { name: string; type: string }, swapped[0] as { name: string; type: string }];
    expect(blocked(prepared({}, eip712({ types: { ...types, TransferWithAuthorization: swapped } })))).toEqual(["typed-data"]);
    expect(blocked(prepared({}, eip712({ types: { ...types, Extra: [] } })))).toEqual(["typed-data"]);
    expect(blocked(prepared({}, eip712({ message: { nonce: "0x1234" } })))).toEqual(["typed-data"]);
    expect(blocked(prepared({ token_total_raw: "1000000" }, eip712({ message: { value: "1.5" } })))).toEqual(["typed-data"]);
    expect(blocked(prepared({}, eip712({ domain: { name: "USD Coin Fake" } })))).toEqual(["token-domain"]);
    expect(blocked(prepared({}, eip712({ domain: { version: "1" } })))).toEqual(["token-domain"]);
    expect(blocked(prepared({}, eip712({ domain: { chainId: 177 } })))).toEqual(["token-domain"]);
    expect(blocked(prepared({}, eip712({ domain: { verifyingContract: SELLER } })))).toEqual(["token-domain"]);
    expect(blocked(prepared({}, eip712({ domain: { salt: `0x${"00".repeat(32)}` } })))).toEqual(["token-domain"]);
    expect(blocked(prepared(), expectations({ token: SELLER }))).toEqual(["token-domain"]);
  });

  it("refuses a quote or authorization outside its validity windows", () => {
    expect(blocked(prepared({ quote_expires_at: new Date(Date.now() + 10_000).toISOString() }))).toEqual(["validity"]);
    expect(blocked(prepared({ quote_expires_at: "soon" }))).toEqual(["validity"]);
    expect(blocked(prepared({}, eip712({ message: { validAfter: String(nowSeconds() + 60) } })))).toEqual(["validity"]);
    expect(blocked(prepared({}, eip712({ message: { validBefore: String(nowSeconds() + 30) } })))).toEqual(["validity"]);
    expect(blocked(prepared(), expectations({ notAfter: new Date(Date.now() + 120_000).toISOString() }))).toEqual(["validity"]);
  });

  it("reports a malformed answer as a format failure and checks nothing else", () => {
    const result = checkPreparedPayment(prepared({ payment_payload: undefined }), expectations(), new Date());
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ id: "offer-format", status: "blocked" });
    expect(result.checks.slice(1).every((check) => check.status === "not-checked")).toBe(true);
    expect(checkPreparedPayment({ data: prepared() }, expectations(), new Date()).ok).toBe(true);
  });
});

describe("HSP responses", () => {
  it("selects the payment token from the chain configuration, wherever it is nested", () => {
    const config = { data: { chains: [{ network: "hashkey-testnet", chain_id: 133, tokens: [{ symbol: "USDC", address: DOMAIN.verifyingContract, decimals: 6, payment_protocol: "eip3009" }] }, { network: "hashkey", chain_id: "177", tokens: [] }] } };
    expect(selectPaymentToken(config, { chainId: 133, symbol: "USDC" })).toEqual(USDC);
    expect(() => selectPaymentToken(config, { chainId: 177, symbol: "USDC" })).toThrow(/0 USDC tokens/);
    expect(() => selectPaymentToken({ a: config, b: config }, { chainId: 133, symbol: "USDC" })).toThrow(/2 networks/);
  });

  it("reads query_payment as a gateway record for the payment request asked about", () => {
    const payment = { payment_request_id: "pr-1", cart_mandate_id: "cart-1", flow_id: "flow-1", tx_signature: TX, payer_address: PAYER, to_pay_address: SELLER, token: "USDC", token_address: TOKEN, chain: "eip155:133", network: "hashkey-testnet", product_amount: "1.00", order_amount: "1.00", pay_amount: "1.00", created_at: "2026-10-30T10:00:00Z" };
    const status = paymentStatusFromQuery({ status: "payment-safe", attribution_verified: true, payment }, "pr-1");
    expect(status.record).toMatchObject({ status: "payment-safe", tx_signature: TX, flow_id: "flow-1" });
    expect(status.attributionVerified).toBe(true);
    expect(paymentStatusFromQuery({ status: "payment-timeout", payment: { ...payment, tx_signature: "" } }, "pr-1").record.tx_signature).toBeNull();
    expect(() => paymentStatusFromQuery({ status: "payment-safe", payment }, "pr-2")).toThrow(/different payment request/);
    expect(() => paymentStatusFromQuery({ status: "payment-safe", payment: { ...payment, tx_signature: "0x12" } }, "pr-1")).toThrow(/not 32 bytes/);
    expect(() => paymentStatusFromQuery({ status: "payment-lost", payment }, "pr-1")).toThrow(/unknown gateway status/);
  });

  it("names arguments as the live schema does and refuses inputs it would have to guess", () => {
    const schema = { properties: { flow_id: { type: "string" }, payer_address: { type: "string" }, protocol: { type: "string" }, payload: { type: "string" } }, required: ["flow_id"] };
    expect(shapeArguments("prepare_payment", schema, [{ names: ["payer", "payer_address"], value: PAYER }, { names: ["flow_id"], value: "f" }, { names: ["payload"], value: { a: 1 } }])).toEqual({ payer_address: PAYER, flow_id: "f", payload: '{"a":1}' });
    expect(() => shapeArguments("prepare_payment", schema, [{ names: ["payer"], value: PAYER }])).toThrow(HspSchemaError);
    expect(() => shapeArguments("prepare_payment", { properties: { payer: {}, payer_address: {} } }, [{ names: ["payer", "payer_address"], value: PAYER }])).toThrow(/several parameters/);
    expect(() => shapeArguments("prepare_payment", { properties: { flow_id: {}, wallet: {} }, required: ["wallet"] }, [{ names: ["flow_id"], value: "f" }])).toThrow(/requires wallet/);
  });

  it("reads tool results and recognizes an expired quote", () => {
    expect(payloadOf("get_order", { content: [{ type: "text", text: '{"a":1}' }], structuredContent: undefined, isError: false })).toEqual({ a: 1 });
    expect(payloadOf("get_order", { content: [], structuredContent: { b: 2 }, isError: false })).toEqual({ b: 2 });
    expect(() => payloadOf("get_order", { content: [{ type: "text", text: "nope" }], structuredContent: undefined, isError: false })).toThrow(McpOutcomeUnknownError);
    const expired = (() => {
      try {
        payloadOf("submit_payment", { content: [{ type: "text", text: '{"code":30043,"msg":"quote expired"}' }], structuredContent: undefined, isError: true });
      } catch (error) {
        return error;
      }
    })();
    expect(expired).toBeInstanceOf(HspToolError);
    expect((expired as HspToolError).code).toBe("30043");
    expect(isQuoteExpired(expired)).toBe(true);
    expect(isQuoteExpired(new HspToolError("submit_payment", "HSP_TOOL_ERROR", "Gateway error 30043: quote expired"))).toBe(true);
    expect(isQuoteExpired(new HspToolError("submit_payment", "30042", "other"))).toBe(false);
  });
});

describe("transferFromReceipt", () => {
  const log = (eventName: "Transfer" | "AuthorizationUsed", args: Record<string, unknown>, address: string = TOKEN) => {
    const topics = encodeEventTopics({ abi: TOKEN_EVENTS_ABI, eventName, args } as never) as Hex[];
    const data = eventName === "Transfer" ? encodeAbiParameters([{ type: "uint256" }], [args.value as bigint]) : "0x";
    return { address, topics, data: data as Hex };
  };
  const receipt = (logs: ReturnType<typeof log>[], status: "success" | "reverted" = "success") => ({ transactionHash: TX, status, from: "0x00000000000000000000000000000000000000ee", to: TOKEN, blockNumber: 100n, logs });
  const at = { head: 102n, chainId: 133, token: TOKEN, from: PAYER, to: SELLER };

  it("reads the payer's transfer and the authorization nonce it executed", () => {
    const transfer = transferFromReceipt(receipt([log("AuthorizationUsed", { authorizer: PAYER, nonce: NONCE }), log("Transfer", { from: PAYER, to: SELLER, value: 1000000n })]), at);
    expect(transfer).toMatchObject({ from: PAYER, to: SELLER, amountBaseUnits: "1000000", status: "success", confirmations: 3, authorizationNonce: NONCE });
  });

  it("never reports a matching transfer from another token, another pair, or a reverted transaction", () => {
    expect(transferFromReceipt(receipt([log("Transfer", { from: PAYER, to: SELLER, value: 1n }, SELLER)]), at).amountBaseUnits).toBe("0");
    expect(transferFromReceipt(receipt([log("Transfer", { from: PAYER, to: PAYER, value: 1n })]), at)).toMatchObject({ amountBaseUnits: "0", from: "0x00000000000000000000000000000000000000ee" });
    expect(transferFromReceipt(receipt([log("Transfer", { from: PAYER, to: SELLER, value: 1n }), log("Transfer", { from: PAYER, to: SELLER, value: 2n })]), at).amountBaseUnits).toBe("0");
    expect(transferFromReceipt(receipt([], "reverted"), at).status).toBe("reverted");
    expect(transferFromReceipt(receipt([]), { ...at, head: 90n }).confirmations).toBe(1);
  });
});

describe("verifySettlement with an authorized amount and nonce", () => {
  const record = { payment_request_id: "pr-1", cart_mandate_id: "cart-1", flow_id: "flow-1", request_id: null, status: "payment-finalized" as const, status_reason: null, tx_signature: TX, payer_address: PAYER, to_pay_address: SELLER, token: "USDC", token_address: TOKEN, chain: "eip155:133", network: "hashkey-testnet", product_amount: "1.00", order_amount: "1.00", pay_amount: "1.10", usd_amount_rate: null, created_at: "2026-10-30T10:00:00Z", included_at: null, completed_at: null };
  const transfer: ChainTransfer = { txHash: TX, chainId: 133, token: TOKEN, from: PAYER, to: SELLER, amountBaseUnits: "1100000", blockNumber: 1, confirmations: 10, status: "success", authorizationNonce: NONCE };
  const expected = { payer: PAYER, payee: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" };
  const verify = (overrides: Record<string, unknown>) => verifySettlement({ expected, tokenDecimals: 6, record, transfer, requiredLevel: "FINAL", authorizedBaseUnits: "1100000", authorizationNonce: NONCE, ...overrides });

  it("verifies the transfer of exactly the authorized amount under the signed nonce", () => {
    expect(verify({}).status).toBe("VERIFIED");
    expect(verify({ authorizedBaseUnits: "1000000" }).reasons).toContain("transfer amount differs from the authorized amount");
    expect(verify({ authorizationNonce: `0x${"00".repeat(32)}` }).reasons).toContain("the transaction did not execute the payer's signed authorization");
    expect(verify({ transfer: { ...transfer, authorizationNonce: null } }).status).toBe("MISMATCH");
    expect(verify({ authorizedBaseUnits: "999999" }).reasons).toContain("the authorized amount is below the principal");
  });
});

// A stand-in for HSP's QA MCP server, speaking Streamable HTTP. Its tools follow the setup guide:
// HSP prepares the EIP-712 authorization, verifies the payer's signature at finalize, and
// broadcasts on submit.
interface FakeHsp {
  url: string;
  sse: boolean;
  expireSessionOnce: boolean;
  forbidden: boolean;
  serverError: boolean;
  dropResponseOnce: string | undefined;
  pingBeforeResponse: boolean;
  initializations: number;
  calls: { name: string; arguments: Record<string, unknown> }[];
  headers: Record<string, string | undefined>[];
  pings: number;
  orders: Map<string, { flowId: string; payTo: string; status: string; tx: string | null; prepared?: ReturnType<typeof prepared> }>;
  tools: { name: string; inputSchema: Record<string, unknown> }[];
}

const STRING = { type: "string" };
const HSP_TOOLS = [
  { name: "get_chain_config", inputSchema: { type: "object", properties: {} } },
  { name: "create_order", inputSchema: { type: "object", properties: { merchant_name: STRING, pay_to: STRING, cart_mandate: { type: "object" } }, required: ["merchant_name", "pay_to", "cart_mandate"] } },
  { name: "get_order", inputSchema: { type: "object", properties: { flow_id: STRING }, required: ["flow_id"] } },
  { name: "prepare_payment", inputSchema: { type: "object", properties: { flow_id: STRING, payer: STRING, protocol: STRING }, required: ["flow_id", "payer", "protocol"] } },
  {
    name: "finalize_payment",
    inputSchema: { type: "object", properties: { signature: STRING, payment_payload: STRING, payment_mandate_contents: { type: "object" }, cart_hash: STRING }, required: ["signature", "payment_payload", "payment_mandate_contents", "cart_hash"] },
  },
  { name: "estimate_fee", inputSchema: { type: "object", properties: { flow_id: STRING } } },
  { name: "submit_payment", inputSchema: { type: "object", properties: { payment_mandate_json: STRING }, required: ["payment_mandate_json"] } },
  { name: "query_payment", inputSchema: { type: "object", properties: { flow_id: STRING, payment_request_id: STRING, expected_merchant_name: STRING }, required: ["expected_merchant_name"] } },
];

let server: Server;
let hsp: FakeHsp;

function paymentRecord(paymentRequestId: string) {
  const order = hsp.orders.get(paymentRequestId);
  if (order === undefined) return undefined;
  return {
    payment_request_id: paymentRequestId,
    cart_mandate_id: `cart-${paymentRequestId.slice(3)}`,
    flow_id: order.flowId,
    tx_signature: order.tx ?? "",
    payer_address: order.tx === null ? "" : PAYER,
    to_pay_address: order.payTo,
    token: "USDC",
    token_address: TOKEN,
    chain: "eip155:133",
    network: "hashkey-testnet",
    product_amount: "1.00",
    order_amount: "1.00",
    pay_amount: "1.00",
    created_at: "2026-10-30T10:00:00Z",
  };
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ payload?: unknown; error?: string }> {
  switch (name) {
    case "get_chain_config":
      return { payload: { chains: [{ network: "hashkey-testnet", chain_id: 133, tokens: [{ symbol: "USDC", address: TOKEN, decimals: 6, payment_protocol: "eip3009" }] }] } };
    case "create_order": {
      const cart = args.cart_mandate as { contents: { payment_request: { details: { id: string } } }; merchant_authorization?: unknown };
      if (cart.merchant_authorization !== undefined) return { error: '{"code":10001,"msg":"do not provide merchant_authorization"}' };
      const id = cart.contents.payment_request.details.id;
      if (hsp.orders.has(id)) return { error: '{"code":40001,"msg":"duplicate order"}' };
      hsp.orders.set(id, { flowId: `flow-${id}`, payTo: String(args.pay_to), status: "payment-required", tx: null });
      return { payload: { flow_id: `flow-${id}`, payment_request_id: id, payment_url: `https://pay.example/${id}` } };
    }
    case "prepare_payment": {
      const order = [...hsp.orders.entries()].find(([, entry]) => entry.flowId === args.flow_id);
      if (order === undefined) return { error: "unknown flow" };
      const offer = prepared({ payment_request_id: order[0], payer: args.payer, pay_to: order[1].payTo }, eip712({ message: { from: args.payer, to: order[1].payTo } }));
      order[1].prepared = offer;
      return { payload: offer };
    }
    case "finalize_payment": {
      const order = [...hsp.orders.values()].find((entry) => entry.prepared?.cart_hash === args.cart_hash);
      if (order?.prepared === undefined) return { error: "unknown cart" };
      if (typeof args.payment_payload !== "string" || JSON.parse(args.payment_payload).x402Version !== 2) return { error: "payment_payload must be the prepared payload as JSON text" };
      const typed = order.prepared.eip712;
      const valid = await verifyTypedData({ address: typed.message.from as Hex, signature: args.signature as Hex, ...(typed as object) } as never);
      if (!valid) return { error: '{"code":30010,"msg":"signature does not match"}' };
      return { payload: { payment_mandate_json: JSON.stringify({ jwt: "header.payload.sig", flow: order.flowId }) } };
    }
    case "submit_payment": {
      const { flow } = JSON.parse(String(args.payment_mandate_json)) as { flow: string };
      const order = [...hsp.orders.values()].find((entry) => entry.flowId === flow);
      if (order === undefined) return { error: "unknown mandate" };
      order.status = "payment-submitted";
      order.tx = TX;
      return { payload: { status: "payment-submitted", flow_id: flow } };
    }
    case "query_payment": {
      if (args.expected_merchant_name !== TEAM) return { payload: { status: "payment-required", attribution_verified: false } };
      const record = paymentRecord(String(args.payment_request_id));
      if (record === undefined) return { error: '{"code":40404,"msg":"no such payment"}' };
      return { payload: { status: hsp.orders.get(String(args.payment_request_id))?.status, attribution_verified: true, payment: record } };
    }
    default:
      return { payload: {} };
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  hsp.headers.push({ session: request.headers["mcp-session-id"] as string | undefined, version: request.headers["mcp-protocol-version"] as string | undefined, accept: request.headers.accept });
  if (hsp.forbidden) return void response.writeHead(403).end("forbidden");
  if (hsp.serverError) return void response.writeHead(502).end("bad gateway");
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };
  if (message.method === undefined) {
    hsp.pings++;
    return void response.writeHead(202).end();
  }
  if (message.method === "initialize") {
    hsp.initializations++;
    response.setHeader("mcp-session-id", `session-${hsp.initializations}`);
    return reply(response, message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-hsp", version: "1" } });
  }
  if (request.headers["mcp-session-id"] !== `session-${hsp.initializations}`) return void response.writeHead(400).end();
  if (message.method === "notifications/initialized") return void response.writeHead(202).end();
  if (hsp.expireSessionOnce) {
    hsp.expireSessionOnce = false;
    return void response.writeHead(404).end();
  }
  if (message.method === "tools/list") {
    const page = message.params?.cursor === "2" ? hsp.tools.slice(4) : hsp.tools.slice(0, 4);
    return reply(response, message.id, { tools: page, ...(message.params?.cursor === "2" ? {} : { nextCursor: "2" }) });
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name);
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    hsp.calls.push({ name, arguments: args });
    const outcome = await tool(name, args);
    if (hsp.dropResponseOnce === name) {
      hsp.dropResponseOnce = undefined;
      return void response.destroy();
    }
    const result = outcome.error === undefined ? { content: [{ type: "text", text: JSON.stringify(outcome.payload) }] } : { content: [{ type: "text", text: outcome.error }], isError: true };
    return reply(response, message.id, result);
  }
  return reply(response, message.id, undefined, { code: -32601, message: "method not found" });
}

function reply(response: ServerResponse, id: number | string | undefined, result: unknown, error?: { code: number; message: string }): void {
  const body = JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) });
  if (!hsp.sse) {
    response.writeHead(200, { "content-type": "application/json" }).end(body);
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write("id: prime\ndata:\n\n");
  if (hsp.pingBeforeResponse) response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-1", method: "ping" })}\n\n`);
  response.write(`: keep-alive\r\nevent: message\r\ndata: ${body}\r\n\r\n`);
  response.end();
}

beforeAll(async () => {
  server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  hsp = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    sse: false,
    expireSessionOnce: false,
    forbidden: false,
    serverError: false,
    dropResponseOnce: undefined,
    pingBeforeResponse: false,
    initializations: 0,
    calls: [],
    headers: [],
    pings: 0,
    orders: new Map(),
    tools: HSP_TOOLS,
  };
});

const mcp = (headers?: Record<string, string>) => new McpHttpClient({ url: hsp.url, clientInfo: { name: "settleback-test", version: "0" }, timeoutMs: 5_000, ...(headers === undefined ? {} : { headers }) });

describe("McpHttpClient", () => {
  it("initializes a session and sends its ID, the negotiated version, and both accepted types on every request", async () => {
    const client = mcp({ "x-settleback-relay": "token" });
    expect(await client.listTools()).toHaveLength(8);
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(hsp.headers[0]).toMatchObject({ session: undefined, version: undefined, accept: "application/json, text/event-stream" });
    expect(hsp.headers.slice(1).every((seen) => seen.session === "session-1" && seen.version === "2025-06-18")).toBe(true);
  });

  it("reads a response from an event stream and answers the server's ping on the way", async () => {
    hsp.sse = true;
    hsp.pingBeforeResponse = true;
    const result = await mcp().callTool("get_chain_config", {});
    expect(result.isError).toBe(false);
    // One ping in the initialize stream and one in the tool call's.
    expect(hsp.pings).toBe(2);
  });

  it("starts a new session once when the server has ended the old one", async () => {
    const client = mcp();
    await client.listTools();
    hsp.expireSessionOnce = true;
    await client.callTool("get_chain_config", {});
    expect(hsp.initializations).toBe(2);
  });

  it("reports a refused address as unavailable, a server error or a cut connection as an unknown outcome", async () => {
    hsp.forbidden = true;
    await expect(mcp().listTools()).rejects.toMatchObject({ name: "McpUnavailableError", httpStatus: 403 });
    hsp.forbidden = false;
    const client = mcp();
    await client.listTools();
    hsp.serverError = true;
    await expect(client.callTool("get_chain_config", {})).rejects.toBeInstanceOf(McpOutcomeUnknownError);
    hsp.serverError = false;
    hsp.dropResponseOnce = "get_chain_config";
    await expect(client.callTool("get_chain_config", {})).rejects.toBeInstanceOf(McpOutcomeUnknownError);
  });

  it("reports an endpoint that refuses connections as unavailable and refuses plain HTTP off loopback", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const closed = new McpHttpClient({ url: `http://127.0.0.1:${port}/`, clientInfo: { name: "t", version: "0" }, timeoutMs: 2_000 });
    await expect(closed.listTools()).rejects.toBeInstanceOf(McpUnavailableError);
    expect(() => new McpHttpClient({ url: "http://example.com/", clientInfo: { name: "t", version: "0" }, timeoutMs: 1 })).toThrow(/HTTPS/);
  });
});

describe("HspAgenticRail against a stand-in HSP server", () => {
  const order: PrepareInput = { cartMandateId: "cart-1", paymentRequestId: "pr-1", payee: SELLER, chainId: 133, token: TOKEN, coin: "USDC", tokenDecimals: 6, priceUsd: "1.00", label: "job", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const transfers = { transfer: async (txHash: string): Promise<ChainTransfer> => ({ txHash, chainId: 133, token: TOKEN, from: PAYER, to: SELLER, amountBaseUnits: "1000000", blockNumber: 1, confirmations: 5, status: "success", authorizationNonce: NONCE }) };
  const rail = (client = new HspAgenticClient(mcp())) => new HspAgenticRail({ client, transfers, merchantName: TEAM, token: USDC, clock: new ManualClock("2026-10-30T10:00:00.000Z") });

  it("refuses a server missing a documented tool", async () => {
    hsp.tools = HSP_TOOLS.filter((entry) => entry.name !== "finalize_payment");
    await expect(new HspAgenticClient(mcp()).verifyTools()).rejects.toThrow(/missing tools: finalize_payment/);
  });

  it("orders, checks, signs, finalizes, submits once, and observes the transfer on chain", async () => {
    hsp.sse = true;
    const hspRail = rail();
    const created = await hspRail.createOrder(order);
    expect(created).toMatchObject({ flowId: "flow-pr-1", paymentRequestId: "pr-1", recovered: false });
    expect(hsp.calls[0]?.arguments).toMatchObject({ merchant_name: TEAM, pay_to: SELLER });
    expect(hsp.calls[0]?.arguments.cart_mandate).not.toHaveProperty("merchant_authorization");
    const method = (hsp.calls[0]?.arguments.cart_mandate as { contents: { payment_request: { method_data: { data: Record<string, unknown> }[] } } }).contents.payment_request.method_data[0];
    expect(method?.data).toMatchObject({ x402Version: 2, network: USDC.network, chain_id: 133, contract_address: TOKEN, coin: "USDC", pay_to: SELLER });

    const check = checkPreparedPayment(await hspRail.prepare(created.flowId, PAYER), expectations(), new Date());
    if (!check.ok) throw new Error(check.reasons.join("; "));
    const signature = await payer.signTypedData(check.offer.walletTypedData as never);
    expect(await hspRail.submit(check.offer, signature)).toEqual({ status: "payment-submitted" });
    expect(hsp.calls.filter((call) => call.name === "submit_payment")).toHaveLength(1);

    const observed = await hspRail.observe("pr-1");
    expect(observed).toMatchObject({ provenance: "LIVE", kind: "SUBMITTED", attributionVerified: true, transfer: { txHash: TX, authorizationNonce: NONCE } });
  });

  it("finds the order by its payment request ID after a lost create, without creating a second one", async () => {
    hsp.dropResponseOnce = "create_order";
    const created = await rail().createOrder(order);
    expect(created).toMatchObject({ flowId: "flow-pr-1", recovered: true, paymentUrl: null });
    expect(hsp.calls.filter((call) => call.name === "create_order")).toHaveLength(1);
  });

  it("reports a lost submit as an unknown outcome and HSP's refusal of a wrong signature as a rejection", async () => {
    const hspRail = rail();
    const created = await hspRail.createOrder(order);
    const check = checkPreparedPayment(await hspRail.prepare(created.flowId, PAYER), expectations(), new Date());
    if (!check.ok) throw new Error(check.reasons.join("; "));
    const wrong = await privateKeyToAccount(`0x${"c3".repeat(32)}`).signTypedData(check.offer.walletTypedData as never);
    await expect(hspRail.submit(check.offer, wrong)).rejects.toBeInstanceOf(RailRejectedError);
    hsp.dropResponseOnce = "submit_payment";
    await expect(hspRail.submit(check.offer, await payer.signTypedData(check.offer.walletTypedData as never))).rejects.toBeInstanceOf(RailTimeoutError);
  });

  it("treats a lost or unreadable query as unavailability, never as a decision", async () => {
    const hspRail = rail();
    await hspRail.createOrder(order);
    hsp.dropResponseOnce = "query_payment";
    await expect(hspRail.observe("pr-1")).rejects.toBeInstanceOf(RailUnavailableError);
    await expect(hspRail.observe("pr-9")).rejects.toBeInstanceOf(HspToolError);
  });
});

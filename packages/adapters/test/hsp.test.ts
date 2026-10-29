import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@settleback/domain";
import {
  ManualClock,
  MerchantClient,
  RailTimeoutError,
  RailUnavailableError,
  SimChain,
  SimGateway,
  buildSimulatedPaymentMandate,
  cartAmountProblems,
  cartHash,
  createSimulatedAdapters,
  effectiveTotal,
  fetchTransport,
  parseCartMandate,
  parsePaymentRecord,
  quoteContents,
  secp256k1Key,
  signMerchantJwt,
  signMerchantRequest,
  signingMessage,
  submitPaymentMandate,
  validateCartMandate,
  verifyMerchantJwt,
  verifyMerchantRequest,
  verifySettlement,
  type CartContents,
  type CartMandate,
  type MerchantClaims,
  type PaymentRail,
  type PrepareInput,
  type SignedPayload,
  type SimulatedAdapters,
  type ValidateCartInput,
} from "../src/index.ts";

const BUYER = "0x00000000000000000000000000000000000000b1" as Address;
const SELLER = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER = "0x00000000000000000000000000000000000000c1" as Address;
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const MERCHANT = "SettleBack Demo Seller";
const NOW = new Date("2026-10-30T10:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;

const ORDER: PrepareInput = {
  cartMandateId: "cart-0001",
  paymentRequestId: "pr-0001",
  payee: SELLER,
  chainId: 133,
  token: TOKEN,
  coin: "USDC",
  tokenDecimals: 6,
  priceUsd: "1.00",
  label: "Structured extraction job",
  expiresAt: "2026-10-30T12:00:00.000Z",
};

function keyPair(curve = "secp256k1"): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: curve });
}

function claims(hash: string, overrides: Partial<MerchantClaims> = {}): MerchantClaims {
  return { iss: MERCHANT, sub: MERCHANT, aud: "HashkeyMerchant", iat: NOW_SECONDS, exp: NOW_SECONDS + 3600, jti: "JWT-1", cart_hash: hash, ...overrides };
}

const FULL_EXAMPLE: CartContents = {
  id: "ORDER-001",
  user_cart_confirmation_required: true,
  payment_request: {
    method_data: [
      { supported_methods: "https://www.x402.org/", data: { x402Version: 2, network: "sepolia", chain_id: 11155111, contract_address: "0x1c7D", pay_to: "0x99c1", coin: "USDC" } },
      { supported_methods: "https://www.x402.org/", data: { x402Version: 2, network: "sepolia", chain_id: 11155111, contract_address: "0x3f3F", pay_to: "0x99c1", coin: "USDT" } },
    ],
    details: {
      id: "PAY-REQ-001",
      display_items: [
        { label: "Item A", amount: { currency: "USD", value: "10.00" } },
        { label: "Item B", amount: { currency: "USD", value: "5.00" } },
      ],
      total: { label: "Total", amount: { currency: "USD", value: "15.00" } },
      modifiers: [
        {
          supported_methods: "https://www.x402.org/",
          data: { method_data_indexes: [0, 1] },
          additional_display_items: [{ label: "Service fee", amount: { currency: "USD", value: "1.00" } }],
          total: { label: "Amount due", amount: { currency: "USD", value: "16.00" } },
        },
      ],
    },
  },
  cart_expiry: "2024-03-01T12:00:00Z",
  merchant_name: "My Store",
};

describe("cart hash", () => {
  it("hashes the documented canonical form: sorted keys, no whitespace", () => {
    const canonical = '{"cart_expiry":"2024-03-01T12:00:00Z","id":"cart-123","merchant_name":"My Store"}';
    const expected = createHash("sha256").update(canonical).digest("hex");
    expect(cartHash({ merchant_name: "My Store", id: "cart-123", cart_expiry: "2024-03-01T12:00:00Z" })).toBe(expected);
  });

  it("changes with any field, including ones this code does not model, and refuses fractional numbers", () => {
    const base = cartHash(FULL_EXAMPLE);
    expect(cartHash({ ...FULL_EXAMPLE, extra: "x" })).not.toBe(base);
    expect(cartHash({ ...FULL_EXAMPLE, merchant_name: "My Store " })).not.toBe(base);
    expect(() => cartHash({ ...FULL_EXAMPLE, amount: 1.5 })).toThrow(/safe integer/);
  });
});

describe("documented amount rules", () => {
  it("accepts the documented examples and computes each option's amount due", () => {
    expect(cartAmountProblems(FULL_EXAMPLE)).toEqual([]);
    expect([effectiveTotal(FULL_EXAMPLE, 0), effectiveTotal(FULL_EXAMPLE, 1)]).toEqual(["16.00", "16.00"]);

    const perOption = structuredClone(FULL_EXAMPLE);
    perOption.payment_request.details = {
      id: "PAY-REQ-001",
      display_items: [{ label: "Item", amount: { currency: "USD", value: "10.00" } }],
      total: { label: "Merchandise total", amount: { currency: "USD", value: "10.0" } },
      modifiers: [
        {
          supported_methods: "https://www.x402.org",
          data: { method_data_indexes: [1] },
          additional_display_items: [{ label: "Base network fee", amount: { currency: "USD", value: "1.00" } }],
          total: { label: "Amount due", amount: { currency: "USD", value: "11.00" } },
        },
      ],
    };
    expect(cartAmountProblems(perOption)).toEqual([]);
    expect([effectiveTotal(perOption, 0), effectiveTotal(perOption, 1)]).toEqual(["10.0", "11.00"]);
  });

  it("finds each documented violation", () => {
    const broken = (edit: (contents: CartContents) => void): string[] => {
      const contents = structuredClone(FULL_EXAMPLE);
      edit(contents);
      return cartAmountProblems(contents);
    };
    const modifier = (contents: CartContents) => {
      const entry = contents.payment_request.details.modifiers?.[0];
      if (entry === undefined) throw new Error("no modifier");
      return entry;
    };
    expect(broken((c) => (c.payment_request.details.total.amount.value = "14.00")).join()).toMatch(/do not add up/);
    expect(broken((c) => (modifier(c).total = { label: "Amount due", amount: { currency: "USD", value: "17.00" } })).join()).toMatch(/plus its additional items/);
    expect(broken((c) => (modifier(c).additional_display_items = [])).join()).toMatch(/must not be empty/);
    expect(broken((c) => (modifier(c).data = { method_data_indexes: [2] })).join()).toMatch(/out-of-range/);
    expect(broken((c) => (modifier(c).data = { method_data_indexes: [0, 0] })).join()).toMatch(/repeats/);
    expect(broken((c) => c.payment_request.details.modifiers?.push(structuredClone(modifier(c)))).join()).toMatch(/more than one modifier/);
    expect(broken((c) => (c.payment_request.details.total.amount.value = "15.5x")).join()).toMatch(/plain decimal/);
  });
});

describe("merchant authorization JWT", () => {
  const { privateKey, publicKey } = keyPair();
  const hash = "ab".repeat(32);

  it("signs ES256K with the documented header and verifies against the public key", () => {
    const token = signMerchantJwt(claims(hash), privateKey);
    const [header, , signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "ES256K", typ: "JWT" });
    expect(Buffer.from(signature ?? "", "base64url")).toHaveLength(64);
    expect(verifyMerchantJwt(token, publicKey, hash, NOW_SECONDS)).toMatchObject({ ok: true, claims: { cart_hash: hash } });
  });

  it("names each reason a token fails", () => {
    const reason = (token: string, now = NOW_SECONDS, key = publicKey) => {
      const result = verifyMerchantJwt(token, key, hash, now);
      return result.ok ? "ok" : result.reason;
    };
    const token = signMerchantJwt(claims(hash), privateKey);
    const [header, body, signature] = token.split(".") as [string, string, string];
    const altered = Buffer.from(JSON.stringify({ ...claims(hash), cart_hash: "cd".repeat(32) })).toString("base64url");
    expect(reason(`${header}.${altered}.${signature}`)).toBe("BAD_SIGNATURE");
    expect(reason(token, NOW_SECONDS, keyPair().publicKey)).toBe("BAD_SIGNATURE");
    expect(reason(signMerchantJwt(claims("cd".repeat(32)), privateKey))).toBe("CART_HASH_MISMATCH");
    expect(reason(signMerchantJwt(claims(hash, { aud: "SomeoneElse" }), privateKey))).toBe("WRONG_AUDIENCE");
    expect(reason(token, NOW_SECONDS + 3600)).toBe("EXPIRED");
    expect(reason(signMerchantJwt(claims(hash, { iat: NOW_SECONDS + 600 }), privateKey))).toBe("NOT_YET_VALID");
    const hs256 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    expect(reason(`${hs256}.${body}.${signature}`)).toBe("WRONG_ALGORITHM");
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    expect(reason(`${none}.${body}.`)).toBe("MALFORMED_JWT");
    expect(reason("a.b")).toBe("MALFORMED_JWT");
  });

  it("loads secp256k1 keys from PKCS8, SEC1, and SPKI PEM and refuses other curves", () => {
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }).toString();
    const spki = publicKey.export({ type: "spki", format: "pem" }).toString();
    const token = signMerchantJwt(claims(hash), secp256k1Key(sec1, "private"));
    expect(verifyMerchantJwt(token, secp256k1Key(spki, "public"), hash, NOW_SECONDS).ok).toBe(true);
    expect(secp256k1Key(pkcs8, "private").asymmetricKeyDetails?.namedCurve).toBe("secp256k1");
    const p256 = keyPair("prime256v1").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => secp256k1Key(p256, "private")).toThrow(/secp256k1/);
  });

  it("rejects a signature in DER form, which JWS does not use", () => {
    const token = signMerchantJwt(claims(hash), privateKey);
    const [header, body] = token.split(".") as [string, string, string];
    const der = sign("sha256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
    expect(verifyMerchantJwt(`${header}.${body}.${der}`, publicKey, hash, NOW_SECONDS)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
});

describe("merchant request signing", () => {
  it("builds the documented message for a POST with a body and a GET without one", () => {
    const body = '{"cart_mandate":{}}';
    const bodyHash = createHash("sha256").update(body).digest("hex");
    expect(signingMessage({ method: "POST", path: "/api/v1/merchant/orders", query: "", body, timestampSeconds: 1709123456, nonce: "a3f1b2c4d5e6" })).toBe(
      `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n1709123456\na3f1b2c4d5e6`,
    );
    expect(
      signingMessage({ method: "GET", path: "/api/v1/merchant/payments", query: "cart_mandate_id=ORDER-123", body: undefined, timestampSeconds: 1709123456, nonce: "a3f1b2c4d5e6" }),
    ).toBe("GET\n/api/v1/merchant/payments\ncart_mandate_id=ORDER-123\n\n1709123456\na3f1b2c4d5e6");
  });

  it("verifies the signature, the time window, and nonce reuse", () => {
    const parts = { method: "POST" as const, path: "/api/v1/merchant/orders", query: "", body: "{}", timestampSeconds: NOW_SECONDS, nonce: "a3f1b2c4d5e6" };
    const headers = signMerchantRequest(parts, "ak_1", "secret");
    const seen = new Set<string>();
    const check = (overrides: Partial<typeof parts> = {}, header = headers, now = NOW_SECONDS) => {
      const result = verifyMerchantRequest({ ...parts, ...overrides }, header, "secret", now, (nonce) => seen.has(nonce) || (seen.add(nonce), false));
      return result.ok ? "ok" : result.reason;
    };
    expect(check({ body: '{"x":1}' })).toBe("BAD_SIGNATURE");
    expect(check({}, headers, NOW_SECONDS + 301)).toBe("STALE_TIMESTAMP");
    expect(check({}, { ...headers, "X-Nonce": "not hex!" })).toBe("MALFORMED_HEADERS");
    expect(check({}, { "X-App-Key": "ak_1" } as typeof headers)).toBe("MISSING_HEADERS");
    expect(check()).toBe("ok");
    expect(check()).toBe("REPLAYED_NONCE");
  });
});

describe("simulated gateway merchant API", () => {
  let sim: SimulatedAdapters;
  beforeEach(() => {
    sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret" });
  });

  function clientWith(overrides: { appSecret?: string; privateKey?: KeyObject; merchantName?: string } = {}): MerchantClient {
    return new MerchantClient({
      credentials: { appKey: "sim-app-key", appSecret: overrides.appSecret ?? "app-secret", merchantName: overrides.merchantName ?? MERCHANT, privateKey: overrides.privateKey ?? keyPair().privateKey },
      transport: (request) => sim.gateway.handle(request),
      clock: sim.clock,
    });
  }

  it("creates the order from a signed Cart Mandate and answers queries in the documented shape", async () => {
    const mandate = sim.merchant.signCartMandate(quoteContents(ORDER, MERCHANT));
    expect(await sim.merchant.createOrder(mandate)).toEqual({ payment_request_id: "pr-0001", payment_url: expect.stringContaining("sim-flow-"), multi_pay: false });
    const raw = await sim.gateway.handle({ method: "GET", path: "/api/v1/merchant/payments", query: "cart_mandate_id=cart-0001", headers: {}, body: undefined });
    expect(JSON.parse(raw.body)).toMatchObject({ code: 10002 });
    const [record] = await sim.merchant.paymentsByCartMandateId("cart-0001");
    expect(record).toMatchObject({ cart_mandate_id: "cart-0001", status: "payment-required", product_amount: "1.00", usd_amount_rate: "1", network: "hashkey-testnet" });
  });

  it("refuses bad request signatures, foreign merchant keys, broken amounts, expired carts, and reused cart IDs", async () => {
    const contents = quoteContents(ORDER, MERCHANT);
    await expect(clientWith({ appSecret: "wrong" }).createOrder(sim.merchant.signCartMandate(contents))).rejects.toMatchObject({ code: "10002", httpStatus: 401 });
    const impostor = clientWith();
    await expect(impostor.createOrder(impostor.signCartMandate(contents))).rejects.toMatchObject({ code: "10002" });

    const tampered: CartMandate = { ...sim.merchant.signCartMandate(contents), contents: { ...contents, merchant_name: "My Store" } };
    await expect(sim.merchant.createOrder(tampered)).rejects.toMatchObject({ code: "10002" });
    const badTotal = structuredClone(contents);
    badTotal.payment_request.details.total.amount.value = "2.00";
    await expect(sim.merchant.createOrder(sim.merchant.signCartMandate(badTotal))).rejects.toMatchObject({ code: "10001" });
    await expect(sim.merchant.createOrder(sim.merchant.signCartMandate({ ...contents, cart_expiry: "2026-10-30T09:00:00Z" }))).rejects.toMatchObject({ code: "40001" });

    await sim.merchant.createOrder(sim.merchant.signCartMandate(contents));
    await expect(sim.merchant.createOrder(sim.merchant.signCartMandate(contents))).rejects.toMatchObject({ code: "40001" });
    expect(sim.gateway.orderCount()).toBe(1);
  });

  it("refuses a Payment Mandate that is not bound to the order's cart hash and amount due", async () => {
    const prepared = await sim.rail.prepare(ORDER);
    const validation = validateCartMandate(validInput({ cartMandate: prepared.cartMandate }, sim.merchantPublicKey));
    if (!validation.ok) throw new Error("expected a valid cart");
    const sign = (payload: SignedPayload["payload"]) => ({ payload, signature: `sim-signature:${createHash("sha256").update(`${payload.payer}:${payload.nonce}`).digest("hex")}` });
    const mandate = buildSimulatedPaymentMandate(validation.cart, BUYER);
    await expect(sim.rail.submit(sign({ ...mandate, cartSha256: "00".repeat(32) }))).rejects.toMatchObject({ code: "10001" });
    await expect(sim.rail.submit(sign({ ...mandate, amountBaseUnits: "999999" }))).rejects.toMatchObject({ code: "10001" });
    await expect(sim.rail.submit(sign({ ...mandate, payee: OTHER }))).rejects.toMatchObject({ code: "10001" });
    await sim.rail.submit(sign(mandate));
    expect((await sim.rail.observe(ORDER.paymentRequestId)).record.payer_address).toBe(BUYER);
  });
});

function validInput(overrides: Partial<ValidateCartInput>, publicKey: KeyObject): ValidateCartInput {
  return {
    cartMandate: undefined,
    merchant: { merchantName: MERCHANT, publicKey },
    intent: ORDER,
    policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0", maxFeeBaseUnits: "100000", usdRate: "1" },
    now: NOW,
    ...overrides,
  };
}

describe("Payment Agent checks before signing", () => {
  const merchant = keyPair();
  const signer = new MerchantClient({
    credentials: { appKey: "ak", appSecret: "s", merchantName: MERCHANT, privateKey: merchant.privateKey },
    transport: async () => ({ status: 500, body: "" }),
    clock: new ManualClock(NOW.toISOString()),
  });
  const signed = (edit: (contents: CartContents) => void = () => undefined): CartMandate => {
    const contents = quoteContents(ORDER, MERCHANT);
    edit(contents);
    return signer.signCartMandate(contents);
  };
  const codes = (overrides: Partial<ValidateCartInput>): string[] => {
    const result = validateCartMandate(validInput(overrides, merchant.publicKey));
    return result.ok ? [] : result.rejections.map((entry) => entry.code);
  };

  it("accepts a cart that matches the intent and limits, and derives the amount from it", () => {
    const result = validateCartMandate(validInput({ cartMandate: signed() }, merchant.publicKey));
    expect(result).toMatchObject({ ok: true, cart: { amountBaseUnits: "1000000", grossLimitBaseUnits: "1100000", payee: SELLER, methodIndex: 0 } });
  });

  it("reports every check: passed when made, blocked with its reason, not checked when an earlier failure made it moot", () => {
    const statuses = (overrides: Partial<ValidateCartInput>) => Object.fromEntries(validateCartMandate(validInput(overrides, merchant.publicKey)).checks.map((check) => [check.id, check.status]));
    const base = validInput({ cartMandate: signed() }, merchant.publicKey);
    expect(new Set(Object.values(statuses({ cartMandate: signed() })))).toEqual(new Set(["passed"]));
    expect(Object.keys(statuses({ cartMandate: signed() }))).toHaveLength(12);

    const mandate = signed();
    const altered = { ...mandate, contents: { ...mandate.contents, payment_request: { ...mandate.contents.payment_request, details: { ...mandate.contents.payment_request.details, total: { label: "Total", amount: { currency: "USD", value: "0.50" } } } } } };
    expect(statuses({ cartMandate: altered })).toMatchObject({ "merchant-signature": "blocked", price: "blocked", "order-binding": "passed", "daily-cap": "passed" });

    expect(new Set(Object.entries(statuses({ cartMandate: {} })).filter(([id]) => id !== "cart-format").map(([, status]) => status))).toEqual(new Set(["not-checked"]));
    expect(statuses({ cartMandate: {} })["cart-format"]).toBe("blocked");

    const otherChain = statuses({ cartMandate: signed(), intent: { ...base.intent, chainId: 177 } });
    expect(otherChain).toMatchObject({ "merchant-signature": "passed", "recipient-chain-token": "blocked", "payee-allowlist": "not-checked", price: "not-checked", "daily-cap": "not-checked" });

    const capped = validateCartMandate(validInput({ cartMandate: signed(), policy: { ...base.policy, perPaymentCapBaseUnits: "1000" } }, merchant.publicKey));
    expect(capped.checks.find((check) => check.id === "per-payment-cap")).toMatchObject({ status: "blocked", reason: "the gross amount exceeds the per-payment cap" });
    expect(capped.checks.find((check) => check.id === "daily-cap")?.status).toBe("passed");
  });

  it("rejects a cart altered after the merchant signed it", () => {
    const mandate = signed();
    const altered = { ...mandate, contents: { ...mandate.contents, payment_request: { ...mandate.contents.payment_request, details: { ...mandate.contents.payment_request.details, total: { label: "Total", amount: { currency: "USD", value: "0.50" } } } } } };
    expect(codes({ cartMandate: altered })).toEqual(expect.arrayContaining(["MERCHANT_SIGNATURE", "PRICE_MISMATCH"]));
  });

  it("rejects a field added to the contents after signing, even one this code does not model", () => {
    const mandate = signed();
    const extended = { ...mandate, contents: { ...mandate.contents, refund_to: OTHER } };
    expect(codes({ cartMandate: extended })).toEqual(["MERCHANT_SIGNATURE"]);
  });

  it("rejects a merchant key that was not pinned, the wrong audience, and expired authorizations", () => {
    const impostor = new MerchantClient({ credentials: { appKey: "ak", appSecret: "s", merchantName: MERCHANT, privateKey: keyPair().privateKey }, transport: async () => ({ status: 500, body: "" }), clock: new ManualClock(NOW.toISOString()) });
    expect(codes({ cartMandate: impostor.signCartMandate(quoteContents(ORDER, MERCHANT)) })).toEqual(["MERCHANT_SIGNATURE"]);
    const contents = quoteContents(ORDER, MERCHANT);
    const wrongAudience = { contents, merchant_authorization: signMerchantJwt(claims(cartHash(contents), { aud: "Other" }), merchant.privateKey) };
    expect(codes({ cartMandate: wrongAudience })).toEqual(["MERCHANT_SIGNATURE"]);
    // Signed with the pinned key, but presenting another merchant's name to the payer.
    const renamed = { ...contents, merchant_name: "Another Store" };
    expect(codes({ cartMandate: { contents: renamed, merchant_authorization: signMerchantJwt(claims(cartHash(renamed)), merchant.privateKey) } })).toEqual(["WRONG_MERCHANT"]);
    expect(codes({ cartMandate: signed(), now: new Date(NOW.getTime() + 3601_000) })).toEqual(["MERCHANT_SIGNATURE"]);
    expect(codes({ cartMandate: signed((c) => (c.cart_expiry = "2026-10-30T09:59:59Z")) })).toEqual(["CART_EXPIRED"]);
  });

  it("rejects a payee, chain, or token that differs from the operation intent", () => {
    expect(codes({ cartMandate: signed((c) => (c.payment_request.method_data[0]!.data.pay_to = OTHER)) })).toEqual(["NO_MATCHING_OPTION"]);
    expect(codes({ cartMandate: signed((c) => (c.payment_request.method_data[0]!.data.chain_id = 177)) })).toEqual(["NO_MATCHING_OPTION"]);
    expect(codes({ cartMandate: signed((c) => (c.payment_request.method_data[0]!.data.contract_address = OTHER)) })).toEqual(["NO_MATCHING_OPTION"]);
    expect(codes({ cartMandate: signed((c) => (c.id = "cart-other")) })).toEqual(["ID_MISMATCH"]);
  });

  it("rejects a USD amount due that differs from the agreed price, including a fee modifier", () => {
    const higher = signed((c) => {
      c.payment_request.details.total.amount.value = "1.50";
      c.payment_request.details.display_items = [{ label: "Job", amount: { currency: "USD", value: "1.50" } }];
    });
    expect(codes({ cartMandate: higher })).toEqual(["PRICE_MISMATCH"]);
    const withFee = signed((c) => {
      c.payment_request.details.modifiers = [
        { supported_methods: "https://www.x402.org/", additional_display_items: [{ label: "Fee", amount: { currency: "USD", value: "0.20" } }], total: { label: "Due", amount: { currency: "USD", value: "1.20" } } },
      ];
    });
    expect(codes({ cartMandate: withFee })).toEqual(["PRICE_MISMATCH"]);
    // Decimals compare by value: a total of "1.0" is the agreed "1.00".
    expect(codes({ cartMandate: signed((c) => (c.payment_request.details.total.amount.value = "1.0")) })).toEqual([]);
    expect(codes({ cartMandate: signed((c) => (c.payment_request.details.total.amount.value = "1.10")) })).toEqual(["INVALID_AMOUNTS", "PRICE_MISMATCH"]);
  });

  it("applies the caps to the gross amount and the allowlist to the payee", () => {
    const policy = validInput({}, merchant.publicKey).policy;
    expect(codes({ cartMandate: signed(), policy: { ...policy, perPaymentCapBaseUnits: "1099999" } })).toEqual(["OVER_PER_PAYMENT_CAP"]);
    expect(codes({ cartMandate: signed(), policy: { ...policy, spentTodayBaseUnits: "18900001" } })).toEqual(["OVER_DAILY_CAP"]);
    expect(codes({ cartMandate: signed(), policy: { ...policy, payeeAllowlist: [OTHER] } })).toEqual(["PAYEE_NOT_ALLOWED"]);
    expect(codes({ cartMandate: signed(), policy: { ...policy, usdRate: "3" } })).toEqual(["RATE_UNSUPPORTED"]);
  });

  it("refuses malformed input without throwing", () => {
    expect(codes({ cartMandate: { contents: {} } })).toEqual(["MALFORMED_CART"]);
    expect(codes({ cartMandate: "not an object" })).toEqual(["MALFORMED_CART"]);
    expect(() => parseCartMandate({ ...signed(), contents: { ...signed().contents, payment_request: { method_data: [], details: {} } } })).toThrow();
  });
});

describe("one signature per attempt", () => {
  const signedPayload = { payload: { paymentRequestId: "pr-1" }, signature: "sig" } as unknown as SignedPayload;
  const rail = (submit: () => Promise<void>, observe: () => Promise<unknown>): PaymentRail =>
    ({ provenance: "SIMULATED", prepare: vi.fn(), submit: vi.fn(submit), observe: vi.fn(observe) }) as unknown as PaymentRail;
  const record = (status: string) => ({ record: { status, tx_signature: null } });

  it("reconciles a lost submission by query and never resubmits", async () => {
    const lost = async () => {
      throw new RailTimeoutError("submit");
    };
    const advanced = rail(lost, async () => record("payment-submitted"));
    expect(await submitPaymentMandate(advanced, signedPayload)).toBe("SUBMITTED");
    expect(advanced.submit).toHaveBeenCalledTimes(1);
    expect(await submitPaymentMandate(rail(lost, async () => record("payment-required")), signedPayload)).toBe("OUTCOME_UNKNOWN");
    expect(
      await submitPaymentMandate(
        rail(lost, async () => {
          throw new RailUnavailableError("query");
        }),
        signedPayload,
      ),
    ).toBe("OUTCOME_UNKNOWN");
    await expect(submitPaymentMandate(rail(async () => Promise.reject(new Error("refused")), async () => record("payment-required")), signedPayload)).rejects.toThrow("refused");
  });
});

describe("gateway records and settlement", () => {
  const webhook = {
    event_type: "payment",
    payment_request_id: "pr-1",
    request_id: "req-1",
    cart_mandate_id: "cart-1",
    flow_id: "flow-1",
    payer_address: BUYER,
    to_pay_address: SELLER,
    amount: "1.01",
    order_amount: "1.00",
    product_amount: "1.00",
    pay_amount: "1.01",
    token: "USDC",
    token_address: TOKEN,
    chain: "eip155:133",
    network: "hashkey-testnet",
    status: "payment-finalized",
    status_reason: null,
    created_at: NOW.toISOString(),
    tx_signature: `0x${"a".repeat(64)}`,
    included_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
  };
  const expected = { payer: BUYER, payee: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" };
  const transfer = { txHash: webhook.tx_signature, chainId: 133, token: TOKEN, from: BUYER, to: SELLER, amountBaseUnits: "1000000", blockNumber: 5, confirmations: 10, status: "success" as const };

  it("never verifies a payment from a finalized webhook alone", () => {
    const record = parsePaymentRecord(webhook);
    expect(record.usd_amount_rate).toBeNull();
    expect(verifySettlement({ expected, tokenDecimals: 6, record, transfer: null, requiredLevel: "FINAL" }).status).toBe("INCONSISTENT");
    expect(verifySettlement({ expected, tokenDecimals: 6, record, transfer, requiredLevel: "FINAL" }).status).toBe("VERIFIED");
  });

  it("blocks verification when the gateway applied a rate other than the pinned one", () => {
    const record = parsePaymentRecord({ ...webhook, usd_amount_rate: "1.02" });
    const verdict = verifySettlement({ expected, tokenDecimals: 6, record, transfer, requiredLevel: "FINAL" });
    expect(verdict).toMatchObject({ status: "MISMATCH", reasons: [expect.stringMatching(/pinned stablecoin rate/)] });
    expect(verifySettlement({ expected, tokenDecimals: 6, record: { ...record, usd_amount_rate: "1.0" }, transfer, requiredLevel: "FINAL" }).status).toBe("VERIFIED");
  });

  it("refuses malformed records instead of guessing", () => {
    expect(() => parsePaymentRecord({ ...webhook, status: "paid" })).toThrow(/unknown gateway status/);
    expect(() => parsePaymentRecord({ ...webhook, cart_mandate_id: undefined })).toThrow(/cart mandate ID/);
    expect(() => parsePaymentRecord({ ...webhook, order_amount: 1 })).toThrow(/order_amount/);
  });
});

describe("live transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires HTTPS and reports a failed POST as an unknown outcome but a failed GET as unavailable", async () => {
    expect(() => fetchTransport("http://merchant-qa.hashkeymerchant.com", 1000)).toThrow(/HTTPS/);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const transport = fetchTransport("https://merchant-qa.hashkeymerchant.com", 1000);
    const request = { path: "/api/v1/merchant/orders", query: "", headers: {}, body: "{}" };
    await expect(transport({ ...request, method: "POST" })).rejects.toBeInstanceOf(RailTimeoutError);
    await expect(transport({ ...request, method: "GET", body: undefined })).rejects.toBeInstanceOf(RailUnavailableError);
  });
});

describe("simulator wiring", () => {
  it("signs webhooks with the application secret and keeps orders per application", async () => {
    const clock = new ManualClock(NOW.toISOString());
    const gateway = new SimGateway({ clock, chain: new SimChain(133) });
    const first = keyPair();
    gateway.registerApp({ appKey: "app-a", appSecret: "secret-a", merchantName: MERCHANT, publicKey: first.publicKey });
    gateway.registerApp({ appKey: "app-b", appSecret: "secret-b", merchantName: MERCHANT, publicKey: keyPair().publicKey });
    const client = (appKey: string, appSecret: string) =>
      new MerchantClient({ credentials: { appKey, appSecret, merchantName: MERCHANT, privateKey: first.privateKey }, transport: (request) => gateway.handle(request), clock });
    await client("app-a", "secret-a").createOrder(client("app-a", "secret-a").signCartMandate(quoteContents(ORDER, MERCHANT)));
    await expect(client("app-b", "secret-b").paymentByRequestId("pr-0001")).rejects.toMatchObject({ code: "10003" });
  });
});

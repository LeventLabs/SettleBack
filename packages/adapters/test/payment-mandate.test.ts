import { beforeEach, describe, expect, it } from "vitest";
import { domainSeparator, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "@settleback/domain";
import {
  EIP3009_TYPES,
  buildEip3009PaymentMandate,
  createSimulatedAdapters,
  eip3009TypedData,
  submitPaymentMandate,
  tokenDomain,
  validateCartMandate,
  verifyEip3009Signature,
  walletTypedData,
  type Ap2MandatePayload,
  type SimulatedAdapters,
  type TokenDomain,
  type TransferAuthorization,
  type ValidatedCart,
} from "../src/index.ts";

const SELLER = "0x00000000000000000000000000000000000000a1" as Address;
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const payer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const other = privateKeyToAccount(`0x${"c3".repeat(32)}`);

// Read from the HashKey testnet USDC contract (0x8FE3…53c6): DOMAIN_SEPARATOR() and TRANSFER_WITH_AUTHORIZATION_TYPEHASH().
const ONCHAIN_DOMAIN_SEPARATOR = "0x4b73b8fe157f795886e2aa243f2ccddcc00b80eaa9f9b4b368b716895be71d09";
const ONCHAIN_TYPEHASH = "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";

let sim: SimulatedAdapters;
let cart: ValidatedCart;
let expiresAt: string;

beforeEach(async () => {
  sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret" });
  expiresAt = new Date(sim.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString();
  const prepared = await sim.rail.prepare({ cartMandateId: "cart-1", paymentRequestId: "pr-1", payee: SELLER, chainId: 133, token: TOKEN, coin: "USDC", tokenDecimals: 6, priceUsd: "1.00", label: "job", expiresAt });
  const validation = validateCartMandate({
    cartMandate: prepared.cartMandate,
    merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
    intent: { cartMandateId: "cart-1", paymentRequestId: "pr-1", payee: SELLER, chainId: 133, token: TOKEN, tokenDecimals: 6, priceUsd: "1.00" },
    policy: { payeeAllowlist: [SELLER], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", spentTodayBaseUnits: "0", maxFeeBaseUnits: "100000", usdRate: "1" },
    now: sim.clock.now(),
  });
  if (!validation.ok) throw new Error("cart rejected");
  cart = validation.cart;
});

function mandate(overrides: { payer?: Address; cartExpiry?: string } = {}): Ap2MandatePayload {
  return buildEip3009PaymentMandate({
    provenance: "SIMULATED",
    cartMandateId: cart.cartMandateId,
    paymentRequestId: cart.paymentRequestId,
    cartSha256: cart.cartSha256,
    payer: overrides.payer ?? (payer.address as Address),
    payee: cart.payee,
    chainId: cart.chainId,
    token: cart.token,
    amountBaseUnits: cart.amountBaseUnits,
    totalUsd: cart.totalUsd,
    cartExpiry: overrides.cartExpiry ?? expiresAt,
    merchantName: "SettleBack Demo Seller",
    issuedAt: "2026-10-30T10:00:00.000Z",
  });
}

async function signed(payload: Ap2MandatePayload, signer = payer) {
  return { payload, signature: await signer.signTypedData(eip3009TypedData(payload)) };
}

/** The mandate with its authorization changed consistently: the signed copy and the one inside the AP2 mandate. */
function rebound(payload: Ap2MandatePayload, changes: Partial<TransferAuthorization>): Ap2MandatePayload {
  const authorization = { ...payload.authorization, ...changes };
  return { ...payload, authorization, mandate: withEmbedded(payload, authorization) };
}

function withEmbedded(payload: Ap2MandatePayload, authorization: TransferAuthorization): Ap2MandatePayload["mandate"] {
  const contents = payload.mandate.payment_mandate_contents;
  return { payment_mandate_contents: { ...contents, payment_response: { ...contents.payment_response, details: { ...contents.payment_response.details, authorization } } } };
}

/** Signed by the payer under a domain other than the token's. */
function underDomain(payload: Ap2MandatePayload, changes: Partial<TokenDomain>) {
  return signed({ ...payload, domain: { ...payload.domain, ...changes } });
}

describe("the EIP-3009 authorization", () => {
  it("matches the HashKey testnet USDC contract's domain and type hash", () => {
    const domain = tokenDomain(133, TOKEN);
    expect(domain).toEqual({ name: "USD Coin", version: "2", chainId: 133, verifyingContract: TOKEN });
    expect(domainSeparator({ domain: { ...domain, verifyingContract: TOKEN as Hex } })).toBe(ONCHAIN_DOMAIN_SEPARATOR);
    const encoded = `TransferWithAuthorization(${EIP3009_TYPES.TransferWithAuthorization.map((field) => `${field.type} ${field.name}`).join(",")})`;
    expect(keccak256(toHex(encoded))).toBe(ONCHAIN_TYPEHASH);
  });

  it("authorizes exactly the cart's transfer, deterministically per order and payer", () => {
    const payload = mandate();
    expect(payload.authorization).toEqual({ from: payer.address.toLowerCase(), to: SELLER, value: "1000000", validAfter: "0", validBefore: String(Math.floor(Date.parse(expiresAt) / 1000)), nonce: payload.nonce });
    expect(payload.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mandate()).toEqual(payload);
    expect(mandate({ payer: other.address as Address }).nonce).not.toBe(payload.nonce);
    const contents = payload.mandate.payment_mandate_contents;
    expect(contents).toMatchObject({ payment_mandate_id: "pr-1", merchant_agent: "SettleBack Demo Seller", payment_details_total: { amount: { currency: "USD", value: "1.00" } } });
    expect(contents.payment_response).toMatchObject({ request_id: "pr-1", method_name: "https://www.x402.org/", details: { x402Version: 2, scheme: "exact", network: "hashkey-testnet", chain_id: 133, protocol: "eip3009", authorization: payload.authorization } });
    expect(() => buildEip3009PaymentMandate({ ...payloadTerms(), token: `0x${"9".repeat(40)}` as Address })).toThrow(/No pinned EIP-712 domain/);
  });

  it("is offered to a wallet as eth_signTypedData_v4 data", () => {
    const typed = walletTypedData(mandate());
    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.types.EIP712Domain.map((field) => field.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(JSON.parse(JSON.stringify(typed)).message.value).toBe("1000000");
  });

  it("verifies only the payer's signature of exactly this authorization", async () => {
    const payload = mandate();
    const { signature } = await signed(payload);
    expect(await verifyEip3009Signature(payload, signature)).toBe(true);
    expect(await verifyEip3009Signature(payload, (await signed(payload, other)).signature)).toBe(false);
    expect(await verifyEip3009Signature({ ...payload, authorization: { ...payload.authorization, value: "999999" } }, signature)).toBe(false);
    expect(await verifyEip3009Signature(payload, "0x1234")).toBe(false);
    // The token checks the signer against `from`: the payer's signature of an authorization from someone else is not valid.
    const fromOther = { ...payload, authorization: { ...payload.authorization, from: other.address.toLowerCase() as Address } };
    expect(await verifyEip3009Signature(fromOther, (await signed(fromOther)).signature)).toBe(false);
  });
});

function payloadTerms() {
  return {
    provenance: "SIMULATED" as const,
    cartMandateId: cart.cartMandateId,
    paymentRequestId: cart.paymentRequestId,
    cartSha256: cart.cartSha256,
    payer: payer.address as Address,
    payee: cart.payee,
    chainId: cart.chainId,
    token: cart.token,
    amountBaseUnits: cart.amountBaseUnits,
    totalUsd: cart.totalUsd,
    cartExpiry: expiresAt,
    merchantName: "SettleBack Demo Seller",
    issuedAt: "2026-10-30T10:00:00.000Z",
  };
}

describe("the simulated gateway", () => {
  it("settles a mandate carrying the payer's valid authorization, from the payer's account", async () => {
    expect(await submitPaymentMandate(sim.rail, await signed(mandate()))).toBe("SUBMITTED");
    for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
    const observation = await sim.rail.observe("pr-1");
    expect(observation.record.status).toBe("payment-finalized");
    expect(observation.transfer).toMatchObject({ from: payer.address.toLowerCase(), to: SELLER, amountBaseUnits: "1000000" });
  });

  it("refuses a mandate whose authorization does not verify, and settles nothing", async () => {
    const payload = mandate();
    const refusals = [
      // Signed by someone else.
      { payload, signature: (await signed(payload, other)).signature },
      // The payer signed it, but under a domain the token does not have.
      await underDomain(payload, { name: "Fake USD" }),
      await underDomain(payload, { version: "1" }),
      await underDomain(payload, { chainId: 1 }),
      await underDomain(payload, { verifyingContract: `0x${"9".repeat(40)}` as Address }),
      // The payer signed a different recipient.
      await signed({ ...payload, payee: `0x${"d1".repeat(20)}` as Address, authorization: { ...payload.authorization, to: `0x${"d1".repeat(20)}` as Address } }),
      // A placeholder signature on an AP2 mandate.
      { payload, signature: `sim-signature:${"0".repeat(64)}` },
    ];
    for (const attempt of refusals) await expect(submitPaymentMandate(sim.rail, attempt)).rejects.toMatchObject({ code: "10001" });
    expect((await sim.rail.observe("pr-1")).record.status).toBe("payment-required");
  });

  it("refuses an authorization that pays anyone, anything, or from anyone but the order says", async () => {
    const payload = mandate();
    const attacker = `0x${"d1".repeat(20)}` as Address;
    const variants: Ap2MandatePayload[] = [
      // The order's payee in the mandate, another recipient in what the token would execute.
      rebound(payload, { to: attacker }),
      // The order's amount in the mandate, another value in the authorization.
      rebound(payload, { value: "1" }),
      // An authorization nonce other than the mandate's.
      rebound(payload, { nonce: `0x${"e5".repeat(32)}` }),
      // The signed authorization is the order's, but the AP2 mandate carries another.
      { ...payload, mandate: withEmbedded(payload, { ...payload.authorization, to: attacker }) },
      // The mandate bound to another order.
      { ...payload, mandate: { payment_mandate_contents: { ...payload.mandate.payment_mandate_contents, payment_mandate_id: "pr-other" } } },
    ];
    for (const variant of variants) await expect(submitPaymentMandate(sim.rail, await signed(variant))).rejects.toMatchObject({ code: "10001" });
    // Signed by its own `from`, but that is not the payer the mandate names.
    await expect(submitPaymentMandate(sim.rail, await signed(rebound(payload, { from: other.address.toLowerCase() as Address }), other))).rejects.toMatchObject({ code: "10001" });
    expect((await sim.rail.observe("pr-1")).record.status).toBe("payment-required");
  });

  it("refuses an authorization nonce the token has already executed, even on another order", async () => {
    const first = mandate();
    expect(await submitPaymentMandate(sim.rail, await signed(first))).toBe("SUBMITTED");
    const order = await sim.rail.prepare({ cartMandateId: "cart-2", paymentRequestId: "pr-2", payee: SELLER, chainId: 133, token: TOKEN, coin: "USDC", tokenDecimals: 6, priceUsd: "1.00", label: "job", expiresAt });
    const second = buildEip3009PaymentMandate({ ...payloadTerms(), cartMandateId: "cart-2", paymentRequestId: "pr-2", cartSha256: order.cartSha256 });
    const replayed = { ...rebound(second, { nonce: first.nonce }), nonce: first.nonce };
    await expect(submitPaymentMandate(sim.rail, await signed(replayed))).rejects.toMatchObject({ code: "10001" });
    // The same nonce and account spelled in other letter cases are the same authorization to the token.
    const upperNonce = `0x${first.nonce.slice(2).toUpperCase()}`;
    const respelled = { ...rebound(second, { nonce: upperNonce, from: payer.address as Address }), nonce: upperNonce };
    await expect(submitPaymentMandate(sim.rail, await signed(respelled))).rejects.toMatchObject({ code: "10001" });
    expect(await submitPaymentMandate(sim.rail, await signed(second))).toBe("SUBMITTED");
  });

  it("refuses an authorization before its validAfter and from its validBefore second on", async () => {
    const notYet = rebound(mandate(), { validAfter: String(Math.floor(sim.clock.now().getTime() / 1000) + 3600) });
    await expect(submitPaymentMandate(sim.rail, await signed(notYet))).rejects.toMatchObject({ code: "10001" });
    const payload = mandate({ cartExpiry: new Date(sim.clock.now().getTime() + 60_000).toISOString() });
    sim.clock.advance(Number(payload.authorization.validBefore) * 1000 - sim.clock.now().getTime());
    await expect(submitPaymentMandate(sim.rail, await signed(payload))).rejects.toMatchObject({ code: "10001" });
    expect((await sim.rail.observe("pr-1")).record.status).toBe("payment-required");
  });

  it("does not accept the same authorization twice", async () => {
    const first = await signed(mandate());
    expect(await submitPaymentMandate(sim.rail, first)).toBe("SUBMITTED");
    await expect(submitPaymentMandate(sim.rail, first)).rejects.toMatchObject({ code: expect.stringMatching(/^(10001|40001)$/) });
    for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
    expect((await sim.rail.observe("pr-1")).record.status).toBe("payment-finalized");
  });
});

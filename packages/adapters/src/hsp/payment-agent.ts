import { createHash, type KeyObject } from "node:crypto";
import type { Address } from "@settleback/domain";
import { classifyGatewayRecord } from "../gateway.ts";
import { RailTimeoutError, type ExecutionPayload, type PaymentRail, type SignedPayload } from "../rail.ts";
import { CartShapeError, cartAmountProblems, cartHash, effectiveTotal, normalizeMethod, parseCartMandate, sameUsd, usdUnits, X402_METHOD } from "./cart-mandate.ts";
import { verifyMerchantJwt, type JwtRejection } from "./jwt.ts";

/** The seller's merchant identity as the buyer pinned it before any quote arrived. */
export interface PinnedMerchant {
  merchantName: string;
  publicKey: KeyObject;
}

/** What the buyer agreed to buy, from the immutable operation intent. */
export interface PaymentIntent {
  cartMandateId: string;
  paymentRequestId: string;
  payee: Address;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  priceUsd: string;
}

/** The buyer's spending limits. Caps apply to the gross amount, so the configured maximum fee is added to the price. */
export interface BuyerSpendPolicy {
  payeeAllowlist: readonly Address[];
  perPaymentCapBaseUnits: string;
  dailyCapBaseUnits: string;
  /** Booked and outstanding gross spend for the current day, including uncertain payments. */
  spentTodayBaseUnits: string;
  maxFeeBaseUnits: string;
  /** Pinned USD per token for the stablecoin. */
  usdRate: string;
}

export type CartRejectionCode =
  | "MALFORMED_CART"
  | "MERCHANT_SIGNATURE"
  | "WRONG_MERCHANT"
  | "CART_EXPIRED"
  | "INVALID_AMOUNTS"
  | "ID_MISMATCH"
  | "NO_MATCHING_OPTION"
  | "PRICE_MISMATCH"
  | "RATE_UNSUPPORTED"
  | "PAYEE_NOT_ALLOWED"
  | "OVER_PER_PAYMENT_CAP"
  | "OVER_DAILY_CAP";

export interface CartRejection {
  code: CartRejectionCode;
  message: string;
}

/** A Cart Mandate that passed every check, reduced to the fields a Payment Mandate may use. */
export interface ValidatedCart {
  cartMandateId: string;
  paymentRequestId: string;
  cartSha256: string;
  methodIndex: number;
  payee: Address;
  chainId: number;
  token: Address;
  totalUsd: string;
  amountBaseUnits: string;
  /** Amount plus the maximum fee: what the caps were checked against. */
  grossLimitBaseUnits: string;
}

/** Each check the Payment Agent makes, in the order it makes them. */
export const CART_CHECKS = [
  { id: "cart-format", label: "The Cart Mandate parses, and its hash is recomputed from the contents received" },
  { id: "merchant-signature", label: "The merchant JWT verifies against the pinned merchant key and the recomputed cart hash" },
  { id: "merchant-identity", label: "The issuer and the merchant name are the pinned merchant" },
  { id: "cart-expiry", label: "The cart has not expired" },
  { id: "amount-rules", label: "The amounts follow the gateway's amount rules" },
  { id: "order-binding", label: "The cart and payment request IDs are the ones recorded for this order" },
  { id: "recipient-chain-token", label: "A payment option pays the intended seller on the intended chain and token" },
  { id: "payee-allowlist", label: "The seller is on the buyer's payee allowlist" },
  { id: "price", label: "The amount due equals the agreed price" },
  { id: "pinned-rate", label: "The amount converts to whole token units at the pinned stablecoin rate" },
  { id: "per-payment-cap", label: "Price plus the maximum fee fits the per-payment cap" },
  { id: "daily-cap", label: "Price plus the maximum fee fits today's cap" },
] as const;

export type CartCheckId = (typeof CART_CHECKS)[number]["id"];

/** One check's result. A check skipped because an earlier failure made it meaningless is "not-checked", never "passed". */
export interface PaymentCheck<Id extends string = string> {
  id: Id;
  label: string;
  status: "passed" | "blocked" | "not-checked";
  /** Why it was blocked or not checked, or null. */
  reason: string | null;
}

export type CartCheck = PaymentCheck<CartCheckId>;

export type CartValidation = { ok: true; cart: ValidatedCart; checks: CartCheck[] } | { ok: false; rejections: CartRejection[]; checks: CartCheck[] };

export interface ValidateCartInput {
  /** The Cart Mandate exactly as received; it is untrusted. */
  cartMandate: unknown;
  merchant: PinnedMerchant;
  intent: PaymentIntent;
  policy: BuyerSpendPolicy;
  now: Date;
}

/**
 * The Payment Agent's checks before anything is signed. The cart hash is recomputed over the
 * received contents, the merchant JWT is verified against the pinned key, and every payment field
 * must agree with the operation intent and stay inside the buyer's limits. Every failed check is
 * reported, not only the first.
 */
export function validateCartMandate(input: ValidateCartInput): CartValidation {
  const { intent, policy, merchant } = input;
  const rejections: CartRejection[] = [];
  const results = new Map<CartCheckId, string[]>();
  const reject = (check: CartCheckId, code: CartRejectionCode, message: string): void => {
    rejections.push({ code, message });
    results.set(check, [...(results.get(check) ?? []), message]);
  };
  // Marks a check as made; it passed unless it was rejected.
  const made = (...checks: CartCheckId[]): void => {
    for (const check of checks) if (!results.has(check)) results.set(check, []);
  };
  const report = (): CartCheck[] =>
    CART_CHECKS.map(({ id, label }) => {
      const reasons = results.get(id);
      if (reasons === undefined) return { id, label, status: "not-checked", reason: null };
      return reasons.length === 0 ? { id, label, status: "passed", reason: null } : { id, label, status: "blocked", reason: reasons.join("; ") };
    });

  let mandate: ReturnType<typeof parseCartMandate>;
  let hash: string;
  try {
    mandate = parseCartMandate(input.cartMandate);
    hash = cartHash((input.cartMandate as { contents: unknown }).contents);
  } catch (error) {
    const message = error instanceof CartShapeError || error instanceof Error ? error.message : String(error);
    reject("cart-format", "MALFORMED_CART", message);
    return { ok: false, rejections, checks: report() };
  }
  made("cart-format");
  const { contents } = mandate;
  const nowSeconds = Math.floor(input.now.getTime() / 1000);

  const jwt = verifyMerchantJwt(mandate.merchant_authorization, merchant.publicKey, hash, nowSeconds);
  if (!jwt.ok) reject("merchant-signature", "MERCHANT_SIGNATURE", JWT_MESSAGES[jwt.reason]);
  else if (jwt.claims.iss !== merchant.merchantName || jwt.claims.sub !== merchant.merchantName) reject("merchant-identity", "WRONG_MERCHANT", "the JWT issuer is not the pinned merchant");
  if (contents.merchant_name !== merchant.merchantName) reject("merchant-identity", "WRONG_MERCHANT", "merchant_name is not the pinned merchant");
  made("merchant-signature", "merchant-identity");

  const expiry = Date.parse(contents.cart_expiry);
  if (!Number.isFinite(expiry) || expiry <= input.now.getTime()) reject("cart-expiry", "CART_EXPIRED", "cart_expiry has passed or is not a valid time");
  for (const problem of cartAmountProblems(contents)) reject("amount-rules", "INVALID_AMOUNTS", problem);
  if (contents.id !== intent.cartMandateId || contents.payment_request.details.id !== intent.paymentRequestId) {
    reject("order-binding", "ID_MISMATCH", "the cart or payment request ID is not the one recorded for this attempt");
  }
  made("cart-expiry", "amount-rules", "order-binding");

  const options = contents.payment_request.method_data.flatMap((method, index) =>
    normalizeMethod(method.supported_methods) === normalizeMethod(X402_METHOD) &&
    method.data.chain_id === intent.chainId &&
    method.data.contract_address.toLowerCase() === intent.token.toLowerCase()
      ? [{ method, index }]
      : [],
  );
  const option = options.find(({ method }) => method.data.pay_to.toLowerCase() === intent.payee.toLowerCase());
  if (option === undefined) {
    reject("recipient-chain-token", "NO_MATCHING_OPTION", options.length === 0 ? "no payment option is on the intended chain and token" : "no payment option pays the intended seller");
    return { ok: false, rejections, checks: report() };
  }
  made("recipient-chain-token");
  const payee = option.method.data.pay_to.toLowerCase() as Address;
  if (!policy.payeeAllowlist.some((allowed) => allowed.toLowerCase() === payee)) reject("payee-allowlist", "PAYEE_NOT_ALLOWED", "the payee is not on the buyer's allowlist");
  made("payee-allowlist");

  const totalUsd = effectiveTotal(contents, option.index);
  if (!sameUsd(totalUsd, intent.priceUsd)) reject("price", "PRICE_MISMATCH", `the amount due is ${totalUsd} USD, not the agreed ${intent.priceUsd} USD`);
  made("price");

  const amount = tokenAmount(totalUsd, policy.usdRate, intent.tokenDecimals);
  if (amount === undefined) {
    reject("pinned-rate", "RATE_UNSUPPORTED", "the amount due does not convert to whole token base units at the pinned rate");
    return { ok: false, rejections, checks: report() };
  }
  made("pinned-rate");
  const gross = amount + BigInt(policy.maxFeeBaseUnits);
  if (gross > BigInt(policy.perPaymentCapBaseUnits)) reject("per-payment-cap", "OVER_PER_PAYMENT_CAP", "the gross amount exceeds the per-payment cap");
  if (BigInt(policy.spentTodayBaseUnits) + gross > BigInt(policy.dailyCapBaseUnits)) reject("daily-cap", "OVER_DAILY_CAP", "the gross amount would exceed today's cap");
  made("per-payment-cap", "daily-cap");

  if (rejections.length > 0) return { ok: false, rejections, checks: report() };
  return {
    ok: true,
    checks: report(),
    cart: {
      cartMandateId: contents.id,
      paymentRequestId: contents.payment_request.details.id,
      cartSha256: hash,
      methodIndex: option.index,
      payee,
      chainId: intent.chainId,
      token: intent.token.toLowerCase() as Address,
      totalUsd,
      amountBaseUnits: amount.toString(),
      grossLimitBaseUnits: gross.toString(),
    },
  };
}

const JWT_MESSAGES: Record<JwtRejection, string> = {
  MALFORMED_JWT: "merchant_authorization is not a well-formed JWT",
  WRONG_ALGORITHM: "merchant_authorization is not ES256K",
  BAD_SIGNATURE: "merchant_authorization is not signed by the pinned merchant key",
  WRONG_AUDIENCE: "merchant_authorization has the wrong audience",
  EXPIRED: "merchant_authorization has expired",
  NOT_YET_VALID: "merchant_authorization is issued in the future",
  CART_HASH_MISMATCH: "the cart contents do not match the signed cart_hash",
};

/** USD divided by the pinned USD-per-token rate, in base units; undefined unless it divides exactly. */
function tokenAmount(usd: string, rate: string, decimals: number): bigint | undefined {
  const usdScaled = usdUnits(usd);
  const rateScaled = usdUnits(rate);
  if (usdScaled === undefined || rateScaled === undefined || rateScaled === 0n) return undefined;
  const numerator = usdScaled * 10n ** BigInt(decimals);
  return numerator % rateScaled === 0n ? numerator / rateScaled : undefined;
}

/**
 * The simulated Payment Mandate for a validated cart. Every payment field comes from the cart and
 * the intent it was checked against, never from a gateway response. The live format awaits the
 * gateway's documentation, so only the labeled simulated kind exists.
 */
export function buildSimulatedPaymentMandate(cart: ValidatedCart, payer: Address): ExecutionPayload {
  return {
    provenance: "SIMULATED",
    kind: "simulated-payment-mandate",
    cartMandateId: cart.cartMandateId,
    cartSha256: cart.cartSha256,
    paymentRequestId: cart.paymentRequestId,
    payer: payer.toLowerCase() as Address,
    payee: cart.payee,
    chainId: cart.chainId,
    token: cart.token,
    amountBaseUnits: cart.amountBaseUnits,
    nonce: createHash("sha256").update(`${cart.paymentRequestId}:${payer.toLowerCase()}`).digest("hex"),
  };
}

export type SubmissionOutcome = "SUBMITTED" | "OUTCOME_UNKNOWN";

/**
 * Submits the one signed Payment Mandate for an attempt. After a lost response it asks the gateway
 * whether the payment moved past payment-required; if it cannot tell, the outcome stays unknown.
 * It never signs again and never resubmits on its own.
 */
export async function submitPaymentMandate(rail: PaymentRail, signed: SignedPayload): Promise<SubmissionOutcome> {
  try {
    await rail.submit(signed);
    return "SUBMITTED";
  } catch (error) {
    if (!(error instanceof RailTimeoutError)) throw error;
  }
  try {
    const observation = await rail.observe(signed.payload.paymentRequestId);
    return classifyGatewayRecord(observation.record) === "AWAITING_PAYER" ? "OUTCOME_UNKNOWN" : "SUBMITTED";
  } catch {
    return "OUTCOME_UNKNOWN";
  }
}

import type { Address } from "@settleback/domain";
import type { GatewayPaymentRecord } from "../gateway.ts";
import type { TokenDomain, TransferAuthorization } from "../rail.ts";
import { nested } from "./agentic-client.ts";
import { parsePaymentRecord } from "./merchant-client.ts";
import type { PaymentCheck } from "./payment-agent.ts";
import { EIP3009_TYPES, EIP712_DOMAIN_TYPE, tokenDomain, walletTypedData } from "./payment-mandate.ts";

/** A response from HSP Agentic Payment that lacks a documented field or has one of the wrong type. */
export class HspShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HspShapeError";
  }
}

/**
 * What prepare_payment returned. `eip712` is untrusted until checked; `paymentPayload` and
 * `paymentMandateContents` are opaque and go back to finalize_payment exactly as received.
 */
export interface HspPreparedPayment {
  eip712: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: unknown; message: Record<string, unknown> };
  cartHash: string;
  tokenTotalRaw: string;
  quoteExpiresAt: string;
  payTo: string;
  payer: string;
  paymentRequestId: string;
  paymentPayload: unknown;
  paymentMandateContents: unknown;
}

export function parsePreparedPayment(raw: unknown): HspPreparedPayment {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HspShapeError("prepare_payment did not return an object");
  let root: Record<string, unknown>;
  try {
    root = nested(raw as Record<string, unknown>, "eip712");
  } catch (error) {
    throw new HspShapeError(error instanceof Error ? error.message : String(error));
  }
  const problems: string[] = [];
  const text = (key: string): string => {
    const value = root[key];
    if (typeof value === "string" && value !== "") return value;
    problems.push(`${key} is missing`);
    return "";
  };
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    problems.push(`${label} is not an object`);
    return {};
  };
  const eip712 = object(root.eip712, "eip712");
  const prepared: HspPreparedPayment = {
    eip712: { domain: object(eip712.domain, "eip712.domain"), types: object(eip712.types, "eip712.types"), primaryType: eip712.primaryType, message: object(eip712.message, "eip712.message") },
    cartHash: text("cart_hash"),
    tokenTotalRaw: uintText(root.token_total_raw) ?? (problems.push("token_total_raw is not a non-negative integer"), ""),
    quoteExpiresAt: text("quote_expires_at"),
    payTo: text("pay_to"),
    payer: text("payer"),
    paymentRequestId: text("payment_request_id"),
    paymentPayload: root.payment_payload,
    paymentMandateContents: root.payment_mandate_contents,
  };
  for (const key of ["payment_payload", "payment_mandate_contents"] as const) {
    const value = root[key];
    if (value === undefined || value === null || value === "") problems.push(`${key} is missing`);
  }
  if (problems.length > 0) throw new HspShapeError(`prepare_payment returned an incomplete payment: ${problems.join("; ")}`);
  return prepared;
}

/** The Payment Agent's checks of HSP's prepared payment, in the order it makes them. */
export const OFFER_CHECKS = [
  { id: "offer-format", label: "HSP's prepared payment has every documented field" },
  { id: "order-binding", label: "It is for the payment request recorded for this order" },
  { id: "typed-data", label: "The data to sign is exactly an EIP-3009 TransferWithAuthorization" },
  { id: "token-domain", label: "Its EIP-712 domain is the pinned domain of the intended token on the intended chain" },
  { id: "payer", label: "The authorization is from the signed-in payer" },
  { id: "recipient", label: "It pays the intended recipient" },
  { id: "amount", label: "It authorizes at least the price and at most the price plus the maximum fee" },
  { id: "validity", label: "The quote and the authorization are valid now, and the authorization ends by the cart's expiry" },
  { id: "payee-allowlist", label: "The recipient is on the payer's allowlist" },
  { id: "per-payment-cap", label: "The authorized amount fits the per-payment cap" },
  { id: "daily-cap", label: "The authorized amount fits today's cap" },
] as const;

export type OfferCheckId = (typeof OFFER_CHECKS)[number]["id"];
export type OfferCheck = PaymentCheck<OfferCheckId>;

export interface OfferExpectations {
  paymentRequestId: string;
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  /** The agreed price in token base units. */
  principalBaseUnits: string;
  /** The most the payer accepts in fees on top of the price. */
  maxFeeBaseUnits: string;
  /** The authorization must end by then: the cart's expiry. */
  notAfter: string;
  policy: { payeeAllowlist: readonly Address[]; perPaymentCapBaseUnits: string; dailyCapBaseUnits: string; spentTodayBaseUnits: string };
}

/** A prepared payment that passed every check, with the typed data the wallet signs rebuilt from the checked fields. */
export interface CheckedOffer {
  prepared: HspPreparedPayment;
  domain: TokenDomain;
  authorization: TransferAuthorization;
  quoteExpiresAt: string;
  walletTypedData: ReturnType<typeof walletTypedData>;
}

export type OfferValidation = { ok: true; offer: CheckedOffer; checks: OfferCheck[] } | { ok: false; reasons: string[]; checks: OfferCheck[] };

/** The quote must leave this long to sign and submit. */
export const QUOTE_MARGIN_MS = 30_000;
/** The authorization must stay valid at least this long after the check. */
const AUTHORIZATION_MARGIN_S = 60;

/**
 * Checks HSP's prepared payment before the payer's wallet sees it. HSP builds the EIP-712 data here,
 * so every field is compared with the order's intent and the payer's policy instead of trusted: the
 * token's pinned domain, the exact EIP-3009 type, payer, recipient, an amount between the price and
 * the price plus the maximum fee, and validity windows. The wallet signs typed data rebuilt from the
 * checked fields, which is the same EIP-712 message HSP prepared.
 */
export function checkPreparedPayment(raw: unknown, expected: OfferExpectations, now: Date): OfferValidation {
  const results = new Map<OfferCheckId, string[]>();
  const reject = (check: OfferCheckId, reason: string): void => {
    results.set(check, [...(results.get(check) ?? []), reason]);
  };
  const made = (...checks: OfferCheckId[]): void => {
    for (const check of checks) if (!results.has(check)) results.set(check, []);
  };
  const report = (): OfferCheck[] =>
    OFFER_CHECKS.map(({ id, label }) => {
      const reasons = results.get(id);
      if (reasons === undefined) return { id, label, status: "not-checked", reason: null };
      return reasons.length === 0 ? { id, label, status: "passed", reason: null } : { id, label, status: "blocked", reason: reasons.join("; ") };
    });
  const refused = (): OfferValidation => {
    const checks = report();
    return { ok: false, checks, reasons: checks.flatMap((check) => (check.status === "blocked" && check.reason !== null ? [`${check.label}: ${check.reason}`] : [])) };
  };

  let prepared: HspPreparedPayment;
  try {
    prepared = parsePreparedPayment(raw);
  } catch (error) {
    reject("offer-format", error instanceof Error ? error.message : String(error));
    return refused();
  }
  made("offer-format");
  if (prepared.paymentRequestId !== expected.paymentRequestId) reject("order-binding", "the payment request ID is not the one recorded for this order");
  made("order-binding");

  const { eip712 } = prepared;
  const shape = typedDataProblems(eip712);
  for (const problem of shape) reject("typed-data", problem);
  made("typed-data");

  const pinned = tokenDomain(expected.chainId, expected.token);
  if (pinned === undefined) reject("token-domain", `no EIP-712 domain is pinned for token ${expected.token} on chain ${expected.chainId}`);
  else for (const problem of domainProblems(eip712.domain, pinned)) reject("token-domain", problem);
  made("token-domain");
  if (shape.length > 0 || pinned === undefined) return refused();

  const message = eip712.message;
  const authorization: TransferAuthorization = {
    from: String(message.from).toLowerCase() as Address,
    to: String(message.to).toLowerCase() as Address,
    value: uintText(message.value) as string,
    validAfter: uintText(message.validAfter) as string,
    validBefore: uintText(message.validBefore) as string,
    nonce: String(message.nonce).toLowerCase(),
  };

  if (authorization.from !== expected.payer.toLowerCase()) reject("payer", "the authorization is from another address");
  if (prepared.payer.toLowerCase() !== expected.payer.toLowerCase()) reject("payer", "HSP names another payer");
  made("payer");
  if (authorization.to !== expected.payee.toLowerCase()) reject("recipient", "the authorization pays another address");
  if (prepared.payTo.toLowerCase() !== expected.payee.toLowerCase()) reject("recipient", "HSP names another recipient");
  made("recipient");

  const value = BigInt(authorization.value);
  const principal = BigInt(expected.principalBaseUnits);
  const ceiling = principal + BigInt(expected.maxFeeBaseUnits);
  if (authorization.value !== prepared.tokenTotalRaw) reject("amount", "the signed value differs from token_total_raw");
  if (value < principal) reject("amount", `it authorizes ${authorization.value}, less than the price of ${expected.principalBaseUnits}`);
  if (value > ceiling) reject("amount", `it authorizes ${authorization.value}, more than the price plus the maximum fee (${ceiling.toString()})`);
  made("amount");

  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const notAfter = Date.parse(expected.notAfter);
  const quoteEnds = Date.parse(prepared.quoteExpiresAt);
  if (!Number.isFinite(quoteEnds)) reject("validity", "quote_expires_at is not a valid time");
  else if (quoteEnds - now.getTime() < QUOTE_MARGIN_MS) reject("validity", "the quote expires too soon to sign and submit");
  if (BigInt(authorization.validAfter) > nowSeconds) reject("validity", "the authorization is not valid yet");
  if (BigInt(authorization.validBefore) < nowSeconds + BigInt(AUTHORIZATION_MARGIN_S)) reject("validity", "the authorization expires too soon");
  if (!Number.isFinite(notAfter) || BigInt(authorization.validBefore) > BigInt(Math.floor(notAfter / 1000))) reject("validity", "the authorization stays valid after the cart expires");
  made("validity");

  const { policy } = expected;
  if (!policy.payeeAllowlist.some((allowed) => allowed.toLowerCase() === authorization.to)) reject("payee-allowlist", "the recipient is not on the allowlist");
  made("payee-allowlist");
  if (value > BigInt(policy.perPaymentCapBaseUnits)) reject("per-payment-cap", "the authorized amount exceeds the per-payment cap");
  made("per-payment-cap");
  if (BigInt(policy.spentTodayBaseUnits) + value > BigInt(policy.dailyCapBaseUnits)) reject("daily-cap", "the authorized amount would exceed today's cap");
  made("daily-cap");

  const checks = report();
  if (checks.some((check) => check.status !== "passed")) return refused();
  return { ok: true, checks, offer: { prepared, domain: pinned, authorization, quoteExpiresAt: prepared.quoteExpiresAt, walletTypedData: walletTypedData({ domain: pinned, authorization }) } };
}

/** The EIP-3009 type, field for field and in order; an EIP712Domain entry, if present, must be the standard one. */
function typedDataProblems(eip712: HspPreparedPayment["eip712"]): string[] {
  const problems: string[] = [];
  if (eip712.primaryType !== "TransferWithAuthorization") problems.push(`primaryType is ${JSON.stringify(eip712.primaryType)}, not TransferWithAuthorization`);
  for (const name of Object.keys(eip712.types)) {
    if (name !== "TransferWithAuthorization" && name !== "EIP712Domain") problems.push(`types declares an unexpected type ${name}`);
  }
  if (!sameFields(eip712.types.TransferWithAuthorization, EIP3009_TYPES.TransferWithAuthorization)) problems.push("TransferWithAuthorization is not the EIP-3009 field list");
  if (eip712.types.EIP712Domain !== undefined && !sameFields(eip712.types.EIP712Domain, EIP712_DOMAIN_TYPE)) problems.push("EIP712Domain is not name, version, chainId, verifyingContract");
  const message = eip712.message;
  const keys = Object.keys(message).sort();
  const expectedKeys = EIP3009_TYPES.TransferWithAuthorization.map((field) => field.name).sort();
  if (keys.join(",") !== expectedKeys.join(",")) problems.push(`the message fields are ${keys.join(", ")}`);
  for (const key of ["from", "to"] as const) if (typeof message[key] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(message[key])) problems.push(`message.${key} is not an address`);
  for (const key of ["value", "validAfter", "validBefore"] as const) if (uintText(message[key]) === undefined) problems.push(`message.${key} is not a uint256`);
  if (typeof message.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) problems.push("message.nonce is not a bytes32");
  return problems;
}

function domainProblems(domain: Record<string, unknown>, pinned: TokenDomain): string[] {
  const problems: string[] = [];
  const keys = Object.keys(domain).sort();
  if (keys.join(",") !== "chainId,name,verifyingContract,version") problems.push(`the domain fields are ${keys.join(", ")}`);
  if (domain.name !== pinned.name) problems.push(`the domain name is ${JSON.stringify(domain.name)}, not ${JSON.stringify(pinned.name)}`);
  if (domain.version !== pinned.version) problems.push(`the domain version is ${JSON.stringify(domain.version)}, not ${JSON.stringify(pinned.version)}`);
  if (uintText(domain.chainId) !== String(pinned.chainId)) problems.push(`the domain chain is ${JSON.stringify(domain.chainId)}, not ${pinned.chainId}`);
  if (typeof domain.verifyingContract !== "string" || domain.verifyingContract.toLowerCase() !== pinned.verifyingContract.toLowerCase()) problems.push("the domain's token contract is not the intended token");
  return problems;
}

function sameFields(actual: unknown, expected: readonly { name: string; type: string }[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((field, index) => {
    const entry = actual[index] as { name?: unknown; type?: unknown } | undefined;
    return entry !== undefined && entry !== null && entry.name === field.name && entry.type === field.type && Object.keys(entry).length === 2;
  });
}

const UINT256_MAX = (1n << 256n) - 1n;

/** A uint256 given as a decimal string or a safe integer, as a decimal string; undefined otherwise. */
export function uintText(value: unknown): string | undefined {
  let parsed: bigint;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else return undefined;
  return parsed <= UINT256_MAX ? parsed.toString() : undefined;
}

export interface HspPaymentToken {
  network: string;
  chainId: number;
  address: Address;
  decimals: number;
  symbol: string;
  protocol: string;
}

/**
 * The token to pay with, from get_chain_config: the one entry with the given symbol on the given
 * chain. Every object in the response that has a chain_id and a tokens list is a network, wherever
 * it is nested. Anything ambiguous or missing is refused; nothing is chosen from memory.
 */
export function selectPaymentToken(config: unknown, want: { chainId: number; symbol: string }): HspPaymentToken {
  const networks: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const entry = value as Record<string, unknown>;
    if (entry.chain_id !== undefined && Array.isArray(entry.tokens)) networks.push(entry);
    for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(config, 0);
  const onChain = networks.filter((network) => uintText(network.chain_id) === String(want.chainId));
  if (onChain.length !== 1) throw new HspShapeError(`get_chain_config lists ${onChain.length} networks with chain ID ${want.chainId}; expected exactly one`);
  const network = onChain[0] as Record<string, unknown>;
  const tokens = (network.tokens as unknown[]).filter((token): token is Record<string, unknown> => typeof token === "object" && token !== null);
  const symbolOf = (token: Record<string, unknown>): unknown => token.symbol ?? token.coin ?? token.name;
  const matches = tokens.filter((token) => symbolOf(token) === want.symbol);
  if (matches.length !== 1) {
    throw new HspShapeError(`get_chain_config lists ${matches.length} ${want.symbol} tokens on chain ${want.chainId} (listed: ${tokens.map((token) => String(symbolOf(token))).join(", ") || "none"})`);
  }
  const token = matches[0] as Record<string, unknown>;
  const address = token.address ?? token.contract_address;
  const decimals = token.decimals;
  const protocol = token.payment_protocol;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new HspShapeError(`the ${want.symbol} token has no contract address`);
  if (typeof decimals !== "number" || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new HspShapeError(`the ${want.symbol} token has no valid decimals`);
  if (typeof protocol !== "string" || protocol === "") throw new HspShapeError(`the ${want.symbol} token has no payment_protocol`);
  const name = network.network ?? network.name;
  if (typeof name !== "string" || name === "") throw new HspShapeError(`chain ${want.chainId} has no network name`);
  return { network: name, chainId: want.chainId, address: address.toLowerCase() as Address, decimals, symbol: want.symbol, protocol };
}

export interface HspPaymentStatus {
  record: GatewayPaymentRecord;
  /** Whether HSP attributes the payment to the team name queried; null when it did not say. */
  attributionVerified: boolean | null;
}

/** query_payment's answer as a gateway payment record, which must be for the payment request asked about. */
export function paymentStatusFromQuery(raw: unknown, paymentRequestId: string): HspPaymentStatus {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HspShapeError("query_payment did not return an object");
  const root = raw as Record<string, unknown>;
  const payment = typeof root.payment === "object" && root.payment !== null && !Array.isArray(root.payment) ? (root.payment as Record<string, unknown>) : root;
  // Identifiers and status may sit beside the payment object rather than inside it.
  const merged: Record<string, unknown> = { ...payment };
  for (const key of ["status", "flow_id", "payment_request_id", "status_reason"]) if (merged[key] === undefined && root[key] !== undefined) merged[key] = root[key];
  const record = parsePaymentRecord(merged);
  if (record.payment_request_id !== paymentRequestId) throw new HspShapeError("query_payment answered for a different payment request");
  if (record.tx_signature !== null && !/^0x[0-9a-fA-F]{64}$/.test(record.tx_signature)) throw new HspShapeError("query_payment returned a transaction hash that is not 32 bytes");
  const attribution = root.attribution_verified;
  return { record, attributionVerified: typeof attribution === "boolean" ? attribution : null };
}

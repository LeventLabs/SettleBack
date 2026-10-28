import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";

// The Cart Mandate as documented by the HSP Merchant gateway. Field names keep the gateway's
// snake_case because these objects cross the wire and are hashed as received.

export const X402_METHOD = "https://www.x402.org/";

export interface UsdAmount {
  currency: "USD";
  value: string;
}

export interface LabeledAmount {
  label: string;
  amount: UsdAmount;
}

export interface X402MethodData {
  supported_methods: string;
  data: {
    x402Version: 2;
    network: string;
    chain_id: number;
    contract_address: string;
    pay_to: string;
    coin: string;
  };
}

export interface CartModifier {
  supported_methods: string;
  data?: { method_data_indexes?: number[] };
  additional_display_items: LabeledAmount[];
  total?: LabeledAmount;
}

export interface CartContents {
  id: string;
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: X402MethodData[];
    details: {
      id: string;
      display_items?: LabeledAmount[];
      total: LabeledAmount;
      modifiers?: CartModifier[];
    };
  };
  cart_expiry: string;
  merchant_name: string;
}

export interface CartMandate {
  contents: CartContents;
  merchant_authorization: string;
}

/** Network names the gateway uses for HSK Chain, from its supported chain and token table. */
export const HSK_NETWORKS: Readonly<Record<number, string>> = { 133: "hashkey-testnet", 177: "hashkey" };

/**
 * SHA-256 of the canonical JSON of `contents`, sorted keys and no whitespace. It is computed over
 * the object as received, so a field this code does not model still changes the hash. Fractional
 * numbers are refused rather than serialized, because the documented contents contain none.
 */
export function cartHash(contents: unknown): string {
  return sha256Hex(canonicalJson(contents as CanonicalValue));
}

const USD_SCALE = 18;
const DECIMAL = /^(0|[1-9][0-9]*)(\.([0-9]{1,18}))?$/;

/** A USD decimal string as an integer number of 10^-18 USD; undefined when it is not a plain decimal. */
export function usdUnits(value: string): bigint | undefined {
  const match = DECIMAL.exec(value);
  if (match === null) return undefined;
  return BigInt((match[1] ?? "0") + (match[3] ?? "").padEnd(USD_SCALE, "0"));
}

/** Compares USD decimals by value, so "10.0" equals "10.00". */
export function sameUsd(a: string, b: string): boolean {
  const left = usdUnits(a);
  return left !== undefined && left === usdUnits(b);
}

export function normalizeMethod(method: string): string {
  return method.trim().replace(/\/$/, "");
}

export class CartShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartShapeError";
  }
}

/** Reads an untrusted Cart Mandate. Throws CartShapeError when a documented field is missing or mistyped. */
export function parseCartMandate(raw: unknown): CartMandate {
  const mandate = record(raw, "cart_mandate");
  const contents = record(mandate.contents, "contents");
  const request = record(contents.payment_request, "payment_request");
  const details = record(request.details, "details");
  const methods = list(request.method_data, "method_data").map((entry, index) => {
    const method = record(entry, `method_data[${index}]`);
    const data = record(method.data, `method_data[${index}].data`);
    if (data.x402Version !== 2) throw new CartShapeError(`method_data[${index}].data.x402Version must be 2`);
    return {
      supported_methods: string(method.supported_methods, `method_data[${index}].supported_methods`),
      data: {
        x402Version: 2 as const,
        network: string(data.network, `method_data[${index}].data.network`),
        chain_id: integer(data.chain_id, `method_data[${index}].data.chain_id`),
        contract_address: string(data.contract_address, `method_data[${index}].data.contract_address`),
        pay_to: string(data.pay_to, `method_data[${index}].data.pay_to`),
        coin: string(data.coin, `method_data[${index}].data.coin`),
      },
    };
  });
  if (methods.length === 0) throw new CartShapeError("method_data must not be empty");
  const modifiers =
    details.modifiers === undefined
      ? undefined
      : list(details.modifiers, "modifiers").map((entry, index) => {
          const modifier = record(entry, `modifiers[${index}]`);
          const data = modifier.data === undefined ? undefined : record(modifier.data, `modifiers[${index}].data`);
          const indexes = data?.method_data_indexes === undefined ? undefined : list(data.method_data_indexes, `modifiers[${index}].data.method_data_indexes`);
          return {
            supported_methods: string(modifier.supported_methods, `modifiers[${index}].supported_methods`),
            ...(data === undefined ? {} : { data: indexes === undefined ? {} : { method_data_indexes: indexes.map((value, at) => integer(value, `modifiers[${index}].data.method_data_indexes[${at}]`)) } }),
            additional_display_items: list(modifier.additional_display_items, `modifiers[${index}].additional_display_items`).map((item, at) =>
              labeled(item, `modifiers[${index}].additional_display_items[${at}]`),
            ),
            ...(modifier.total === undefined ? {} : { total: labeled(modifier.total, `modifiers[${index}].total`) }),
          };
        });
  if (typeof contents.user_cart_confirmation_required !== "boolean") throw new CartShapeError("user_cart_confirmation_required must be a boolean");
  return {
    contents: {
      id: string(contents.id, "contents.id"),
      user_cart_confirmation_required: contents.user_cart_confirmation_required,
      payment_request: {
        method_data: methods,
        details: {
          id: string(details.id, "details.id"),
          ...(details.display_items === undefined ? {} : { display_items: list(details.display_items, "display_items").map((item, at) => labeled(item, `display_items[${at}]`)) }),
          total: labeled(details.total, "details.total"),
          ...(modifiers === undefined ? {} : { modifiers }),
        },
      },
      cart_expiry: string(contents.cart_expiry, "cart_expiry"),
      merchant_name: string(contents.merchant_name, "merchant_name"),
    },
    merchant_authorization: string(mandate.merchant_authorization, "merchant_authorization"),
  };
}

/**
 * The gateway's documented amount rules: line items add up to the total, a modifier total equals
 * the root total plus its additional items, and explicit method indexes are valid and unshared.
 * Returns the problems found; an empty list means the cart passes.
 */
export function cartAmountProblems(contents: CartContents): string[] {
  const problems: string[] = [];
  const { details, method_data: methods } = contents.payment_request;
  const total = amountUnits(details.total, "details.total", problems);
  if (details.display_items !== undefined && details.display_items.length > 0 && total !== undefined) {
    let sum = 0n;
    for (const [index, item] of details.display_items.entries()) sum += amountUnits(item, `display_items[${index}]`, problems) ?? 0n;
    if (sum !== total) problems.push("display_items do not add up to details.total");
  }

  const claimed = new Set<number>();
  for (const [index, modifier] of (details.modifiers ?? []).entries()) {
    const label = `modifiers[${index}]`;
    if (modifier.additional_display_items.length === 0) problems.push(`${label}.additional_display_items must not be empty`);
    let additional = 0n;
    for (const [at, item] of modifier.additional_display_items.entries()) additional += amountUnits(item, `${label}.additional_display_items[${at}]`, problems) ?? 0n;
    if (modifier.total !== undefined) {
      const modifierTotal = amountUnits(modifier.total, `${label}.total`, problems);
      if (modifierTotal !== undefined && modifierTotal <= 0n) problems.push(`${label}.total must be greater than 0`);
      if (modifierTotal !== undefined && total !== undefined && modifierTotal !== total + additional) {
        problems.push(`${label}.total must equal details.total plus its additional items`);
      }
    }
    const matched = matchedIndexes(modifier, methods, label, problems);
    for (const methodIndex of matched) {
      if (claimed.has(methodIndex)) problems.push(`method_data[${methodIndex}] is matched by more than one modifier`);
      claimed.add(methodIndex);
    }
  }
  return problems;
}

/** The amount due for one payment option: its modifier's total when it has one, otherwise the root total. */
export function effectiveTotal(contents: CartContents, methodIndex: number): string {
  const { details, method_data: methods } = contents.payment_request;
  for (const modifier of details.modifiers ?? []) {
    if (matchedIndexes(modifier, methods, "modifier", []).includes(methodIndex)) return modifier.total?.amount.value ?? details.total.amount.value;
  }
  return details.total.amount.value;
}

function matchedIndexes(modifier: CartModifier, methods: readonly X402MethodData[], label: string, problems: string[]): number[] {
  const method = normalizeMethod(modifier.supported_methods);
  const explicit = modifier.data?.method_data_indexes;
  if (explicit === undefined) {
    const matched = methods.flatMap((entry, index) => (normalizeMethod(entry.supported_methods) === method ? [index] : []));
    if (matched.length === 0) problems.push(`${label} matches no method_data entry`);
    return matched;
  }
  if (explicit.length === 0) problems.push(`${label}.data.method_data_indexes must not be empty`);
  if (new Set(explicit).size !== explicit.length) problems.push(`${label}.data.method_data_indexes repeats an index`);
  for (const index of explicit) {
    const entry = methods[index];
    if (index < 0 || entry === undefined) problems.push(`${label}.data.method_data_indexes has out-of-range index ${index}`);
    else if (normalizeMethod(entry.supported_methods) !== method) problems.push(`${label} names method_data[${index}] with a different method`);
  }
  return [...new Set(explicit)].filter((index) => methods[index] !== undefined);
}

function amountUnits(item: LabeledAmount, label: string, problems: string[]): bigint | undefined {
  if (item.amount.currency !== "USD") {
    problems.push(`${label} must be in USD`);
    return undefined;
  }
  const units = usdUnits(item.amount.value);
  if (units === undefined) problems.push(`${label} is not a plain decimal`);
  return units;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CartShapeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new CartShapeError(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new CartShapeError(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CartShapeError(`${label} must be an integer`);
  return value;
}

function labeled(value: unknown, label: string): LabeledAmount {
  const item = record(value, label);
  const amount = record(item.amount, `${label}.amount`);
  if (amount.currency !== "USD") throw new CartShapeError(`${label}.amount.currency must be USD`);
  return { label: string(item.label, `${label}.label`), amount: { currency: "USD", value: string(amount.value, `${label}.amount.value`) } };
}

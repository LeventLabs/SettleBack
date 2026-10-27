export type Address = `0x${string}`;

/** The immutable business intent persisted before any payment is prepared. */
export interface OperationIntent {
  buyer: Address;
  seller: Address;
  serviceId: string;
  requestSha256: string;
  policyId: string;
  policySha256: string;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  /** Price in USD with exactly two decimals, as the gateway's Cart Mandate expresses it. */
  priceUsd: string;
  /** Expected token amount in base units under the pinned stablecoin rate. */
  amountBaseUnits: string;
}

export class InvalidOperationIntentError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid operation intent: ${field} ${message}`);
    this.name = "InvalidOperationIntentError";
    this.field = field;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const POSITIVE_BASE_UNITS = /^[1-9][0-9]*$/;
const USD = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;

/** Validates untrusted input and returns a normalized intent with lowercase addresses. */
export function validateOperationIntent(input: unknown): OperationIntent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidOperationIntentError("intent", "must be an object");
  }
  const o = input as Record<string, unknown>;

  const allowed = new Set([
    "buyer",
    "seller",
    "serviceId",
    "requestSha256",
    "policyId",
    "policySha256",
    "chainId",
    "token",
    "tokenDecimals",
    "priceUsd",
    "amountBaseUnits",
  ]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new InvalidOperationIntentError(key, "is not a recognized field");
  }

  const intent: OperationIntent = {
    buyer: address(o, "buyer"),
    seller: address(o, "seller"),
    serviceId: matching(o, "serviceId", SLUG, "must be a lowercase slug"),
    requestSha256: matching(o, "requestSha256", SHA256_HEX, "must be a lowercase SHA-256 hex digest"),
    policyId: matching(o, "policyId", SLUG, "must be a lowercase slug"),
    policySha256: matching(o, "policySha256", SHA256_HEX, "must be a lowercase SHA-256 hex digest"),
    chainId: integer(o, "chainId", 1, Number.MAX_SAFE_INTEGER),
    token: address(o, "token"),
    tokenDecimals: integer(o, "tokenDecimals", 0, 36),
    priceUsd: matching(o, "priceUsd", USD, "must be a USD amount with exactly two decimals"),
    amountBaseUnits: matching(o, "amountBaseUnits", POSITIVE_BASE_UNITS, "must be a positive integer string"),
  };

  if (intent.priceUsd === "0.00") throw new InvalidOperationIntentError("priceUsd", "must be greater than zero");
  if (intent.buyer === intent.seller) throw new InvalidOperationIntentError("seller", "must differ from buyer");
  return intent;
}

function address(o: Record<string, unknown>, key: string): Address {
  const value = o[key];
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new InvalidOperationIntentError(key, "must be a 0x-prefixed 20-byte hex address");
  }
  return value.toLowerCase() as Address;
}

function matching(o: Record<string, unknown>, key: string, pattern: RegExp, message: string): string {
  const value = o[key];
  if (typeof value !== "string" || !pattern.test(value)) throw new InvalidOperationIntentError(key, message);
  return value;
}

function integer(o: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidOperationIntentError(key, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

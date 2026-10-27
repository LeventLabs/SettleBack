import { createHash } from "node:crypto";

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Sorted-key, whitespace-free JSON. Only safe integers are accepted as numbers so the output
 * cannot depend on floating-point formatting; encode amounts and decimals as strings.
 */
export function canonicalJson(value: CanonicalValue): string {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalize(value: CanonicalValue): CanonicalValue {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        throw new Error(`canonicalJson: property "${key}" is undefined`);
      }
      sorted[key] = normalize(entry);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`canonicalJson: ${value} is not a safe integer; encode it as a string`);
  }
  return value;
}

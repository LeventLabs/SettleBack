import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@settleback/domain/hash";

// Merchant API request signing as documented:
//   message   = METHOD \n PATH \n QUERY \n bodyHash \n timestamp \n nonce
//   signature = hex(HMAC-SHA256(app_secret, message))
// bodyHash is the SHA-256 of the canonical JSON body, or "" without a body. Requests carry the
// canonical JSON as their exact body bytes, so the hash is the same whichever way it is read.

export const REQUEST_SKEW_SECONDS = 300;

export interface MerchantRequestParts {
  method: "GET" | "POST";
  path: string;
  /** Query string without "?", or "". */
  query: string;
  /** The exact body bytes sent, or undefined for a request without a body. */
  body: string | undefined;
  timestampSeconds: number;
  nonce: string;
}

export interface MerchantRequestHeaders {
  "X-App-Key": string;
  "X-Signature": string;
  "X-Timestamp": string;
  "X-Nonce": string;
}

export function signingMessage(parts: MerchantRequestParts): string {
  const bodyHash = parts.body === undefined ? "" : sha256Hex(parts.body);
  return [parts.method, parts.path, parts.query, bodyHash, String(parts.timestampSeconds), parts.nonce].join("\n");
}

export function signMerchantRequest(parts: MerchantRequestParts, appKey: string, appSecret: string): MerchantRequestHeaders {
  return {
    "X-App-Key": appKey,
    "X-Signature": createHmac("sha256", appSecret).update(signingMessage(parts)).digest("hex"),
    "X-Timestamp": String(parts.timestampSeconds),
    "X-Nonce": parts.nonce,
  };
}

export type RequestVerification = { ok: true } | { ok: false; reason: "MISSING_HEADERS" | "MALFORMED_HEADERS" | "STALE_TIMESTAMP" | "REPLAYED_NONCE" | "BAD_SIGNATURE" };

/**
 * The gateway side of the check, used by the simulator. `seenNonce` records a nonce and reports
 * whether it was already used for this app key inside the skew window.
 */
export function verifyMerchantRequest(
  request: Omit<MerchantRequestParts, "timestampSeconds" | "nonce">,
  headers: Partial<Record<keyof MerchantRequestHeaders, string>>,
  appSecret: string,
  nowSeconds: number,
  seenNonce: (nonce: string) => boolean,
): RequestVerification {
  const signature = headers["X-Signature"];
  const timestamp = headers["X-Timestamp"];
  const nonce = headers["X-Nonce"];
  if (signature === undefined || timestamp === undefined || nonce === undefined || headers["X-App-Key"] === undefined) return { ok: false, reason: "MISSING_HEADERS" };
  if (!/^[0-9]{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature) || !/^([0-9a-fA-F-]{36}|[0-9a-f]{12,32})$/.test(nonce)) {
    return { ok: false, reason: "MALFORMED_HEADERS" };
  }
  const timestampSeconds = Number(timestamp);
  if (Math.abs(nowSeconds - timestampSeconds) > REQUEST_SKEW_SECONDS) return { ok: false, reason: "STALE_TIMESTAMP" };
  const expected = Buffer.from(createHmac("sha256", appSecret).update(signingMessage({ ...request, timestampSeconds, nonce })).digest("hex"), "hex");
  const received = Buffer.from(signature, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { ok: false, reason: "BAD_SIGNATURE" };
  if (seenNonce(nonce)) return { ok: false, reason: "REPLAYED_NONCE" };
  return { ok: true };
}

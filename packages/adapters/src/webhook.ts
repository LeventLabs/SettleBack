import { createHmac, timingSafeEqual } from "node:crypto";

// Gateway webhook signature as documented: header "X-Signature: t=<unix seconds>,v1=<hex>",
// where v1 = hex(HMAC-SHA256(app_secret, `${t}.${raw_request_body}`)).

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerification =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "MISSING_HEADER" | "MALFORMED_HEADER" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" };

export function signWebhook(secret: string, timestampSeconds: number, rawBody: string | Uint8Array): string {
  return `t=${timestampSeconds},v1=${hmacHex(secret, timestampSeconds, rawBody)}`;
}

/** Verifies over the exact raw body bytes; never over re-serialized JSON. */
export function verifyWebhook(
  header: string | undefined,
  rawBody: string | Uint8Array,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): WebhookVerification {
  if (header === undefined || header.trim() === "") return { ok: false, reason: "MISSING_HEADER" };

  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const [key, value, ...rest] = part.trim().split("=");
    if (rest.length > 0 || value === undefined) return { ok: false, reason: "MALFORMED_HEADER" };
    if (key === "t") {
      if (!/^[0-9]{1,12}$/.test(value)) return { ok: false, reason: "MALFORMED_HEADER" };
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return { ok: false, reason: "MALFORMED_HEADER" };
      signature = value;
    }
  }
  if (timestamp === undefined || signature === undefined) return { ok: false, reason: "MALFORMED_HEADER" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "STALE_TIMESTAMP" };

  const expected = Buffer.from(hmacHex(secret, timestamp, rawBody), "hex");
  const received = Buffer.from(signature, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  return { ok: true, timestamp };
}

function hmacHex(secret: string, timestampSeconds: number, rawBody: string | Uint8Array): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
}

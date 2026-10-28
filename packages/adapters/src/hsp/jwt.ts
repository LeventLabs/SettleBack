import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

// The merchant authorization JWT as documented: ES256K (ECDSA on secp256k1 with SHA-256), header
// {"alg":"ES256K","typ":"JWT"}, and claims iss, sub, aud = "HashkeyMerchant", iat, exp, jti, cart_hash.
// The signature is the 64-byte r||s form JWS uses.

export const MERCHANT_AUDIENCE = "HashkeyMerchant";
const HEADER = { alg: "ES256K", typ: "JWT" } as const;
const CLOCK_SKEW_SECONDS = 60;

export interface MerchantClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  cart_hash: string;
}

export type JwtRejection = "MALFORMED_JWT" | "WRONG_ALGORITHM" | "BAD_SIGNATURE" | "WRONG_AUDIENCE" | "EXPIRED" | "NOT_YET_VALID" | "CART_HASH_MISMATCH";

export type JwtVerification = { ok: true; claims: MerchantClaims } | { ok: false; reason: JwtRejection };

/** Loads a secp256k1 key from PEM (PKCS8, SEC1, or SPKI) and refuses any other curve. */
export function secp256k1Key(pem: string, kind: "private" | "public"): KeyObject {
  const key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "secp256k1") {
    throw new Error("merchant keys must be secp256k1");
  }
  return key;
}

export function signMerchantJwt(claims: MerchantClaims, privateKey: KeyObject): string {
  const signingInput = `${base64url(JSON.stringify(HEADER))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Verifies the JWT against a pinned public key, the expected cart hash, and the current time. */
export function verifyMerchantJwt(token: string, publicKey: KeyObject, expectedCartHash: string, nowSeconds: number): JwtVerification {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED_JWT" };
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const claims = decodeJson(claimsPart);
  if (header === undefined || claims === undefined || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) return { ok: false, reason: "MALFORMED_JWT" };
  if (header.alg !== "ES256K") return { ok: false, reason: "WRONG_ALGORITHM" };

  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64) return { ok: false, reason: "BAD_SIGNATURE" };
  const valid = verify("sha256", Buffer.from(`${headerPart}.${claimsPart}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  if (!valid) return { ok: false, reason: "BAD_SIGNATURE" };

  const parsed = readClaims(claims);
  if (parsed === undefined) return { ok: false, reason: "MALFORMED_JWT" };
  if (parsed.aud !== MERCHANT_AUDIENCE) return { ok: false, reason: "WRONG_AUDIENCE" };
  if (parsed.exp <= nowSeconds) return { ok: false, reason: "EXPIRED" };
  if (parsed.iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: "NOT_YET_VALID" };
  if (parsed.cart_hash !== expectedCartHash) return { ok: false, reason: "CART_HASH_MISMATCH" };
  return { ok: true, claims: parsed };
}

function readClaims(value: Record<string, unknown>): MerchantClaims | undefined {
  const { iss, sub, aud, iat, exp, jti, cart_hash: hash } = value;
  if (typeof iss !== "string" || typeof sub !== "string" || typeof aud !== "string" || typeof jti !== "string") return undefined;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  return { iss, sub, aud, iat: iat as number, exp: exp as number, jti, cart_hash: hash };
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

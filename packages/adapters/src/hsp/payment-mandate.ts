import { createHash } from "node:crypto";
import { verifyTypedData, type Hex } from "viem";
import type { Address } from "@settleback/domain";
import type { Provenance } from "../provenance.ts";
import type { Ap2MandatePayload, TokenDomain, TransferAuthorization } from "../rail.ts";

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * EIP-712 domains of the stablecoins a Payment Agent may authorize, keyed by chain and token. The
 * names and versions are the official merchant SDK's; the HashKey testnet USDC values were also
 * read back from the token contract, and a test pins its domain separator.
 */
const TOKEN_DOMAINS: Readonly<Record<string, { name: string; version: string }>> = {
  "133:0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6": { name: "USD Coin", version: "2" },
  "177:0x054ed45810dbbab8b27668922d110669c9d88d0a": { name: "Bridged USDC", version: "2" },
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { name: "USD Coin", version: "2" },
  "11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { name: "USD Coin", version: "2" },
};

const NETWORK_NAMES: Readonly<Record<number, string>> = { 1: "ethereum", 133: "hashkey-testnet", 177: "hashkey", 11155111: "sepolia" };

export function tokenDomain(chainId: number, token: string): TokenDomain | undefined {
  const pinned = TOKEN_DOMAINS[`${chainId}:${token.toLowerCase()}`];
  return pinned === undefined ? undefined : { ...pinned, chainId, verifyingContract: token.toLowerCase() as Address };
}

export interface MandateTerms {
  provenance: Provenance;
  cartMandateId: string;
  paymentRequestId: string;
  cartSha256: string;
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
  /** The cart's USD total, for the mandate's display total. */
  totalUsd: string;
  /** The authorization is valid until the cart expires and not after. */
  cartExpiry: string;
  merchantName: string;
  /** Fixed per attempt, so the mandate can be rebuilt byte for byte. */
  issuedAt: string;
}

/**
 * The AP2 Payment Mandate for one cart, with the payer's EIP-3009 authorization of exactly that
 * transfer: the cart's payee, token, chain, and amount, valid until the cart expires. The nonce is
 * derived from the order and the payer, so the same attempt always yields the same authorization
 * and the token contract can execute it at most once, however often it is signed or submitted.
 */
export function buildEip3009PaymentMandate(terms: MandateTerms): Ap2MandatePayload {
  const domain = tokenDomain(terms.chainId, terms.token);
  if (domain === undefined) throw new Error(`No pinned EIP-712 domain for token ${terms.token} on chain ${terms.chainId}; it cannot be authorized.`);
  const validBefore = Math.floor(Date.parse(terms.cartExpiry) / 1000);
  if (!Number.isSafeInteger(validBefore)) throw new Error(`Invalid cart expiry "${terms.cartExpiry}".`);
  const payer = terms.payer.toLowerCase() as Address;
  const nonce = `0x${createHash("sha256").update(`settleback.eip3009.v1:${terms.chainId}:${terms.token.toLowerCase()}:${terms.paymentRequestId}:${payer}`).digest("hex")}`;
  const authorization: TransferAuthorization = {
    from: payer,
    to: terms.payee.toLowerCase() as Address,
    value: terms.amountBaseUnits,
    validAfter: "0",
    validBefore: String(validBefore),
    nonce,
  };
  return {
    provenance: terms.provenance,
    kind: "ap2-eip3009",
    cartMandateId: terms.cartMandateId,
    cartSha256: terms.cartSha256,
    paymentRequestId: terms.paymentRequestId,
    payer,
    payee: authorization.to,
    chainId: terms.chainId,
    token: domain.verifyingContract,
    amountBaseUnits: terms.amountBaseUnits,
    nonce,
    authorization,
    domain,
    mandate: {
      payment_mandate_contents: {
        payment_mandate_id: terms.paymentRequestId,
        payment_details_id: terms.cartMandateId,
        payment_details_total: { label: "Total", amount: { currency: "USD", value: terms.totalUsd } },
        payment_response: {
          request_id: terms.paymentRequestId,
          method_name: "https://www.x402.org/",
          details: { x402Version: 2, scheme: "exact", network: NETWORK_NAMES[terms.chainId] ?? `eip155:${terms.chainId}`, chain_id: terms.chainId, protocol: "eip3009", authorization },
        },
        merchant_agent: terms.merchantName,
        timestamp: terms.issuedAt,
      },
    },
  };
}

export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The typed data a wallet signs (eth_signTypedData_v4): the authorization under the token's domain, integers as decimal strings. */
export function walletTypedData(payload: Pick<Ap2MandatePayload, "authorization" | "domain">) {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...EIP3009_TYPES },
    primaryType: "TransferWithAuthorization" as const,
    domain: payload.domain,
    message: payload.authorization,
  };
}

/** The same typed data in the form viem signs and verifies. */
export function eip3009TypedData(payload: Pick<Ap2MandatePayload, "authorization" | "domain">) {
  const { authorization: auth, domain } = payload;
  return {
    domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract as Hex },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: auth.from as Hex,
      to: auth.to as Hex,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Hex,
    },
  };
}

/** Whether the signature is the payer's EIP-712 signature of exactly this authorization. EOA signatures only. */
export async function verifyEip3009Signature(payload: Pick<Ap2MandatePayload, "authorization" | "domain">, signature: string): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyTypedData({ ...eip3009TypedData(payload), address: payload.authorization.from as Hex, signature: signature as Hex });
  } catch {
    return false;
  }
}

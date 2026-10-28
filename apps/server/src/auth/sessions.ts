import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { Environment } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { StoreError } from "../db/errors.ts";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Every write states the connected wallet as a CAIP-10 account: eip155:<chainId>:<address>. */
export const WALLET_HEADER = "x-settleback-wallet";

const CHALLENGE_SCHEMA = 1;
const NONCE_CONTEXT = "settleback.sign-in.v1\n";
const MAX_CHALLENGE_LENGTH = 1024;
const WALLET_ACCOUNT = /^eip155:([1-9][0-9]{0,9}):(0x[0-9a-fA-F]{40})$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export type SessionRole = "operator";
export type RevokeReason = "LOGOUT" | "REPLACED" | "WALLET_CHANGED" | "ROLE_REMOVED";

export type AuthFailure =
  | "AUTH_REQUIRED"
  | "CROSS_ORIGIN_FORBIDDEN"
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_USED"
  | "SIGNATURE_INVALID"
  | "CHAIN_NOT_ALLOWED"
  | "WALLET_REQUIRED"
  | "WALLET_CHANGED";

export class AuthError extends StoreError {
  constructor(code: AuthFailure, message: string) {
    super(code, message);
  }
}

export interface SignInSettings {
  environment: Environment;
  /** The browser origin users sign in from; the message's scheme, domain, and URI come from it. */
  webOrigin: string;
  /** The chains a connected wallet may be on in this environment. */
  chains: readonly number[];
  /** Lowercase addresses configured as operators. */
  operators: readonly string[];
  /** Named in the message so the wallet prompt shows which network profile the user signs in to. */
  networkLabel: string;
}

export interface Session {
  tokenSha256: string;
  address: string;
  chainId: number;
  roles: readonly SessionRole[];
  createdAt: string;
  expiresAt: string;
}

export interface SignInChallenge {
  /** Returned unchanged to verify; it carries the signed fields under the server's MAC. */
  challenge: string;
  /** The EIP-4361 text the wallet signs. */
  message: string;
  expiresAt: string;
}

interface ChallengePayload {
  v: typeof CHALLENGE_SCHEMA;
  /** Makes every challenge, and so every nonce, unique even for the same account and instant. */
  salt: string;
  environment: Environment;
  address: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Wallet sign-in (EIP-4361) and the sessions it opens. Challenges are not stored: the server MACs
 * the challenge fields and uses the MAC as the nonce, so unauthenticated requests write nothing.
 * The signed message is rebuilt from those fields, never taken from the client. A session is stored
 * under its nonce, which is unique, so a signed challenge opens at most one session. Only EOA
 * signatures are accepted; contract wallets cannot sign in.
 */
export class SessionAuthority {
  readonly #db: DatabaseSync;
  readonly #settings: SignInSettings;
  readonly #clock: () => Date;
  readonly #key: Buffer;

  constructor(db: DatabaseSync, settings: SignInSettings, clock: () => Date, key: Buffer = randomBytes(32)) {
    if (key.length < 32) throw new Error("The sign-in key must be at least 32 bytes.");
    this.#db = db;
    this.#settings = settings;
    this.#clock = clock;
    this.#key = key;
    // Fails at startup, not at the first sign-in, if the web origin cannot be an EIP-4361 domain.
    this.issue({ address: `0x${"0".repeat(40)}`, chainId: settings.chains[0] ?? 0 });
  }

  issue(input: { address: string; chainId: number }): SignInChallenge {
    this.#requireChain(input.chainId);
    const now = this.#clock();
    const payload: ChallengePayload = {
      v: CHALLENGE_SCHEMA,
      salt: randomBytes(16).toString("base64url"),
      environment: this.#settings.environment,
      address: input.address.toLowerCase(),
      chainId: input.chainId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const nonce = this.#nonce(encoded);
    return { challenge: `${encoded}.${nonce}`, message: this.#message(payload, nonce), expiresAt: payload.expiresAt };
  }

  /** Opens a session for a valid signature over an unused, unexpired challenge, ending the session it replaces. */
  async verify(input: { challenge: string; signature: string; replacing: string | undefined }): Promise<{ token: string; session: Session }> {
    const { payload, nonce } = this.#open(input.challenge);
    const now = this.#clock();
    if (now.getTime() >= Date.parse(payload.expiresAt)) throw new AuthError("CHALLENGE_EXPIRED", "The sign-in challenge has expired; request a new one.");
    this.#requireChain(payload.chainId);
    if (!(await signedBy(payload.address, this.#message(payload, nonce), input.signature))) {
      throw new AuthError("SIGNATURE_INVALID", "The signature is not this address's signature of the challenge.");
    }

    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      tokenSha256: sha256Hex(token),
      address: payload.address,
      chainId: payload.chainId,
      roles: this.#settings.operators.includes(payload.address) ? ["operator"] : [],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    immediateTransaction(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM sessions WHERE nonce = ?").get(nonce) !== undefined) {
        throw new AuthError("CHALLENGE_USED", "This sign-in challenge was already used; request a new one.");
      }
      this.#db
        .prepare(
          `INSERT INTO sessions (token_sha256, nonce, environment, address, chain_id, roles, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(session.tokenSha256, nonce, this.#settings.environment, session.address, session.chainId, session.roles.join(","), session.createdAt, session.expiresAt);
      if (input.replacing !== undefined) this.#revokeIn(sha256Hex(input.replacing), "REPLACED", session.createdAt);
    });
    return { token, session };
  }

  /** The live session for a token. A session whose operator role was removed from the configuration is revoked. */
  read(token: string): Session {
    const tokenSha256 = sha256Hex(token);
    const row = readTransaction(this.#db, () => this.#db.prepare("SELECT * FROM sessions WHERE token_sha256 = ?").get(tokenSha256));
    const signIn = new AuthError("AUTH_REQUIRED", "Sign in to continue.");
    if (row === undefined || row.revoked_at !== null || row.environment !== this.#settings.environment) throw signIn;
    if (this.#clock().getTime() >= Date.parse(String(row.expires_at))) throw signIn;
    const session: Session = {
      tokenSha256,
      address: String(row.address),
      chainId: Number(row.chain_id),
      roles: row.roles === "operator" ? ["operator"] : [],
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
    if (!this.#settings.chains.includes(session.chainId)) throw signIn;
    if (session.roles.includes("operator") && !this.#settings.operators.includes(session.address)) {
      this.revoke(token, "ROLE_REMOVED");
      throw new AuthError("AUTH_REQUIRED", "This session's roles changed; sign in again.");
    }
    return session;
  }

  /**
   * Checks the wallet a browser says it is connected to. A different account, or a network this
   * environment does not use, ends the session: what the user approved in it no longer matches the wallet.
   */
  checkWallet(session: Session, declared: string | undefined): void {
    const match = declared === undefined ? null : WALLET_ACCOUNT.exec(declared);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new AuthError("WALLET_REQUIRED", `State the connected wallet in ${WALLET_HEADER} as eip155:<chainId>:<address>.`);
    }
    if (match[2].toLowerCase() !== session.address || !this.#settings.chains.includes(Number(match[1]))) {
      immediateTransaction(this.#db, () => this.#revokeIn(session.tokenSha256, "WALLET_CHANGED", this.#clock().toISOString()));
      throw new AuthError("WALLET_CHANGED", "The wallet's account or network changed; sign in again.");
    }
  }

  /** Ends the token's session if it is live; an unknown or ended token is left as it is. */
  revoke(token: string, reason: RevokeReason): void {
    immediateTransaction(this.#db, () => this.#revokeIn(sha256Hex(token), reason, this.#clock().toISOString()));
  }

  #revokeIn(tokenSha256: string, reason: RevokeReason, now: string): void {
    this.#db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE token_sha256 = ? AND revoked_at IS NULL").run(now, reason, tokenSha256);
  }

  #requireChain(chainId: number): void {
    if (!this.#settings.chains.includes(chainId)) {
      throw new AuthError("CHAIN_NOT_ALLOWED", `Connect the wallet to chain ${this.#settings.chains.join(" or ")} to sign in; chain ${chainId} is not used here.`);
    }
  }

  /** Recovers the fields this server issued, or refuses: a challenge is authentic only if its MAC verifies. */
  #open(challenge: string): { payload: ChallengePayload; nonce: string } {
    const invalid = new AuthError("CHALLENGE_INVALID", "The sign-in challenge was not issued by this server.");
    if (challenge.length > MAX_CHALLENGE_LENGTH) throw invalid;
    const parts = challenge.split(".");
    const [encoded, nonce] = parts;
    if (parts.length !== 2 || encoded === undefined || nonce === undefined) throw invalid;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[0-9a-f]{64}$/.test(nonce)) throw invalid;
    if (!timingSafeEqual(Buffer.from(nonce, "hex"), Buffer.from(this.#nonce(encoded), "hex"))) throw invalid;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ChallengePayload;
    if (payload.v !== CHALLENGE_SCHEMA || payload.environment !== this.#settings.environment) throw invalid;
    return { payload, nonce };
  }

  #nonce(encoded: string): string {
    return createHmac("sha256", this.#key).update(NONCE_CONTEXT + encoded).digest("hex");
  }

  #message(payload: ChallengePayload, nonce: string): string {
    const origin = new URL(this.#settings.webOrigin);
    return createSiweMessage({
      scheme: origin.protocol.slice(0, -1),
      domain: origin.host,
      address: getAddress(payload.address),
      statement: `Sign in to SettleBack (${this.#settings.networkLabel}). This proves you control this address and authorizes no payment or transaction.`,
      uri: origin.origin,
      version: "1",
      chainId: payload.chainId,
      nonce,
      issuedAt: new Date(payload.issuedAt),
      expirationTime: new Date(payload.expiresAt),
    });
  }
}

async function signedBy(address: string, message: string, signature: string): Promise<boolean> {
  if (!SIGNATURE.test(signature)) return false;
  try {
    return await verifyMessage({ address: address as Hex, message, signature: signature as Hex });
  } catch {
    return false;
  }
}

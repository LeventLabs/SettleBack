import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthError, SESSION_TTL_MS, WALLET_HEADER, type Session, type SessionAuthority } from "../auth/sessions.ts";

const SAFE_METHODS: readonly string[] = ["GET", "HEAD"];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The HTTP side of sign-in: the session cookie, the origin check on writes, and the session a
 * route requires. Roles always come from the session and the operation, never from the request.
 */
export class RequestGuard {
  readonly #authority: SessionAuthority;
  readonly #webOrigin: string;
  readonly #secure: boolean;
  readonly #cookieName: string;

  constructor(authority: SessionAuthority, webOrigin: string) {
    this.#authority = authority;
    this.#webOrigin = webOrigin;
    this.#secure = new URL(webOrigin).protocol === "https:";
    // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only, and for
    // the whole site, so a sibling subdomain cannot set or shadow it. Plain http is local only.
    this.#cookieName = this.#secure ? "__Host-settleback_session" : "settleback_session";
  }

  /**
   * Browsers send Origin on every cross-origin request and on same-origin writes. A write without
   * the web origin is refused before its body is read, whatever cookies it carries.
   */
  checkOrigin(request: FastifyRequest): void {
    if (SAFE_METHODS.includes(request.method)) return;
    if (request.headers.origin !== this.#webOrigin) {
      throw new AuthError("CROSS_ORIGIN_FORBIDDEN", "Writes are accepted only from the SettleBack web origin.");
    }
  }

  /** The session token from the cookie; a missing, malformed, or repeated cookie gives none. */
  token(request: FastifyRequest): string | undefined {
    const header = request.headers.cookie;
    if (header === undefined) return undefined;
    const values: string[] = [];
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      if (part.slice(0, separator).trim() === this.#cookieName) values.push(part.slice(separator + 1).trim());
    }
    const [value] = values;
    return values.length === 1 && value !== undefined && TOKEN.test(value) ? value : undefined;
  }

  /**
   * The caller's live session. A route that changes state also needs the wallet the browser is
   * connected to, and a changed account or network ends the session.
   */
  session(request: FastifyRequest, options: { wallet: boolean }): Session {
    const token = this.token(request);
    if (token === undefined) throw new AuthError("AUTH_REQUIRED", "Sign in to continue.");
    const session = this.#authority.read(token);
    if (options.wallet) {
      const declared = request.headers[WALLET_HEADER];
      this.#authority.checkWallet(session, typeof declared === "string" ? declared : undefined);
    }
    return session;
  }

  setSession(reply: FastifyReply, token: string): void {
    reply.header("set-cookie", this.#cookie(token, Math.floor(SESSION_TTL_MS / 1000)));
  }

  clearSession(reply: FastifyReply): void {
    reply.header("set-cookie", this.#cookie("", 0));
  }

  #cookie(value: string, maxAgeSeconds: number): string {
    return `${this.#cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
  }
}

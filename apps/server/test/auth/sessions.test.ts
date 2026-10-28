import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { sha256Hex } from "@settleback/domain/hash";
import { buildApp } from "../../src/app.ts";
import { AuthError, SessionAuthority, type Session } from "../../src/auth/sessions.ts";
import { loadConfig } from "../../src/config.ts";
import { openDatabase } from "../../src/db/database.ts";

const ORIGIN = "http://localhost:5173";
const KEY = Buffer.alloc(32, 7);
const START = new Date("2026-10-30T10:00:00.000Z");
const alice = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const mallory = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const LOCAL_REGISTRY = {
  SETTLEBACK_REGISTRY_RPC_URL: "http://127.0.0.1:8545",
  SETTLEBACK_REGISTRY_CHAIN_ID: "31337",
  SETTLEBACK_REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

let now = START;
const opened: FastifyInstance[] = [];

afterEach(async () => {
  now = START;
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

function database(environment: "local" | "testnet" = "local"): DatabaseSync {
  return openDatabase({ path: ":memory:", environment });
}

function server(env: Record<string, string> = {}, options: { db?: DatabaseSync; key?: Buffer } = {}): { app: FastifyInstance; db: DatabaseSync } {
  const db = options.db ?? database();
  const app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent", ...env }), { db, clock: () => now, signInKey: options.key ?? KEY });
  opened.push(app);
  return { app, db };
}

function post(app: FastifyInstance, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url, headers: { origin: ORIGIN, ...headers }, ...(body === undefined ? {} : { payload: body as object }) });
}

async function challenge(app: FastifyInstance, address: string, chainId = 133, headers: Record<string, string> = {}): Promise<{ challenge: string; message: string; expiresAt: string }> {
  const response = await post(app, "/api/auth/challenge", { address, chainId }, headers);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function signed(app: FastifyInstance, account: PrivateKeyAccount, chainId = 133): Promise<{ challenge: string; signature: string; message: string }> {
  const issued = await challenge(app, account.address, chainId);
  return { challenge: issued.challenge, message: issued.message, signature: await account.signMessage({ message: issued.message }) };
}

function cookieOf(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  expect(typeof header).toBe("string");
  return String(header).split(";")[0] ?? "";
}

async function signIn(app: FastifyInstance, account: PrivateKeyAccount, headers: Record<string, string> = {}): Promise<{ cookie: string; response: LightMyRequestResponse }> {
  const { challenge: token, signature } = await signed(app, account);
  const response = await post(app, "/api/auth/verify", { challenge: token, signature }, headers);
  expect(response.statusCode, response.body).toBe(200);
  return { cookie: cookieOf(response), response };
}

function sessionOf(app: FastifyInstance, cookie: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json().error.code;
}

function reencode(token: string, change: (payload: Record<string, unknown>) => void): string {
  const [encoded, nonce] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  change(payload);
  return `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${nonce}`;
}

function sessionRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM sessions ORDER BY created_at, token_sha256").all() as Record<string, unknown>[];
}

describe("wallet sign-in", () => {
  it("issues an EIP-4361 message bound to the web origin, the network, and a five-minute expiry", async () => {
    const { app } = server();
    const issued = await challenge(app, alice.address.toLowerCase());
    const nonce = issued.challenge.split(".")[1];
    expect(issued.message).toBe(
      [
        "http://localhost:5173 wants you to sign in with your Ethereum account:",
        alice.address,
        "",
        "Sign in to SettleBack (local simulation (testnet)). This proves you control this address and authorizes no payment or transaction.",
        "",
        "URI: http://localhost:5173",
        "Version: 1",
        "Chain ID: 133",
        `Nonce: ${nonce}`,
        "Issued At: 2026-10-30T10:00:00.000Z",
        "Expiration Time: 2026-10-30T10:05:00.000Z",
      ].join("\n"),
    );
    expect(issued.expiresAt).toBe("2026-10-30T10:05:00.000Z");
    const parsed = parseSiweMessage(issued.message);
    expect(validateSiweMessage({ message: parsed, domain: "localhost:5173", address: alice.address, nonce: nonce ?? "", time: now })).toBe(true);
  });

  it("opens a session for the signer and stores only the token's digest", async () => {
    const { app, db } = server();
    const { cookie, response } = await signIn(app, alice);
    expect(response.json()).toEqual({ address: alice.address.toLowerCase(), chainId: 133, roles: [], expiresAt: "2026-10-30T12:00:00.000Z" });
    expect(response.headers["set-cookie"]).toMatch(/^settleback_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7200; HttpOnly; SameSite=Strict$/);
    expect((await sessionOf(app, cookie)).json()).toEqual(response.json());

    const token = cookie.slice(cookie.indexOf("=") + 1);
    const [row] = sessionRows(db);
    expect(row).toMatchObject({ token_sha256: sha256Hex(token), address: alice.address.toLowerCase(), chain_id: 133, roles: "", environment: "local", revoked_at: null });
    expect(JSON.stringify(sessionRows(db))).not.toContain(token);
  });

  it("uses a Secure __Host- cookie for an HTTPS origin", async () => {
    const env = { SETTLEBACK_ENV: "testnet", SETTLEBACK_WEB_ORIGIN: "https://settleback.xyz" };
    const { app } = server(env, { db: database("testnet") });
    const issued = await post(app, "/api/auth/challenge", { address: alice.address, chainId: 133 }, { origin: "https://settleback.xyz" });
    const { challenge: token, message } = issued.json();
    expect(message).toMatch(/^https:\/\/settleback\.xyz wants you to sign in/);
    expect(message).toContain("Sign in to SettleBack (testnet).");
    const response = await post(app, "/api/auth/verify", { challenge: token, signature: await alice.signMessage({ message }) }, { origin: "https://settleback.xyz" });
    expect(response.headers["set-cookie"]).toMatch(/^__Host-settleback_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7200; HttpOnly; SameSite=Strict; Secure$/);
  });

  it("opens one session per challenge, however often or concurrently it is presented", async () => {
    const { app, db } = server();
    const { challenge: token, signature } = await signed(app, alice);
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(app, "/api/auth/verify", { challenge: token, signature })));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.statusCode !== 200)) {
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe("CHALLENGE_USED");
    }
    const replay = await post(app, "/api/auth/verify", { challenge: token, signature });
    expect(errorCode(replay)).toBe("CHALLENGE_USED");
    expect(sessionRows(db)).toHaveLength(1);
  });

  it("issues a distinct nonce for every challenge, even for the same account at the same instant", async () => {
    const { app, db } = server();
    const first = await signed(app, alice);
    const second = await signed(app, alice);
    expect(first.challenge.split(".")[1]).not.toBe(second.challenge.split(".")[1]);
    for (const { challenge: token, signature } of [first, second]) {
      expect((await post(app, "/api/auth/verify", { challenge: token, signature })).statusCode).toBe(200);
    }
    expect(sessionRows(db)).toHaveLength(2);
  });

  it("refuses a challenge once it has expired", async () => {
    const { app } = server();
    const late = await signed(app, alice);
    now = new Date(START.getTime() + 5 * 60 * 1000);
    const refused = await post(app, "/api/auth/verify", { challenge: late.challenge, signature: late.signature });
    expect(refused.statusCode).toBe(401);
    expect(errorCode(refused)).toBe("CHALLENGE_EXPIRED");

    now = START;
    const inTime = await signed(app, alice);
    now = new Date(START.getTime() + 5 * 60 * 1000 - 1);
    expect((await post(app, "/api/auth/verify", { challenge: inTime.challenge, signature: inTime.signature })).statusCode).toBe(200);
  });

  it("refuses challenges that were altered or not issued by this server", async () => {
    const { app } = server();
    const issued = await signed(app, alice);
    const altered = [
      reencode(issued.challenge, (payload) => (payload.address = mallory.address.toLowerCase())),
      reencode(issued.challenge, (payload) => (payload.chainId = 31337)),
      reencode(issued.challenge, (payload) => (payload.expiresAt = "2026-10-31T10:00:00.000Z")),
      `${issued.challenge.split(".")[0]}.${"0".repeat(64)}`,
      `${issued.challenge}.extra`,
      "not-a-challenge",
      "",
    ];
    for (const token of altered) {
      const response = await post(app, "/api/auth/verify", { challenge: token, signature: issued.signature });
      expect(response.statusCode, token).toBe(401);
      expect(errorCode(response), token).toBe("CHALLENGE_INVALID");
    }

    const elsewhere = server({}, { key: Buffer.alloc(32, 8) }).app;
    const foreign = await signed(elsewhere, alice);
    expect(errorCode(await post(app, "/api/auth/verify", { challenge: foreign.challenge, signature: foreign.signature }))).toBe("CHALLENGE_INVALID");

    // The same key in another environment still refuses a challenge issued for local.
    const testnet = server({ SETTLEBACK_ENV: "testnet", SETTLEBACK_WEB_ORIGIN: ORIGIN.replace("http:", "https:") }, { db: database("testnet") }).app;
    const crossEnvironment = await post(testnet, "/api/auth/verify", { challenge: issued.challenge, signature: issued.signature }, { origin: "https://localhost:5173" });
    expect(errorCode(crossEnvironment)).toBe("CHALLENGE_INVALID");

    // The original is untouched by all of the above.
    expect((await post(app, "/api/auth/verify", { challenge: issued.challenge, signature: issued.signature })).statusCode).toBe(200);
  });

  it("refuses a signature from another account or over a different message", async () => {
    const { app, db } = server();
    const issued = await challenge(app, alice.address);
    const forged = [
      await mallory.signMessage({ message: issued.message }),
      await alice.signMessage({ message: issued.message.replace("http://localhost:5173 wants", "https://evil.example wants") }),
      await alice.signMessage({ message: issued.message.replace("Chain ID: 133", "Chain ID: 1") }),
      `0x${"00".repeat(65)}`,
    ];
    for (const signature of forged) {
      const response = await post(app, "/api/auth/verify", { challenge: issued.challenge, signature });
      expect(response.statusCode, signature).toBe(401);
      expect(errorCode(response), signature).toBe("SIGNATURE_INVALID");
    }
    for (const signature of ["0x1234", `0x${"zz".repeat(65)}`]) {
      const response = await post(app, "/api/auth/verify", { challenge: issued.challenge, signature });
      expect(response.statusCode, signature).toBe(400);
      expect(errorCode(response), signature).toBe("INVALID_REQUEST");
    }
    expect(sessionRows(db)).toHaveLength(0);
  });

  it("signs in only on a chain the environment uses", async () => {
    const { app } = server();
    const refused = await post(app, "/api/auth/challenge", { address: alice.address, chainId: 1 });
    expect(refused.statusCode).toBe(400);
    expect(errorCode(refused)).toBe("CHAIN_NOT_ALLOWED");
    for (const chainId of ["133", 133.5, 0]) {
      expect((await post(app, "/api/auth/challenge", { address: alice.address, chainId })).statusCode, String(chainId)).toBe(400);
    }

    const withLocalRegistry = server(LOCAL_REGISTRY).app;
    const issued = await challenge(withLocalRegistry, alice.address, 31337);
    expect(issued.message).toContain("Chain ID: 31337");
  });

  it("stops honoring a chain once the configuration no longer uses it", async () => {
    const db = database();
    const before = server(LOCAL_REGISTRY, { db }).app;
    const onRegistryChain = await signed(before, alice, 31337);
    const opened = await post(before, "/api/auth/verify", { challenge: onRegistryChain.challenge, signature: onRegistryChain.signature });
    expect(opened.statusCode).toBe(200);
    const onPaymentChain = await signIn(before, alice);
    const pending = await signed(before, alice, 31337);

    const after = server({}, { db }).app;
    const refused = await post(after, "/api/auth/verify", { challenge: pending.challenge, signature: pending.signature });
    expect([refused.statusCode, errorCode(refused)]).toEqual([400, "CHAIN_NOT_ALLOWED"]);
    expect((await sessionOf(after, cookieOf(opened))).statusCode).toBe(401);
    expect((await sessionOf(after, onPaymentChain.cookie)).statusCode).toBe(200);
  });

  it("accepts only the fields it defines, so no request can claim a role", async () => {
    const { app } = server();
    const extra = await post(app, "/api/auth/challenge", { address: alice.address, chainId: 133, role: "operator" });
    expect(extra.statusCode).toBe(400);
    const { response } = await signIn(app, alice, { "x-settleback-role": "operator" });
    expect(response.json().roles).toEqual([]);
  });
});

describe("sessions", () => {
  it("end at their expiry", async () => {
    const { app } = server();
    const { cookie } = await signIn(app, alice);
    now = new Date(START.getTime() + 2 * 60 * 60 * 1000 - 1);
    expect((await sessionOf(app, cookie)).statusCode).toBe(200);
    now = new Date(START.getTime() + 2 * 60 * 60 * 1000);
    const expired = await sessionOf(app, cookie);
    expect(expired.statusCode).toBe(401);
    expect(errorCode(expired)).toBe("AUTH_REQUIRED");
  });

  it("end on logout, which always clears the cookie", async () => {
    const { app, db } = server();
    const { cookie } = await signIn(app, alice);
    const logout = await post(app, "/api/auth/logout", undefined, { cookie });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toBe("settleback_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    expect(errorCode(await sessionOf(app, cookie))).toBe("AUTH_REQUIRED");
    expect(sessionRows(db)[0]).toMatchObject({ revoke_reason: "LOGOUT", revoked_at: START.toISOString() });

    expect((await post(app, "/api/auth/logout")).statusCode).toBe(204);
    expect((await post(app, "/api/auth/logout", undefined, { cookie })).statusCode).toBe(204);
    expect(sessionRows(db)[0]).toMatchObject({ revoke_reason: "LOGOUT" });
  });

  it("end when the same browser signs in again", async () => {
    const { app, db } = server();
    const first = await signIn(app, alice);
    const second = await signIn(app, mallory, { cookie: first.cookie });
    expect(errorCode(await sessionOf(app, first.cookie))).toBe("AUTH_REQUIRED");
    expect((await sessionOf(app, second.cookie)).json().address).toBe(mallory.address.toLowerCase());
    expect(sessionRows(db).map((row) => row.revoke_reason).sort()).toEqual(["REPLACED", null]);
  });

  it("are refused for a missing, malformed, unknown, or repeated cookie", async () => {
    const { app } = server();
    const { cookie } = await signIn(app, alice);
    const other = `settleback_session=${"A".repeat(43)}`;
    for (const header of [undefined, "settleback_session=short", other, `${cookie}; ${other}`, cookie.replace("settleback_session", "__Host-settleback_session")]) {
      const response = await app.inject({ method: "GET", url: "/api/auth/session", headers: header === undefined ? {} : { cookie: header } });
      expect(response.statusCode, header).toBe(401);
    }
    expect((await sessionOf(app, `theme=dark; ${cookie}`)).statusCode).toBe(200);
  });

  it("carry the operator role only while the configuration grants it", async () => {
    const db = database();
    const operatorApp = server({ SETTLEBACK_OPERATORS: alice.address }, { db }).app;
    const { cookie, response } = await signIn(operatorApp, alice);
    expect(response.json().roles).toEqual(["operator"]);
    expect((await sessionOf(operatorApp, cookie)).statusCode).toBe(200);

    const withdrawn = server({}, { db }).app;
    const refused = await sessionOf(withdrawn, cookie);
    expect(refused.statusCode).toBe(401);
    expect(sessionRows(db)[0]).toMatchObject({ revoke_reason: "ROLE_REMOVED" });
    expect((await sessionOf(operatorApp, cookie)).statusCode).toBe(401);
  });

  it("are refused when they belong to another environment", async () => {
    const { app, db } = server();
    const token = "B".repeat(43);
    db.prepare(
      `INSERT INTO sessions (token_sha256, nonce, environment, address, chain_id, roles, created_at, expires_at)
       VALUES (?, ?, 'testnet', ?, 133, '', ?, ?)`,
    ).run(sha256Hex(token), "e".repeat(64), alice.address.toLowerCase(), START.toISOString(), "2026-10-30T12:00:00.000Z");
    expect((await sessionOf(app, `settleback_session=${token}`)).statusCode).toBe(401);
  });

  it("can only be revoked, once, and are never deleted", async () => {
    const { app, db } = server();
    await signIn(app, alice);
    expect(() => db.prepare("UPDATE sessions SET address = ?").run(mallory.address.toLowerCase())).toThrow(/only be revoked/);
    expect(() => db.prepare("UPDATE sessions SET expires_at = '2030-01-01T00:00:00.000Z'").run()).toThrow(/only be revoked/);
    db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'LOGOUT'").run(START.toISOString());
    expect(() => db.prepare("UPDATE sessions SET revoked_at = NULL, revoke_reason = NULL").run()).toThrow(/only be revoked/);
    expect(() => db.prepare("UPDATE sessions SET revoke_reason = 'REPLACED'").run()).toThrow(/only be revoked/);
    expect(() => db.prepare("DELETE FROM sessions").run()).toThrow(/sign-in record/);
  });
});

describe("cross-origin writes", () => {
  it("are refused before the request is read, whatever cookie it carries", async () => {
    const { app, db } = server();
    const { cookie } = await signIn(app, alice);
    const issued = await signed(app, alice);
    for (const origin of [undefined, "https://evil.example", "null", `${ORIGIN}/`, "http://localhost:5174", "http://127.0.0.1:5173"]) {
      const headers: Record<string, string> = { cookie, ...(origin === undefined ? {} : { origin }) };
      const verify = await app.inject({ method: "POST", url: "/api/auth/verify", headers, payload: { challenge: issued.challenge, signature: issued.signature } });
      expect(verify.statusCode, origin).toBe(403);
      expect(errorCode(verify), origin).toBe("CROSS_ORIGIN_FORBIDDEN");
      expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, origin).toBe(403);
    }
    expect((await sessionOf(app, cookie)).statusCode).toBe(200);
    expect(sessionRows(db)).toHaveLength(1);
    // The refused challenge was never consumed.
    const accepted = await post(app, "/api/auth/verify", { challenge: issued.challenge, signature: issued.signature });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("cannot use the simple text/plain body a cross-site form could send", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      payload: JSON.stringify({ address: alice.address, chainId: 133 }),
    });
    expect(response.statusCode).toBe(415);
    expect(errorCode(response)).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

describe("wallet checks on state-changing requests", () => {
  async function liveSession(env: { chains?: number[] } = {}): Promise<{ authority: SessionAuthority; session: Session; token: string; db: DatabaseSync }> {
    const db = database();
    const authority = new SessionAuthority(
      db,
      { environment: "local", webOrigin: ORIGIN, chains: env.chains ?? [133], operators: [], networkLabel: "local simulation (testnet)" },
      () => now,
      KEY,
    );
    const issued = authority.issue({ address: alice.address, chainId: 133 });
    const { token } = await authority.verify({ challenge: issued.challenge, signature: await alice.signMessage({ message: issued.message }), replacing: undefined });
    return { authority, session: authority.read(token), token, db };
  }

  function refusal(work: () => void): string {
    try {
      work();
    } catch (error) {
      if (error instanceof AuthError) return error.code;
      throw error;
    }
    return "accepted";
  }

  it("accept the signed-in account on a chain the environment uses", async () => {
    const { authority, session, token } = await liveSession({ chains: [133, 31337] });
    expect(refusal(() => authority.checkWallet(session, `eip155:133:${alice.address}`))).toBe("accepted");
    expect(refusal(() => authority.checkWallet(session, `eip155:31337:${alice.address.toLowerCase()}`))).toBe("accepted");
    expect(authority.read(token).address).toBe(alice.address.toLowerCase());
  });

  it("require the wallet to be stated, without ending the session", async () => {
    const { authority, session, token } = await liveSession();
    for (const declared of [undefined, "", alice.address, `eip155:133:${alice.address}, eip155:1:${alice.address}`, `eip155:0133:${alice.address}`, `solana:133:${alice.address}`]) {
      expect(refusal(() => authority.checkWallet(session, declared)), String(declared)).toBe("WALLET_REQUIRED");
    }
    expect(authority.read(token).address).toBe(alice.address.toLowerCase());
  });

  it("end the session when the account or the network changes", async () => {
    for (const declared of [`eip155:133:${mallory.address}`, `eip155:1:${alice.address}`, `eip155:31337:${alice.address}`]) {
      const { authority, session, token, db } = await liveSession();
      expect(refusal(() => authority.checkWallet(session, declared)), declared).toBe("WALLET_CHANGED");
      expect(refusal(() => authority.read(token)), declared).toBe("AUTH_REQUIRED");
      expect(sessionRows(db)[0], declared).toMatchObject({ revoke_reason: "WALLET_CHANGED" });
    }
  });
});

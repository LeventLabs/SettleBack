import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { HttpRequestError } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSimulatedAdapters, signSimulatedPayload, type RegistryGateway } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { buildApp, type AppDependencies } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { getRecoveryActionForCase } from "../../src/db/actions.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { memoryDatabase } from "../db/helpers.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";
import { TERMS, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup } from "../recovery/helpers.ts";

const ORIGIN = "http://localhost:5173";
const buyer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const operator = privateKeyToAccount(`0x${"d4".repeat(32)}`);
const parties = { buyer: buyer.address.toLowerCase(), seller: seller.address.toLowerCase() };

let chain: LocalChain;
let db: DatabaseSync;
const opened: FastifyInstance[] = [];

beforeAll(async () => {
  chain = await startLocalChain();
}, 120_000);

afterAll(() => chain?.stop());

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
  db.close();
});

function server(setup: FixtureCaseSetup | undefined, overrides: Partial<AppDependencies> = {}, env: Record<string, string> = {}): FastifyInstance {
  const app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent", SETTLEBACK_OPERATORS: operator.address, ...env }), {
    db,
    registry: chain.registry,
    terms: TERMS,
    ...(setup === undefined ? {} : { lookup: setup.lookup }),
    ...overrides,
  });
  opened.push(app);
  return app;
}

interface Caller {
  account: PrivateKeyAccount;
  cookie: string;
}

async function signIn(app: FastifyInstance, account: PrivateKeyAccount): Promise<Caller> {
  const issued = await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin: ORIGIN }, payload: { address: account.address, chainId: 133 } });
  const { challenge, message } = issued.json();
  const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin: ORIGIN }, payload: { challenge, signature: await account.signMessage({ message }) } });
  expect(verified.statusCode, verified.body).toBe(200);
  return { account, cookie: String(verified.headers["set-cookie"]).split(";")[0] ?? "" };
}

function wallet(account: PrivateKeyAccount, chainId = 133): string {
  return `eip155:${chainId}:${account.address}`;
}

/** A request as the signed-in browser makes it: same origin, session cookie, and the connected wallet. */
function call(app: FastifyInstance, caller: Caller | undefined, method: "GET" | "POST", url: string, options: { payload?: object; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    ...(caller === undefined ? {} : { cookie: caller.cookie, "x-settleback-wallet": wallet(caller.account) }),
    ...options.headers,
  };
  return app.inject({ method, url, headers, ...(options.payload === undefined ? {} : { payload: options.payload }) });
}

/** Signs the wallet typed data the server offered, as the account's own wallet would. */
async function signMandate(account: PrivateKeyAccount, typed: { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, { name: string; type: string }[]>; message: Record<string, string> }): Promise<string> {
  const { message } = typed;
  return account.signTypedData({
    domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as `0x${string}` },
    types: { TransferWithAuthorization: typed.types.TransferWithAuthorization ?? [] },
    primaryType: "TransferWithAuthorization",
    message: { from: message.from as `0x${string}`, to: message.to as `0x${string}`, value: BigInt(message.value ?? "0"), validAfter: BigInt(message.validAfter ?? "0"), validBefore: BigInt(message.validBefore ?? "0"), nonce: message.nonce as `0x${string}` },
  });
}

function errorCode(response: LightMyRequestResponse): string {
  return response.json().error?.code;
}

function paymentAttempts(operationId: string): number {
  return Number(db.prepare("SELECT count(*) AS n FROM payment_attempts WHERE operation_id = ?").get(operationId)?.n);
}

describe("recovering an existing result over HTTP", () => {
  it("lets the seller reserve it and the buyer retrieve and acknowledge it, with no new work or payment", async () => {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const app = server(setup);
    const [asBuyer, asSeller] = await Promise.all([signIn(app, buyer), signIn(app, seller)]);

    const prepared = await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`);
    expect(prepared.statusCode, prepared.body).toBe(200);
    const { action } = prepared.json();
    expect(action).toMatchObject({ action: "RETRIEVE", state: "RESERVED" });
    expect(prepared.json()).toMatchObject({ sellerCall: null, delegateCall: null });
    const expected = action.proposal.artifactSha256;

    const result = await call(app, asBuyer, "GET", `/api/operations/${setup.operationId}/result`);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "x-settleback-artifact-sha256": expected,
      "x-settleback-action-state": "EXECUTION_REQUESTED",
    });
    // The buyer acknowledges what it computed over the bytes it received, not the header.
    const received = createHash("sha256").update(result.rawPayload).digest("hex");
    expect(received).toBe(expected);

    const ack = await call(app, asBuyer, "POST", `/api/operations/${setup.operationId}/result/ack`, { payload: { artifactSha256: received } });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json()).toMatchObject({ outcome: { status: "RECORDED", action: { state: "COMPLETED" } } });
    expect(ack.json().acknowledgementSha256).toMatch(/^[0-9a-f]{64}$/);

    const buyerView = (await call(app, asBuyer, "GET", `/api/cases/${setup.caseId}`)).json();
    expect(buyerView).toMatchObject({ status: "RECOVERED", relations: ["buyer"], delivery: { artifactSha256: expected }, recoveryAction: { state: "COMPLETED" } });
    expect(buyerView.evidence.items.length).toBeGreaterThan(0);
    expect(buyerView.evidence.items.every((item: Record<string, unknown>) => !("content" in item))).toBe(true);
    expect(buyerView).not.toHaveProperty("assessments");
    const sellerView = (await call(app, asSeller, "GET", `/api/cases/${setup.caseId}`)).json();
    expect(sellerView.relations).toEqual(["seller"]);
    expect(sellerView.evidence.items.every((item: Record<string, unknown>) => typeof item.content === "string")).toBe(true);
    expect(sellerView.assessments).toEqual([]);

    expect(paymentAttempts(setup.operationId)).toBe(1);
    const operation = (await call(app, asBuyer, "GET", `/api/operations/${setup.operationId}`)).json();
    expect(operation).toMatchObject({ relations: ["buyer"], buyer: parties.buyer, seller: parties.seller, case: { id: setup.caseId, status: "RECOVERED" } });
  });

  it("refuses an acknowledgement of a different digest, and one before delivery", async () => {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const app = server(setup);
    const [asBuyer, asSeller] = await Promise.all([signIn(app, buyer), signIn(app, seller)]);
    await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`);
    const early = await call(app, asBuyer, "POST", `/api/operations/${setup.operationId}/result/ack`, { payload: { artifactSha256: "a".repeat(64) } });
    expect([early.statusCode, errorCode(early)]).toEqual([409, "ACK_DIGEST_MISMATCH"]);
    const expected = getRecoveryActionForCase(db, setup.caseId)?.proposal.artifactSha256 ?? "";
    const beforeDelivery = await call(app, asBuyer, "POST", `/api/operations/${setup.operationId}/result/ack`, { payload: { artifactSha256: expected } });
    expect([beforeDelivery.statusCode, errorCode(beforeDelivery)]).toEqual([409, "WRONG_ACTION_STATE"]);
    const malformed = await call(app, asBuyer, "POST", `/api/operations/${setup.operationId}/result/ack`, { payload: { artifactSha256: expected, note: "x" } });
    expect([malformed.statusCode, errorCode(malformed)]).toEqual([400, "INVALID_REQUEST"]);
  });
});

describe("per-case repayment approval over HTTP", () => {
  it("accepts the reservation only once the chain shows it came from the seller", async () => {
    const setup = await setupFixtureCase(db, "refundable-failure-per-case", parties);
    const app = server(setup);
    const asSeller = await signIn(app, seller);
    const prepared = (await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`)).json();
    expect(prepared.action).toMatchObject({ action: "REPAY", state: "PREPARED", authorizationMode: "PER_CASE" });
    expect(prepared.action.proposal.transfer).toMatchObject({ payer: parties.seller, payee: parties.buyer });

    const byStranger = await chain.sendAs(stranger.address.toLowerCase() as Address, prepared.sellerCall, 200_000n);
    await chain.mined(byStranger);
    const rejected = await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/approval-tx`, { payload: { txHash: byStranger } });
    expect(rejected.json()).toMatchObject({ status: "REJECTED" });

    const bySeller = await chain.sendAs(parties.seller as Address, prepared.sellerCall);
    await chain.mined(bySeller);
    const confirmed = await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/approval-tx`, { payload: { txHash: bySeller } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "CONFIRMED", executable: true, action: { state: "RESERVED", approvalTx: bySeller.toLowerCase() } });
  });
});

describe("per-case repayment over HTTP", () => {
  it("lets only the seller pay the reserved repayment, once", async () => {
    const sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret", start: new Date().toISOString() });
    const payments = {
      rail: sim.rail,
      signer: { provenance: "SIMULATED" as const, sign: async (payload: Parameters<typeof signSimulatedPayload>[0]) => signSimulatedPayload(payload) },
      merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
      deploymentId: "local-registry",
      coin: "USDC",
      maxFeeBaseUnits: "100000",
    };
    const setup = await setupFixtureCase(db, "refundable-failure-per-case", parties);
    const app = server(setup, { payments }, { SETTLEBACK_PAYMENT_WRITES: "enabled" });
    const [asBuyer, asSeller, asStranger] = await Promise.all([signIn(app, buyer), signIn(app, seller), signIn(app, stranger)]);
    const url = `/api/cases/${setup.caseId}/recovery/repay`;
    const prepared = (await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`)).json();
    const early = await call(app, asSeller, "POST", url);
    expect([early.statusCode, errorCode(early)]).toEqual([409, "WRONG_ACTION_STATE"]);
    // The case keeps offering the seller its reservation call until the chain confirms it; the buyer never sees one.
    expect((await call(app, asSeller, "GET", `/api/cases/${setup.caseId}`)).json().sellerCall).toEqual(prepared.sellerCall);
    expect((await call(app, asBuyer, "GET", `/api/cases/${setup.caseId}`)).json().sellerCall).toBeNull();
    const bySeller = await chain.sendAs(parties.seller as Address, prepared.sellerCall);
    await chain.mined(bySeller);
    expect((await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/approval-tx`, { payload: { txHash: bySeller } })).json().status).toBe("CONFIRMED");
    expect((await call(app, asSeller, "GET", `/api/cases/${setup.caseId}`)).json().sellerCall).toBeNull();

    expect(errorCode(await call(app, asBuyer, "POST", url))).toBe("ROLE_FORBIDDEN");
    expect(errorCode(await call(app, asStranger, "POST", url))).toBe("NOT_FOUND");
    const unwired = server(setup);
    const noRail = await call(unwired, await signIn(unwired, seller), "POST", url);
    expect([noRail.statusCode, errorCode(noRail)]).toEqual([503, "DEPENDENCY_UNAVAILABLE"]);
    // A connected rail is not enough: payment writes must be enabled in the configuration.
    const disabled = server(setup, { payments });
    const writesOff = await call(disabled, await signIn(disabled, seller), "POST", url);
    expect([writesOff.statusCode, errorCode(writesOff)]).toEqual([503, "DEPENDENCY_UNAVAILABLE"]);
    expect(writesOff.json().error.message).toMatch(/Payment writes are disabled/);

    const requested = await call(app, asSeller, "POST", url);
    expect(requested.statusCode, requested.body).toBe(200);
    const body = requested.json();
    expect(body).toMatchObject({ status: "SIGNATURE_REQUIRED", action: { state: "EXECUTION_REQUESTED" }, payment: { purpose: "REPAYMENT", state: "SIGNING_REQUESTED", payer: parties.seller, payee: parties.buyer } });
    expect(body.typedData).toMatchObject({ primaryType: "TransferWithAuthorization", domain: { name: "USD Coin", version: "2", chainId: 133 }, message: { from: parties.seller, to: parties.buyer, value: "1000000" } });
    expect(body.mandate.payment_mandate_contents.payment_mandate_id).toBe(body.payment.paymentRequestId);
    // Until it is signed, the same mandate is offered again; nothing new is authorized.
    expect((await call(app, asSeller, "POST", url)).json().typedData).toEqual(body.typedData);

    const signatureUrl = `${url}/signature`;
    const malformed = await call(app, asSeller, "POST", signatureUrl, { payload: { signature: "0x1234" } });
    expect([malformed.statusCode, errorCode(malformed)]).toEqual([400, "INVALID_REQUEST"]);
    const forged = await call(app, asSeller, "POST", signatureUrl, { payload: { signature: await signMandate(stranger, body.typedData) } });
    expect([forged.statusCode, errorCode(forged)]).toEqual([409, "MANDATE_SIGNATURE_INVALID"]);
    expect(errorCode(await call(app, asBuyer, "POST", signatureUrl, { payload: { signature: await signMandate(buyer, body.typedData) } }))).toBe("ROLE_FORBIDDEN");
    const signature = await signMandate(seller, body.typedData);
    const paid = await call(app, asSeller, "POST", signatureUrl, { payload: { signature } });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ status: "SUBMITTED", payment: { id: body.payment.id } });
    // The same authorization again cannot pay twice.
    expect((await call(app, asSeller, "POST", signatureUrl, { payload: { signature } })).json()).toMatchObject({ status: "ALREADY_REQUESTED", payment: { id: body.payment.id } });

    for (let tick = 0; tick < 6; tick += 1) sim.gateway.tick();
    await reconcilePending({ db, rail: sim.rail, registry: chain.registry, now: () => new Date(), requiredLevel: "FINAL" });
    const view = (await call(app, asBuyer, "GET", `/api/cases/${setup.caseId}`)).json();
    expect(view).toMatchObject({ status: "REPAID", recoveryAction: { state: "COMPLETED" }, repayment: { state: "VERIFIED", payee: parties.buyer } });
    expect(view.repayment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("authorization", () => {
  async function preparedRetrieval(): Promise<{ setup: FixtureCaseSetup; app: FastifyInstance }> {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const app = server(setup);
    const asSeller = await signIn(app, seller);
    expect((await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`)).statusCode).toBe(200);
    return { setup, app };
  }

  function routes(setup: FixtureCaseSetup): { method: "GET" | "POST"; url: string; payload?: object }[] {
    return [
      { method: "GET", url: `/api/operations/${setup.operationId}` },
      { method: "POST", url: `/api/operations/${setup.operationId}/case` },
      { method: "GET", url: `/api/cases/${setup.caseId}` },
      { method: "POST", url: `/api/cases/${setup.caseId}/assess` },
      { method: "POST", url: `/api/cases/${setup.caseId}/recovery/prepare` },
      { method: "POST", url: `/api/cases/${setup.caseId}/recovery/approval-tx`, payload: { txHash: `0x${"1".repeat(64)}` } },
      { method: "POST", url: `/api/cases/${setup.caseId}/recovery/repay` },
      { method: "GET", url: `/api/operations/${setup.operationId}/result` },
      { method: "POST", url: `/api/operations/${setup.operationId}/result/ack`, payload: { artifactSha256: "a".repeat(64) } },
    ];
  }

  it("requires a session on every operation and case route", async () => {
    const { setup, app } = await preparedRetrieval();
    for (const route of routes(setup)) {
      const response = await call(app, undefined, route.method, route.url, route.payload === undefined ? {} : { payload: route.payload });
      expect([response.statusCode, errorCode(response)], route.url).toEqual([401, "AUTH_REQUIRED"]);
    }
  });

  it("shows an unrelated account nothing, exactly as for an ID that does not exist", async () => {
    const { setup, app } = await preparedRetrieval();
    const asStranger = await signIn(app, stranger);
    for (const route of routes(setup)) {
      const response = await call(app, asStranger, route.method, route.url, route.payload === undefined ? {} : { payload: route.payload });
      expect([response.statusCode, errorCode(response)], route.url).toEqual([404, "NOT_FOUND"]);
      const unknown = await call(app, asStranger, route.method, route.url.replace(setup.operationId, "missing").replace(setup.caseId, "missing"), route.payload === undefined ? {} : { payload: route.payload });
      expect(unknown.json(), route.url).toEqual(response.json());
    }
    expect(getRecoveryActionForCase(db, setup.caseId)?.state).toBe("RESERVED");
  });

  it("lets each party use only its own routes", async () => {
    const { setup, app } = await preparedRetrieval();
    const [asBuyer, asSeller, asOperator] = await Promise.all([signIn(app, buyer), signIn(app, seller), signIn(app, operator)]);
    const forbidden: [Caller, string, string][] = [
      [asSeller, "POST", `/api/operations/${setup.operationId}/case`],
      [asSeller, "GET", `/api/operations/${setup.operationId}/result`],
      [asSeller, "POST", `/api/operations/${setup.operationId}/result/ack`],
      [asBuyer, "POST", `/api/cases/${setup.caseId}/assess`],
      [asBuyer, "POST", `/api/cases/${setup.caseId}/recovery/prepare`],
      [asBuyer, "POST", `/api/cases/${setup.caseId}/recovery/approval-tx`],
      [asOperator, "POST", `/api/cases/${setup.caseId}/recovery/approval-tx`],
      [asOperator, "POST", `/api/cases/${setup.caseId}/recovery/repay`],
      [asBuyer, "POST", `/api/cases/${setup.caseId}/recovery/repay`],
      [asOperator, "GET", `/api/operations/${setup.operationId}/result`],
      [asOperator, "POST", `/api/operations/${setup.operationId}/result/ack`],
    ];
    for (const [caller, method, url] of forbidden) {
      const payload = url.endsWith("approval-tx") ? { txHash: `0x${"1".repeat(64)}` } : url.endsWith("ack") ? { artifactSha256: "a".repeat(64) } : undefined;
      const response = await call(app, caller, method as "GET" | "POST", url, payload === undefined ? {} : { payload });
      expect([response.statusCode, errorCode(response)], `${caller.account.address} ${url}`).toEqual([403, "ROLE_FORBIDDEN"]);
    }
    expect(getRecoveryActionForCase(db, setup.caseId)?.state).toBe("RESERVED");

    // The configured operator sees every case and may open one and request an assessment.
    expect((await call(app, asOperator, "GET", `/api/operations/${setup.operationId}`)).json().relations).toEqual(["operator"]);
    expect((await call(app, asOperator, "POST", `/api/operations/${setup.operationId}/case`)).json()).toMatchObject({ created: false, case: { id: setup.caseId } });
  });

  it("lists only the cases an account is party to, and every case for an operator", async () => {
    const { setup, app } = await preparedRetrieval();
    const other = await setupFixtureCase(db, "refundable-failure-per-case");
    const [asBuyer, asSeller, asStranger, asOperator] = await Promise.all([signIn(app, buyer), signIn(app, seller), signIn(app, stranger), signIn(app, operator)]);
    const ids = async (caller: Caller) => ((await call(app, caller, "GET", "/api/cases")).json().cases as { id: string }[]).map((entry) => entry.id).sort();
    expect(await ids(asBuyer)).toEqual([setup.caseId]);
    expect(await ids(asSeller)).toEqual([setup.caseId]);
    expect(await ids(asStranger)).toEqual([]);
    expect(await ids(asOperator)).toEqual([setup.caseId, other.caseId].sort());
    const [listed] = (await call(app, asBuyer, "GET", "/api/cases")).json().cases;
    expect(listed).toMatchObject({ operationId: setup.operationId, relations: ["buyer"], priceUsd: "1.00", recovery: { action: "RETRIEVE", state: "RESERVED" }, rules: { outcome: "RESOLVES", action: "RETRIEVE" } });
    expect((await call(app, undefined, "GET", "/api/cases")).statusCode).toBe(401);
  });

  it("shows the operation, the original payment, and the rules' result with the case", async () => {
    const { setup, app } = await preparedRetrieval();
    const view = (await call(app, await signIn(app, buyer), "GET", `/api/cases/${setup.caseId}`)).json();
    expect(view.operation).toMatchObject({ buyer: parties.buyer, seller: parties.seller, priceUsd: "1.00", amountBaseUnits: "1000000", chainId: 133 });
    expect(view.originalPayment).toMatchObject({ state: "VERIFIED" });
    expect(view.rules).toMatchObject({ outcome: "RESOLVES", action: "RETRIEVE" });
    // The buyer sees the rules quote only the bound terms, never the seller's own records.
    const policyIds = (view.evidence.items as { id: string; provenance: string }[]).filter((item) => item.provenance === "POLICY").map((item) => item.id);
    const buyerCitations = (view.rules.findings as { citations: { evidenceId: string }[] }[]).flatMap((finding) => finding.citations);
    expect(buyerCitations.length).toBeGreaterThan(0);
    expect(buyerCitations.every((citation) => policyIds.includes(citation.evidenceId))).toBe(true);
    const sellerView = (await call(app, await signIn(app, seller), "GET", `/api/cases/${setup.caseId}`)).json();
    const sellerCitations = (sellerView.rules.findings as { citations: { evidenceId: string }[] }[]).flatMap((finding) => finding.citations);
    expect(sellerCitations.some((citation) => !policyIds.includes(citation.evidenceId))).toBe(true);
    const noTerms = server(setup, { terms: new Map() });
    expect((await call(noTerms, await signIn(noTerms, buyer), "GET", `/api/cases/${setup.caseId}`)).json().rules).toBeNull();
  });

  it("ignores any role a request claims for itself", async () => {
    const { setup, app } = await preparedRetrieval();
    const asBuyer = await signIn(app, buyer);
    const claimed = await call(app, asBuyer, "POST", `/api/cases/${setup.caseId}/assess`, {
      payload: { role: "seller", requestedBy: { role: "seller", identity: parties.seller } },
      headers: { "x-settleback-role": "seller", "x-settleback-identity": parties.seller },
    });
    expect([claimed.statusCode, errorCode(claimed)]).toEqual([403, "ROLE_FORBIDDEN"]);
    const asStranger = await signIn(app, stranger);
    const posing = await call(app, asStranger, "GET", `/api/operations/${setup.operationId}/result`, { headers: { "x-settleback-wallet": wallet(stranger) } });
    expect(errorCode(posing)).toBe("NOT_FOUND");
  });

  it("needs the connected wallet for every state change, and ends the session when it changes", async () => {
    const { setup, app } = await preparedRetrieval();
    const asBuyer = await signIn(app, buyer);
    const url = `/api/operations/${setup.operationId}/result`;

    const head = await app.inject({ method: "HEAD", url, headers: { cookie: asBuyer.cookie, "x-settleback-wallet": wallet(buyer) } });
    expect(head.statusCode).toBe(404);
    expect(getRecoveryActionForCase(db, setup.caseId)?.state).toBe("RESERVED");
    const unstated = await app.inject({ method: "GET", url, headers: { cookie: asBuyer.cookie } });
    expect([unstated.statusCode, errorCode(unstated)]).toEqual([400, "WALLET_REQUIRED"]);
    expect((await call(app, asBuyer, "GET", `/api/operations/${setup.operationId}`, { headers: { "x-settleback-wallet": "" } })).statusCode).toBe(200);

    const switched = await call(app, asBuyer, "GET", url, { headers: { "x-settleback-wallet": wallet(stranger) } });
    expect([switched.statusCode, errorCode(switched)]).toEqual([401, "WALLET_CHANGED"]);
    expect(errorCode(await call(app, asBuyer, "GET", url))).toBe("AUTH_REQUIRED");
    expect(getRecoveryActionForCase(db, setup.caseId)?.state).toBe("RESERVED");

    const again = await signIn(app, buyer);
    const otherNetwork = await call(app, again, "POST", `/api/operations/${setup.operationId}/case`, { headers: { "x-settleback-wallet": wallet(buyer, 1) } });
    expect([otherNetwork.statusCode, errorCode(otherNetwork)]).toEqual([401, "WALLET_CHANGED"]);
  });

  it("refuses writes from another origin before anything changes", async () => {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const app = server(setup);
    const asSeller = await signIn(app, seller);
    for (const origin of ["https://evil.example", "null"]) {
      const response = await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/recovery/prepare`, { headers: { origin } });
      expect([response.statusCode, errorCode(response)], origin).toEqual([403, "CROSS_ORIGIN_FORBIDDEN"]);
    }
    expect(getRecoveryActionForCase(db, setup.caseId)).toBeUndefined();
  });
});

describe("assessment requests", () => {
  it("are recorded for the seller or an operator, never skipped without a provider", async () => {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const running = await setupFixtureCase(db, "still-running", parties);
    const app = server(running);
    const [asSeller, asOperator] = await Promise.all([signIn(app, seller), signIn(app, operator)]);
    const resolved = await call(app, asSeller, "POST", `/api/cases/${setup.caseId}/assess`);
    expect(resolved.json()).toMatchObject({ kind: "RULES_RESOLVED", case: { id: setup.caseId } });

    const failed = await call(app, asOperator, "POST", `/api/cases/${running.caseId}/assess`);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json()).toMatchObject({ kind: "ASSESSED", reused: false, assessment: { status: "FAILED", failureCode: "PROVIDER_NOT_CONFIGURED", requestedBy: `operator:${operator.address.toLowerCase()}` } });
    const view = (await call(app, asSeller, "GET", `/api/cases/${running.caseId}`)).json();
    expect(view.assessments).toHaveLength(1);
  });
});

describe("unavailable dependencies", () => {
  it("are reported as such, without transport details", async () => {
    const setup = await setupFixtureCase(db, "lost-response", parties);
    const noLookup = server(undefined);
    const asSellerNoLookup = await signIn(noLookup, seller);
    const assess = await call(noLookup, asSellerNoLookup, "POST", `/api/cases/${setup.caseId}/assess`);
    expect([assess.statusCode, errorCode(assess)]).toEqual([503, "DEPENDENCY_UNAVAILABLE"]);

    const noTerms = server(setup, { terms: new Map() });
    const prepare = await call(noTerms, await signIn(noTerms, seller), "POST", `/api/cases/${setup.caseId}/recovery/prepare`);
    expect([prepare.statusCode, errorCode(prepare)]).toEqual([503, "DEPENDENCY_UNAVAILABLE"]);

    const noRegistry = server(setup, { registry: undefined });
    const unregistered = await call(noRegistry, await signIn(noRegistry, seller), "POST", `/api/cases/${setup.caseId}/recovery/prepare`);
    expect([unregistered.statusCode, errorCode(unregistered)]).toEqual([503, "REGISTRY_REQUIRED"]);

    const secret = "https://rpc.example/v1/key-5f2c9";
    const unreachable = Object.create(chain.registry) as RegistryGateway;
    unreachable.readCase = async () => Promise.reject(new HttpRequestError({ url: secret, details: "connection refused" }));
    const down = server(setup, { registry: unreachable });
    const failed = await call(down, await signIn(down, seller), "POST", `/api/cases/${setup.caseId}/recovery/prepare`);
    expect([failed.statusCode, errorCode(failed)]).toEqual([503, "DEPENDENCY_UNAVAILABLE"]);
    expect(failed.body).not.toContain("key-5f2c9");
  });
});

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { checkArtifactLead, readArtifactLead, type Address } from "@settleback/domain";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { readCaseEvidence } from "../../src/db/cases.ts";
import { openDatabase } from "../../src/db/database.ts";
import { DEMO_FIXTURES, startDemoWorld, type DemoWorld } from "../../src/demo/world.ts";
import { reconcilePending } from "../../src/payments/reconciler.ts";
import { startLocalChain, type LocalChain } from "../registry/anvil.ts";

const ORIGIN = "http://localhost:5173";
const buyer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const parties = { buyer: buyer.address.toLowerCase(), seller: seller.address.toLowerCase() };

let chain: LocalChain;
let db: DatabaseSync;
let world: DemoWorld;
let app: FastifyInstance;

beforeAll(async () => {
  chain = await startLocalChain();
}, 120_000);

afterAll(() => chain?.stop());

beforeEach(async () => {
  db = openDatabase({ path: ":memory:", environment: "local" });
  world = await startDemoWorld(db, { parties, tickMs: 20 });
  app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent", SETTLEBACK_PAYMENT_WRITES: "enabled" }), {
    db,
    registry: chain.registry,
    terms: world.terms,
    lookup: world.lookup,
    payments: world.payments,
  });
});

afterEach(async () => {
  world.stop();
  await app.close();
  db.close();
});

async function signIn(account: PrivateKeyAccount): Promise<{ account: PrivateKeyAccount; cookie: string }> {
  const issued = (await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin: ORIGIN }, payload: { address: account.address, chainId: 133 } })).json();
  const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin: ORIGIN }, payload: { challenge: issued.challenge, signature: await account.signMessage({ message: issued.message }) } });
  return { account, cookie: String(verified.headers["set-cookie"]).split(";")[0] ?? "" };
}

function call(caller: { account: PrivateKeyAccount; cookie: string }, method: "GET" | "POST", url: string, payload?: object): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { origin: ORIGIN, cookie: caller.cookie, "x-settleback-wallet": `eip155:133:${caller.account.address}` }, ...(payload === undefined ? {} : { payload }) });
}

function caseOf(fixtureId: (typeof DEMO_FIXTURES)[number]) {
  const found = world.cases.find((entry) => entry.fixtureId === fixtureId);
  if (found === undefined) throw new Error(`no ${fixtureId} case`);
  return found;
}

describe("the local demo", () => {
  it("seeds its cases for the given buyer and seller", async () => {
    expect(world.cases.map((entry) => entry.fixtureId)).toEqual([...DEMO_FIXTURES]);
    const asBuyer = await signIn(buyer);
    for (const { caseId, operationId } of world.cases) {
      expect((await call(asBuyer, "GET", `/api/operations/${operationId}`)).json()).toMatchObject({ relations: ["buyer"], buyer: parties.buyer, seller: parties.seller, case: { id: caseId } });
    }
  });

  it("recovers the lost result through its own job service and artifact store", async () => {
    const lost = caseOf("lost-response");
    const [asBuyer, asSeller] = await Promise.all([signIn(buyer), signIn(seller)]);
    expect((await call(asSeller, "POST", `/api/cases/${lost.caseId}/recovery/prepare`)).json().action).toMatchObject({ action: "RETRIEVE", state: "RESERVED" });
    const result = await call(asBuyer, "GET", `/api/operations/${lost.operationId}/result`);
    expect(result.statusCode, result.body).toBe(200);
    const digest = createHash("sha256").update(result.rawPayload).digest("hex");
    expect((await call(asBuyer, "POST", `/api/operations/${lost.operationId}/result/ack`, { artifactSha256: digest })).json().outcome.status).toBe("RECORDED");
  });

  it("pays the refundable failure through the gateway simulator it keeps moving", async () => {
    const refundable = caseOf("refundable-failure-per-case");
    const asSeller = await signIn(seller);
    const prepared = (await call(asSeller, "POST", `/api/cases/${refundable.caseId}/recovery/prepare`)).json();
    const reservation = await chain.sendAs(parties.seller as Address, prepared.sellerCall);
    await chain.mined(reservation);
    expect((await call(asSeller, "POST", `/api/cases/${refundable.caseId}/recovery/approval-tx`, { txHash: reservation })).json().status).toBe("CONFIRMED");
    expect((await call(asSeller, "POST", `/api/cases/${refundable.caseId}/recovery/repay`)).json().status).toBe("SUBMITTED");

    let status = "";
    for (let round = 0; round < 50 && status !== "REPAID"; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await reconcilePending({ db, rail: world.rail, registry: chain.registry, now: () => new Date(), requiredLevel: "FINAL" });
      status = (await call(asSeller, "GET", `/api/cases/${refundable.caseId}`)).json().status;
    }
    expect(status).toBe("REPAID");
  });

  it("reads the artifact the hidden completion's worker wrote, though its job service lost track of it", async () => {
    const hidden = caseOf("hidden-completion");
    const status = JSON.parse((await world.lookup.jobStatus(hidden.operationId, AbortSignal.timeout(1000))) ?? "null") as { state: string; artifactSha256: string | null };
    expect(status).toMatchObject({ state: "RUNNING", artifactSha256: null });
    // The digest appears only in the worker's log, which is the lead an assessment must find.
    const digests = new Set(readCaseEvidence(db, hidden.caseId).items.flatMap((item) => item.content.match(/\b[0-9a-f]{64}\b/g) ?? []));
    const stored: string[] = [];
    for (const digest of digests) if ((await world.lookup.artifactBytes(digest, AbortSignal.timeout(1000))) !== null) stored.push(digest);
    expect(stored).toHaveLength(1);
    const digest = stored[0] ?? "";
    // Other demo jobs produced the same bytes, so the combined stores answer with several records;
    // the lead check still ties the artifact to this operation's own job.
    const records = await world.lookup.artifactRecords(digest, AbortSignal.timeout(1000));
    expect((JSON.parse(records) as unknown[]).length).toBeGreaterThan(1);
    const lead = readArtifactLead(digest, await world.lookup.jobStatus(hidden.operationId, AbortSignal.timeout(1000)), records);
    expect(lead === undefined ? ["unreadable"] : checkArtifactLead(hidden.operationId, lead, [])).toEqual([]);
    expect(await world.lookup.jobStatus("not-a-demo-operation", AbortSignal.timeout(1000))).toBeNull();
    expect(JSON.parse(await world.lookup.artifactRecords("0".repeat(64), AbortSignal.timeout(1000)))).toEqual([]);
  });
});

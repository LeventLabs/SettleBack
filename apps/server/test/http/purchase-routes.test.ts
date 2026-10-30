import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSimulatedAdapters, type SimulatedAdapters } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { DemoPurchases } from "../../src/demo/purchases.ts";
import { simulatedPurchasePayments } from "../../src/payments/purchase-payments.ts";
import { TOKEN, memoryDatabase } from "../db/helpers.ts";
import { TERMS, registerFixturePolicies } from "../recovery/helpers.ts";

const ORIGIN = "http://localhost:5173";
const buyer = privateKeyToAccount(`0x${"b1".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const source = loadSources()[0];
const policy = TERMS.get("extraction-delivery-v1");
if (source === undefined || policy === undefined) throw new Error("fixtures missing");

let db: DatabaseSync;
let sim: SimulatedAdapters;
const opened: FastifyInstance[] = [];

beforeEach(() => {
  db = memoryDatabase();
  registerFixturePolicies(db);
  sim = createSimulatedAdapters({ environment: "local", webhookSecret: "app-secret", start: new Date().toISOString() });
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
  db.close();
});

function server(paymentWrites: "enabled" | "disabled" = "enabled"): FastifyInstance {
  const sellerAddress = seller.address.toLowerCase() as Address;
  const purchases = new DemoPurchases(db, {
    seller: sellerAddress,
    payments: simulatedPurchasePayments(
      {
        rail: sim.rail,
        merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
        policy: { payeeAllowlist: [sellerAddress], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", maxFeeBaseUnits: "100000", usdRate: "1" },
        deploymentId: "local-demo",
        coin: "USDC",
        label: "Structured extraction job",
      },
      { chainId: 133, token: TOKEN as Address, tokenDecimals: 6 },
    ),
    source: { id: source!.id, text: loadSourceBytes(source!).toString("utf8"), sha256: source!.sourceSha256 },
    policy: { id: policy!.id, sha256: policy!.sha256 },
    now: () => sim.clock.now(),
  });
  const app = buildApp(loadConfig({ SETTLEBACK_LOG_LEVEL: "silent", SETTLEBACK_PAYMENT_WRITES: paymentWrites }), { db, terms: TERMS, purchases });
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

function call(app: FastifyInstance, caller: Caller, method: "GET" | "POST", url: string, payload?: object): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { origin: ORIGIN, cookie: caller.cookie, "x-settleback-wallet": `eip155:133:${caller.account.address}` }, ...(payload === undefined ? {} : { payload }) });
}

async function signTyped(account: PrivateKeyAccount, typed: { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, { name: string; type: string }[]>; message: Record<string, string> }): Promise<string> {
  const { message } = typed;
  return account.signTypedData({
    domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as `0x${string}` },
    types: { TransferWithAuthorization: typed.types.TransferWithAuthorization ?? [] },
    primaryType: "TransferWithAuthorization",
    message: { from: message.from as `0x${string}`, to: message.to as `0x${string}`, value: BigInt(message.value ?? "0"), validAfter: BigInt(message.validAfter ?? "0"), validBefore: BigInt(message.validBefore ?? "0"), nonce: message.nonce as `0x${string}` },
  });
}

describe("buying a job over HTTP", () => {
  it("quotes for the signed-in buyer, shows the purchase only to that buyer, and takes one wallet payment", async () => {
    const app = server();
    const [asBuyer, asStranger, asSeller] = await Promise.all([signIn(app, buyer), signIn(app, stranger), signIn(app, seller)]);
    const created = await call(app, asBuyer, "POST", "/api/purchases", { scenario: "response-lost", key: "purchase-0000000001" });
    expect(created.statusCode, created.body).toBe(200);
    const view = created.json();
    expect(view).toMatchObject({ stage: "review", scenario: { id: "response-lost" }, job: { priceUsd: "1.00", seller: seller.address.toLowerCase() }, quote: { merchantName: "SettleBack Demo Seller", grossLimitBaseUnits: "1100000" }, payment: { state: "PREPARED" }, caseId: null });
    expect(view.checks).toHaveLength(12);
    // A retry with the same key is the same purchase.
    expect((await call(app, asBuyer, "POST", "/api/purchases", { scenario: "response-lost", key: "purchase-0000000001" })).json().operationId).toBe(view.operationId);

    const url = `/api/purchases/${view.operationId}`;
    expect((await call(app, asStranger, "GET", url)).statusCode).toBe(404);
    expect((await call(app, asStranger, "POST", `${url}/authorize`)).statusCode).toBe(404);
    expect((await call(app, asSeller, "POST", "/api/purchases", { scenario: "response-lost", key: "purchase-0000000002" })).json().error.code).toBe("ROLE_FORBIDDEN");
    expect((await call(app, asBuyer, "POST", "/api/purchases", { scenario: "everything", key: "purchase-0000000003" })).statusCode).toBe(400);

    const authorized = await call(app, asBuyer, "POST", `${url}/authorize`);
    expect(authorized.statusCode, authorized.body).toBe(200);
    const { typedData, purchase } = authorized.json();
    expect(purchase.stage).toBe("authorize");
    expect(typedData).toMatchObject({ primaryType: "TransferWithAuthorization", domain: { chainId: 133 }, message: { from: buyer.address.toLowerCase(), to: seller.address.toLowerCase(), value: "1000000" } });
    expect((await call(app, asBuyer, "POST", `${url}/authorize/signature`, { signature: "0x1234" })).statusCode).toBe(400);
    const signature = await signTyped(buyer, typedData);
    const paid = await call(app, asBuyer, "POST", `${url}/authorize/signature`, { signature });
    expect(paid.json()).toMatchObject({ status: "SUBMITTED", purchase: { stage: "payment" } });
    expect((await call(app, asBuyer, "POST", `${url}/authorize/signature`, { signature })).json().status).toBe("ALREADY_REQUESTED");
    expect((await call(app, asBuyer, "GET", url)).json()).toMatchObject({ stage: "payment", payment: { purpose: "ORIGINAL" } });
  });

  it("offers no purchase routes while payment writes are disabled", async () => {
    const app = server("disabled");
    const asBuyer = await signIn(app, buyer);
    expect((await call(app, asBuyer, "POST", "/api/purchases", { scenario: "response-lost", key: "purchase-0000000004" })).statusCode).toBe(404);
  });
});

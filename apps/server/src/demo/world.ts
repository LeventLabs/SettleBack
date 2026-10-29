import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSimulatedAdapters, signSimulatedPayload, type PaymentRail } from "@settleback/adapters";
import type { PolicyTerms } from "@settleback/domain";
import type { RepaymentPayments } from "../recovery/repayment.ts";
import type { ResultLookup } from "../recovery/retrieval.ts";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import type { Address } from "@settleback/domain";
import { TERMS, TOKEN, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup, type FixtureParties } from "./fixture-case.ts";
import { DemoPurchases } from "./purchases.ts";

/** The demo's cases: a lost result, a refundable failure, a hidden completion only a cited assessment finds, and its counterfactual. */
export const DEMO_FIXTURES = ["lost-response", "refundable-failure-per-case", "hidden-completion", "unbacked-completion-claim"] as const;

export interface DemoCase {
  fixtureId: (typeof DEMO_FIXTURES)[number];
  caseId: string;
  operationId: string;
}

export interface DemoWorld {
  cases: DemoCase[];
  terms: ReadonlyMap<string, PolicyTerms>;
  /** Reads the job service and artifact store of whichever seeded case is asked about. */
  lookup: ResultLookup;
  rail: PaymentRail;
  payments: RepaymentPayments;
  /** Jobs bought through the workspace, paid by the buyer's wallet. */
  purchases: DemoPurchases;
  stop(): void;
}

/**
 * The local demonstration: the fixture cases recorded in the given (disposable) database with the
 * given buyer and seller, their simulated job services and artifact stores, and the gateway
 * simulator for repayments. Every part is simulated and labeled so; the simulator refuses any live
 * environment. The gateway's clock follows real time and its in-flight payments advance on a timer.
 */
export async function startDemoWorld(db: DatabaseSync, options: { parties: FixtureParties; tickMs: number; onError?: (error: unknown) => void }): Promise<DemoWorld> {
  registerFixturePolicies(db);
  const setups: { fixtureId: DemoCase["fixtureId"]; setup: FixtureCaseSetup }[] = [];
  for (const fixtureId of DEMO_FIXTURES) setups.push({ fixtureId, setup: await setupFixtureCase(db, fixtureId, options.parties) });

  const sim = createSimulatedAdapters({ environment: "local", webhookSecret: randomBytes(32).toString("hex"), start: new Date().toISOString() });
  const merchant = { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey };
  const source = loadSources()[0];
  const policy = TERMS.get("extraction-delivery-v1");
  if (source === undefined || policy === undefined) throw new Error("the demo's source document or delivery terms are missing");
  const purchases = new DemoPurchases(db, {
    seller: options.parties.seller.toLowerCase() as Address,
    agent: {
      rail: sim.rail,
      merchant,
      // The demo buyer's limits; every quote is checked against them before anything is signed.
      policy: { payeeAllowlist: [options.parties.seller.toLowerCase() as Address], perPaymentCapBaseUnits: "5000000", dailyCapBaseUnits: "20000000", maxFeeBaseUnits: "100000", usdRate: "1" },
      deploymentId: "local-demo",
      coin: "USDC",
      label: "Structured extraction job",
    },
    source: { id: source.id, text: loadSourceBytes(source).toString("utf8"), sha256: source.sourceSha256 },
    policy: { id: policy.id, sha256: policy.sha256 },
    token: TOKEN as Address,
    now: () => new Date(),
  });

  const lookups = [...setups.map(({ setup }) => setup.lookup), purchases.lookup];
  const lookup: ResultLookup = {
    jobStatus: async (operationId, signal) => {
      const found = setups.find(({ setup }) => setup.operationId === operationId);
      return found === undefined ? purchases.lookup.jobStatus(operationId, signal) : found.setup.lookup.jobStatus(operationId, signal);
    },
    artifactRecords: async (sha256, signal) => {
      const records: unknown[] = [];
      for (const each of lookups) records.push(...(JSON.parse(await each.artifactRecords(sha256, signal)) as unknown[]));
      return JSON.stringify(records);
    },
    artifactBytes: async (sha256, signal) => {
      for (const each of lookups) {
        const bytes = await each.artifactBytes(sha256, signal);
        if (bytes !== null) return bytes;
      }
      return null;
    },
  };

  const timer = setInterval(() => {
    const behind = Date.now() - sim.clock.now().getTime();
    if (behind > 0) sim.clock.advance(behind);
    sim.gateway.tick();
    void purchases.tick().catch((error: unknown) => options.onError?.(error));
  }, options.tickMs);
  timer.unref();

  return {
    cases: setups.map(({ fixtureId, setup }) => ({ fixtureId, caseId: setup.caseId, operationId: setup.operationId })),
    terms: TERMS,
    lookup,
    rail: sim.rail,
    payments: {
      rail: sim.rail,
      // The live Payment Mandate format is unpublished, so the demo's mandates are signed by the labeled simulator.
      signer: { provenance: "SIMULATED", sign: async (payload) => signSimulatedPayload(payload) },
      merchant,
      deploymentId: "local-demo",
      coin: "USDC",
      maxFeeBaseUnits: "100000",
    },
    purchases,
    stop: () => clearInterval(timer),
  };
}

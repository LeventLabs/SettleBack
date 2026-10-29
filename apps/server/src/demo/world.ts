import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSimulatedAdapters, signSimulatedPayload, type PaymentRail } from "@settleback/adapters";
import type { PolicyTerms } from "@settleback/domain";
import type { RepaymentPayments } from "../recovery/repayment.ts";
import type { ResultLookup } from "../recovery/retrieval.ts";
import { TERMS, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup, type FixtureParties } from "./fixture-case.ts";

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
  stop(): void;
}

/**
 * The local demonstration: the fixture cases recorded in the given (disposable) database with the
 * given buyer and seller, their simulated job services and artifact stores, and the gateway
 * simulator for repayments. Every part is simulated and labeled so; the simulator refuses any live
 * environment. The gateway's clock follows real time and its in-flight payments advance on a timer.
 */
export async function startDemoWorld(db: DatabaseSync, options: { parties: FixtureParties; tickMs: number }): Promise<DemoWorld> {
  registerFixturePolicies(db);
  const setups: { fixtureId: DemoCase["fixtureId"]; setup: FixtureCaseSetup }[] = [];
  for (const fixtureId of DEMO_FIXTURES) setups.push({ fixtureId, setup: await setupFixtureCase(db, fixtureId, options.parties) });

  const lookup: ResultLookup = {
    jobStatus: async (operationId, signal) => {
      const found = setups.find(({ setup }) => setup.operationId === operationId);
      return found === undefined ? null : found.setup.lookup.jobStatus(operationId, signal);
    },
    artifactRecords: async (sha256, signal) => {
      const records: unknown[] = [];
      for (const { setup } of setups) records.push(...(JSON.parse(await setup.lookup.artifactRecords(sha256, signal)) as unknown[]));
      return JSON.stringify(records);
    },
    artifactBytes: async (sha256, signal) => {
      for (const { setup } of setups) {
        const bytes = await setup.lookup.artifactBytes(sha256, signal);
        if (bytes !== null) return bytes;
      }
      return null;
    },
  };

  const sim = createSimulatedAdapters({ environment: "local", webhookSecret: randomBytes(32).toString("hex"), start: new Date().toISOString() });
  const timer = setInterval(() => {
    const behind = Date.now() - sim.clock.now().getTime();
    if (behind > 0) sim.clock.advance(behind);
    sim.gateway.tick();
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
      merchant: { merchantName: "SettleBack Demo Seller", publicKey: sim.merchantPublicKey },
      deploymentId: "local-demo",
      coin: "USDC",
      maxFeeBaseUnits: "100000",
    },
    stop: () => clearInterval(timer),
  };
}

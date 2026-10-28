import { createHash } from "node:crypto";
import {
  buildSimulatedPaymentMandate,
  createSimulatedAdapters,
  decimalToBaseUnits,
  signSimulatedPayload,
  submitPaymentMandate,
  validateCartMandate,
  verifySettlement,
  type GatewayFault,
  type GatewayPaymentRecord,
  type SettlementVerdict,
} from "@settleback/adapters";
import type { Address, EvidenceMediaType, EvidenceSource, PaymentAttemptState } from "@settleback/domain";
import type { FixtureCase } from "@settleback/fixtures";
import { SERVICE_SCENARIOS, runServiceScenario, serviceStatusEvidence, type ScenarioRun, type ServiceEvidence } from "./scenarios.ts";

/** One evidence submission, in the shape the server's evidence ingestion accepts. */
export interface CaseEvidenceSubmission {
  submittedBy: "service" | "reconciler" | "buyer";
  source: EvidenceSource;
  mediaType: EvidenceMediaType;
  sourceEventId: string;
  content: string;
  observedAt: string | null;
}

export interface OperationTerms {
  operationId: string;
  requestId: string;
  buyer: Address;
  seller: Address;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  priceUsd: string;
}

export interface ComposedCase {
  evidence: CaseEvidenceSubmission[];
  /** The original payment attempt's state once reconciled; the gateway simulator decides it for gateway-side cases. */
  paymentState: Extract<PaymentAttemptState, "VERIFIED" | "FAILED" | "UNKNOWN">;
  settlement: SettlementVerdict | null;
  gatewayRecord: GatewayPaymentRecord | null;
  serviceRun: ScenarioRun | null;
}

/** Gateway faults for the cases that happen before any job exists. */
export const GATEWAY_SCENARIOS: Readonly<Record<string, GatewayFault>> = {
  "lost-payment-notification": { kind: "webhook-unreachable" },
  "payment-never-broadcast": { kind: "broadcast-never-succeeds" },
};

const MAX_GATEWAY_TICKS = 10;

/**
 * Produces a fixture case's evidence by running the components: the demo service for job-side
 * cases and the gateway simulator for payment-side ones. Only buyer claims are hand-written. The
 * bound policy is not included; the server records it itself.
 */
export async function composeCaseEvidence(fixture: FixtureCase, terms: OperationTerms, sourceText: string): Promise<ComposedCase> {
  const wanted = new Set(fixture.evidence.map((spec) => spec.source));
  const evidence: CaseEvidenceSubmission[] = [];
  let gatewayRecord: GatewayPaymentRecord | null = null;
  let settlement: SettlementVerdict | null = null;
  let serviceRun: ScenarioRun | null = null;

  const gatewayFault = GATEWAY_SCENARIOS[fixture.id];
  const serviceFaults = SERVICE_SCENARIOS[fixture.id];
  if (gatewayFault !== undefined && serviceFaults !== undefined) throw new Error(`${fixture.id} is mapped as both a gateway and a service scenario`);
  if (gatewayFault === undefined && serviceFaults === undefined) throw new Error(`${fixture.id} has no scenario`);

  if (gatewayFault !== undefined) {
    const payment = await runGatewayPayment(terms, gatewayFault);
    gatewayRecord = payment.record;
    settlement = payment.verdict;
    if (wanted.has("gateway-record")) {
      evidence.push({
        submittedBy: "reconciler",
        source: "gateway-record",
        mediaType: "application/json",
        sourceEventId: `${payment.record.payment_request_id}/${payment.record.status}`,
        content: JSON.stringify(payment.record, null, 2),
        observedAt: payment.observedAt,
      });
    }
    if (wanted.has("service-status")) {
      evidence.push(fromService(serviceStatusEvidence(terms.operationId, undefined), terms.requestId, payment.observedAt));
    }
  } else if (serviceFaults !== undefined) {
    serviceRun = runServiceScenario({
      operationId: terms.operationId,
      requestId: terms.requestId,
      source: { id: fixture.sourceId, text: sourceText },
      faults: serviceFaults,
    });
    for (const item of serviceRun.evidence) {
      if (wanted.has(item.source)) evidence.push(fromService(item, terms.requestId, serviceRun.capturedAt));
    }
  }

  fixture.evidence
    .filter((spec) => spec.handWritten)
    .forEach((spec, index) => {
      if (spec.text === undefined) throw new Error(`${fixture.id}: hand-written evidence without text`);
      evidence.push({
        submittedBy: "buyer",
        source: spec.source,
        mediaType: "text/plain",
        sourceEventId: `claim-${index + 1}`,
        content: spec.text,
        observedAt: null,
      });
    });

  return { evidence, paymentState: paymentState(fixture, settlement), settlement, gatewayRecord, serviceRun };
}

function fromService(item: ServiceEvidence, requestId: string, observedAt: string): CaseEvidenceSubmission {
  return {
    submittedBy: "service",
    source: item.source,
    mediaType: item.source === "service-status" || item.source === "artifact-store" ? "application/json" : "text/plain",
    sourceEventId: `${requestId}/${item.source}`,
    content: item.content,
    observedAt,
  };
}

/**
 * Runs one payment through the gateway simulator with the fault applied, then reads the gateway
 * record and checks it against the simulated chain the way reconciliation does.
 */
async function runGatewayPayment(
  terms: OperationTerms,
  fault: GatewayFault,
): Promise<{ record: GatewayPaymentRecord; verdict: SettlementVerdict; observedAt: string }> {
  const sim = createSimulatedAdapters({
    environment: "local",
    verifier: "0x00000000000000000000000000000000000000f0",
    webhookSecret: "sim-webhook-secret",
  });
  const id = createHash("sha256").update(terms.operationId).digest("hex").slice(0, 16);
  const order = {
    cartMandateId: `cart-${id}`,
    paymentRequestId: `pr-${id}`,
    payee: terms.seller,
    chainId: terms.chainId,
    token: terms.token,
    coin: "USDC",
    tokenDecimals: terms.tokenDecimals,
    priceUsd: terms.priceUsd,
    label: "Structured extraction job",
    expiresAt: new Date(sim.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString(),
  };
  sim.gateway.injectFault(order.paymentRequestId, fault);
  // Receiving agent: merchant-signed Cart Mandate and order. Payment Agent: validate, then sign once.
  const prepared = await sim.rail.prepare(order);
  const validation = validateCartMandate({
    cartMandate: prepared.cartMandate,
    merchant: { merchantName: prepared.cartMandate.contents.merchant_name, publicKey: sim.merchantPublicKey },
    intent: order,
    policy: {
      payeeAllowlist: [terms.seller],
      perPaymentCapBaseUnits: "10000000",
      dailyCapBaseUnits: "50000000",
      spentTodayBaseUnits: "0",
      maxFeeBaseUnits: "100000",
      usdRate: "1",
    },
    now: sim.clock.now(),
  });
  if (!validation.ok) throw new Error(`simulated Cart Mandate rejected: ${validation.rejections.map((entry) => entry.code).join(", ")}`);
  await submitPaymentMandate(sim.rail, signSimulatedPayload(buildSimulatedPaymentMandate(validation.cart, terms.buyer)));

  let observation = await sim.rail.observe(order.paymentRequestId);
  for (let tick = 0; tick < MAX_GATEWAY_TICKS && !isSettled(observation.record); tick += 1) {
    sim.clock.advance(2_000);
    sim.gateway.tick();
    await sim.gateway.deliverDueWebhooks();
    observation = await sim.rail.observe(order.paymentRequestId);
  }
  if (!isSettled(observation.record)) throw new Error(`gateway payment did not settle within ${MAX_GATEWAY_TICKS} ticks`);

  const verdict = verifySettlement({
    expected: {
      payer: terms.buyer,
      payee: terms.seller,
      chainId: terms.chainId,
      token: terms.token,
      amountBaseUnits: decimalToBaseUnits(terms.priceUsd, terms.tokenDecimals),
    },
    tokenDecimals: terms.tokenDecimals,
    record: observation.record,
    transfer: observation.transfer,
    requiredLevel: "FINAL",
  });
  return { record: observation.record, verdict, observedAt: observation.observedAt };
}

function isSettled(record: GatewayPaymentRecord): boolean {
  return record.status === "payment-finalized" || record.status === "payment-failed";
}

/**
 * The attempt state after reconciliation. A verified settlement is VERIFIED. A failure with no
 * transaction anywhere is modeled as already closed FAILED by an operator citing that record,
 * which is the only way the attempt state machine allows it.
 */
function paymentState(fixture: FixtureCase, settlement: SettlementVerdict | null): ComposedCase["paymentState"] {
  const declared = { verified: "VERIFIED", "failed-without-transaction": "FAILED", unknown: "UNKNOWN" } as const;
  const state = declared[fixture.payment];
  if (settlement === null) return state;
  const observed = settlement.status === "VERIFIED" ? "VERIFIED" : settlement.status === "NO_TRANSFER_FOUND" ? "FAILED" : "UNKNOWN";
  if (observed !== state) throw new Error(`${fixture.id}: fixture declares a ${state} payment but the gateway simulation produced ${settlement.status}`);
  return state;
}

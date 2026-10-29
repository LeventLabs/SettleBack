import type { DatabaseSync } from "node:sqlite";
import type { CartValidation, PaymentRail } from "@settleback/adapters";
import type { Address, EvidenceMediaType, EvidenceSource } from "@settleback/domain";
import { startServiceRun, type ServiceEvidence, type ServiceFaults, type ServiceRun } from "@settleback/demo-service";
import { openCase, readCaseForOperation } from "../db/cases.ts";
import { StoreError } from "../db/errors.ts";
import { ingestEvidence } from "../db/evidence.ts";
import { createOperation } from "../db/operations.ts";
import type { PaymentAttemptRecord } from "../db/payments.ts";
import { ExecutionRefusedError } from "../payments/execution.ts";
import { liveOriginalAttempt, quoteForBuyer, type BuyerPaymentAgent } from "../payments/purchase.ts";
import type { Quote } from "../payments/quote.ts";
import type { ResultLookup } from "../recovery/retrieval.ts";

/** How long the buyer's connection waits for the job's response. */
export const RESPONSE_DEADLINE_MS = 12_000;
/** How long after the job starts its records are still collected into the case. */
const COLLECTION_WINDOW_MS = 60_000;

/**
 * The faults the demo injects into a purchased job, chosen before the payment is authorized. They
 * configure the components only: the case receives the records the components actually wrote, and
 * neither the scenario nor its expected outcome is ever evidence.
 */
export const PURCHASE_SCENARIOS = {
  "response-lost": {
    label: "Response lost after completion",
    faults: { edge: { dropResponse: true, timeoutMs: RESPONSE_DEADLINE_MS }, worker: { durationMs: 5_000 } },
  },
  "job-fails": {
    label: "Job fails before producing a result",
    faults: { edge: { timeoutMs: RESPONSE_DEADLINE_MS }, worker: { failBeforeArtifact: true, durationMs: 4_000 } },
  },
  "finishes-late": {
    label: "Job finishes after the response deadline",
    faults: { edge: { timeoutMs: RESPONSE_DEADLINE_MS }, worker: { durationMs: 16_000, skipStatusWrite: true, clockOffsetMs: -2_100 } },
  },
  succeeds: {
    label: "Completes normally",
    faults: { edge: { timeoutMs: RESPONSE_DEADLINE_MS }, worker: { durationMs: 5_000 } },
  },
} as const satisfies Record<string, { label: string; faults: ServiceFaults }>;

export type PurchaseScenario = keyof typeof PURCHASE_SCENARIOS;

export function isPurchaseScenario(value: string): value is PurchaseScenario {
  return Object.hasOwn(PURCHASE_SCENARIOS, value);
}

export type PurchaseEventKind =
  | "payment-verified"
  | "payment-unknown"
  | "job-started"
  | "delivered"
  | "error-response"
  | "deadline-passed"
  | "case-opened"
  | "records-updated";

export interface PurchaseEvent {
  at: string;
  kind: PurchaseEventKind;
}

export interface PurchaseRecord {
  operationId: string;
  buyer: string;
  scenario: PurchaseScenario;
  requestId: string;
  createdAt: string;
  quote: Quote | undefined;
  validation: CartValidation | undefined;
  /** When the buyer's signature reached the gateway; the attempt itself moves only when reconciliation sees it. */
  signatureSubmittedAt: string | undefined;
  run: ServiceRun | undefined;
  jobStartedAt: string | undefined;
  response: { status: number; at: string } | undefined;
  caseId: string | undefined;
  events: PurchaseEvent[];
  done: boolean;
}

export class PurchaseScenarioConflictError extends StoreError {
  constructor(operationId: string) {
    super("IDEMPOTENCY_CONFLICT", `Operation ${operationId} was bought with another demo scenario; a new scenario starts a new job.`);
  }
}

export interface DemoPurchaseOptions {
  seller: Address;
  agent: BuyerPaymentAgent;
  /** The source document every purchased job extracts from. */
  source: { id: string; text: string; sha256: string };
  policy: { id: string; sha256: string };
  token: Address;
  now: () => Date;
}

/**
 * Purchases made through the workspace in the local demo: a new operation per purchase, paid by
 * the buyer's wallet through the gateway simulator, then run against the demo service with the
 * chosen faults. Records live in memory, as the rest of the demo does.
 */
export class DemoPurchases {
  private readonly db: DatabaseSync;
  private readonly options: DemoPurchaseOptions;
  private readonly purchases = new Map<string, PurchaseRecord>();
  private ticking = false;

  constructor(db: DatabaseSync, options: DemoPurchaseOptions) {
    this.db = db;
    this.options = options;
  }

  get agent(): BuyerPaymentAgent {
    return this.options.agent;
  }

  /**
   * Creates the operation for a purchase, or returns the one the same key already created, and
   * quotes it. The scenario is bound before anything is signed and cannot change afterwards.
   */
  async create(input: { buyer: string; scenario: PurchaseScenario; idempotencyKey: string }): Promise<PurchaseRecord> {
    if (input.buyer.toLowerCase() === this.options.seller) throw new ExecutionRefusedError("ROLE_FORBIDDEN", "The seller does not buy its own job; sign in with the buyer's wallet.");
    const now = this.options.now();
    const { operation } = createOperation(this.db, {
      actor: input.buyer,
      idempotencyKey: input.idempotencyKey,
      environment: "local",
      now: now.toISOString(),
      intent: {
        buyer: input.buyer,
        seller: this.options.seller,
        serviceId: "structured-extraction",
        requestSha256: this.options.source.sha256,
        policyId: this.options.policy.id,
        policySha256: this.options.policy.sha256,
        chainId: 133,
        token: this.options.token,
        tokenDecimals: 6,
        priceUsd: "1.00",
        amountBaseUnits: "1000000",
      },
    });
    let record = this.purchases.get(operation.id);
    if (record !== undefined && record.scenario !== input.scenario) throw new PurchaseScenarioConflictError(operation.id);
    if (record === undefined) {
      record = {
        operationId: operation.id,
        buyer: operation.buyer,
        scenario: input.scenario,
        requestId: `req-${operation.id.slice(0, 8)}`,
        createdAt: operation.createdAt,
        quote: undefined,
        validation: undefined,
        signatureSubmittedAt: undefined,
        run: undefined,
        jobStartedAt: undefined,
        response: undefined,
        caseId: undefined,
        events: [],
        done: false,
      };
      this.purchases.set(operation.id, record);
    }
    const attempt = liveOriginalAttempt(this.db, operation.id);
    if (attempt === undefined || attempt.state === "CREATED" || attempt.state === "PREPARED") {
      const quoted = await quoteForBuyer(this.db, { operationId: operation.id, buyer: input.buyer, agent: this.options.agent, now: this.options.now });
      record.quote = quoted.quote;
      record.validation = quoted.validation;
    }
    return record;
  }

  get(operationId: string): PurchaseRecord | undefined {
    return this.purchases.get(operationId);
  }

  /** Notes that the buyer's signature was handed to the gateway, whatever the gateway answered. */
  signatureSubmitted(operationId: string): void {
    const record = this.purchases.get(operationId);
    if (record !== undefined && record.signatureSubmittedAt === undefined) record.signatureSubmittedAt = this.options.now().toISOString();
  }

  attempt(operationId: string): PaymentAttemptRecord | undefined {
    return liveOriginalAttempt(this.db, operationId);
  }

  /** Reads the job service and artifact store of purchased jobs, in the same shape the fixture lookup uses. */
  readonly lookup: ResultLookup = {
    jobStatus: async (operationId) => {
      const status = this.purchases.get(operationId)?.run?.status();
      return status === undefined ? null : JSON.stringify(status);
    },
    artifactRecords: async (sha256) => JSON.stringify([...this.runs()].flatMap((run) => (run.store.record(sha256) === undefined ? [] : [run.store.record(sha256)]))),
    artifactBytes: async (sha256) => {
      for (const run of this.runs()) {
        const content = run.store.get(sha256);
        if (content !== undefined) return Buffer.from(content, "utf8");
      }
      return null;
    },
  };

  /**
   * Moves every purchase forward to now. A job starts only once its payment is verified; an
   * unknown payment never starts one. The case opens when the job answers with an error or the
   * response deadline passes, and records written later reach the same case.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const record of this.purchases.values()) {
        if (!record.done) await this.advance(record);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(record: PurchaseRecord): Promise<void> {
    const now = this.options.now();
    if (record.run === undefined) {
      const attempt = liveOriginalAttempt(this.db, record.operationId);
      if (attempt?.state === "UNKNOWN") this.once(record, "payment-unknown", now);
      if (attempt?.state !== "VERIFIED") return;
      this.once(record, "payment-verified", new Date(attempt.updatedAt));
      record.jobStartedAt = now.toISOString();
      record.run = startServiceRun({
        operationId: record.operationId,
        requestId: record.requestId,
        source: { id: this.options.source.id, text: this.options.source.text },
        faults: PURCHASE_SCENARIOS[record.scenario].faults,
        start: record.jobStartedAt,
        onResponse: (status) => {
          // A dropped response never reaches the buyer, so it is not the buyer's answer.
          if (status !== 499 && record.response === undefined) record.response = { status, at: record.run?.now().toISOString() ?? now.toISOString() };
        },
      });
      this.once(record, "job-started", now);
    }

    const run = record.run;
    run.advanceTo(now);
    const started = Date.parse(record.jobStartedAt ?? now.toISOString());
    if (record.caseId === undefined) {
      if (record.response?.status === 200) {
        this.once(record, "delivered", new Date(record.response.at));
        record.done = true;
        return;
      }
      if (record.response?.status === 502) this.once(record, "error-response", new Date(record.response.at));
      else if (now.getTime() >= started + RESPONSE_DEADLINE_MS) this.once(record, "deadline-passed", new Date(started + RESPONSE_DEADLINE_MS));
      else return;
      await this.collect(record, run, now);
      record.caseId = openCase(this.db, { operationId: record.operationId, openedBy: { role: "buyer", identity: record.buyer }, now: now.toISOString() }).case.id;
      this.once(record, "case-opened", now);
    } else if (await this.collect(record, run, now)) {
      record.events.push({ at: now.toISOString(), kind: "records-updated" });
    }
    if (now.getTime() >= started + COLLECTION_WINDOW_MS) record.done = true;
  }

  /** Records the gateway's record and the components' current records; unchanged records add nothing. */
  private async collect(record: PurchaseRecord, run: ServiceRun, now: Date): Promise<boolean> {
    const submissions = run.evidence().map((item) => fromService(item, record.requestId, run.now().toISOString()));
    const attempt = liveOriginalAttempt(this.db, record.operationId);
    if (attempt?.paymentRequestId != null) {
      const observed = await this.options.agent.rail.observe(attempt.paymentRequestId).catch(() => undefined);
      if (observed !== undefined) {
        submissions.unshift({
          submittedBy: "reconciler",
          source: "gateway-record",
          mediaType: "application/json",
          sourceEventId: `${observed.record.payment_request_id}/${observed.record.status}`,
          content: JSON.stringify(observed.record, null, 2),
          observedAt: now.toISOString(),
        });
      }
    }
    let added = false;
    for (const submission of submissions) {
      if (ingestEvidence(this.db, { ...submission, operationId: record.operationId, now: now.toISOString() }).created) added = true;
    }
    return added;
  }

  private once(record: PurchaseRecord, kind: PurchaseEventKind, at: Date): void {
    if (!record.events.some((event) => event.kind === kind)) record.events.push({ at: at.toISOString(), kind });
  }

  private *runs(): Generator<ServiceRun> {
    for (const record of this.purchases.values()) if (record.run !== undefined) yield record.run;
  }

  /** The case for a purchase, if one was opened. */
  caseOf(operationId: string): string | undefined {
    return this.purchases.get(operationId)?.caseId ?? readCaseForOperation(this.db, operationId)?.id;
  }
}

interface Submission {
  submittedBy: "service" | "reconciler";
  source: EvidenceSource;
  mediaType: EvidenceMediaType;
  sourceEventId: string;
  content: string;
  observedAt: string;
}

/** A component's record as evidence. Its event ID includes the content digest, so a record that changed is a new item and an unchanged one is not. */
function fromService(item: ServiceEvidence, requestId: string, observedAt: string): Submission {
  return {
    submittedBy: "service",
    source: item.source,
    mediaType: item.source === "service-status" || item.source === "artifact-store" ? "application/json" : "text/plain",
    sourceEventId: `${requestId}/${item.source}/${item.sha256.slice(0, 16)}`,
    content: item.content,
    observedAt,
  };
}

import { ManualClock } from "@settleback/adapters";
import { sha256Hex } from "@settleback/domain/hash";
import { MemoryArtifactStore } from "./artifact-store.ts";
import { EdgeProxy, type EdgeFaults } from "./edge.ts";
import { JobService, type JobStatusRecord } from "./job-service.ts";
import { Scheduler } from "./scheduler.ts";
import { Worker, type WorkerFaults } from "./worker.ts";

export interface ServiceFaults {
  edge?: EdgeFaults;
  worker?: WorkerFaults;
}

/**
 * Component faults that reproduce each fixture case on the service side. Gateway-side cases
 * (a lost payment notification, a payment that never broadcast) involve no job and are produced
 * by the gateway simulator instead.
 */
export const SERVICE_SCENARIOS: Readonly<Record<string, ServiceFaults>> = {
  "lost-response": { edge: { dropResponse: true } },
  "refundable-failure-per-case": { worker: { failBeforeArtifact: true, durationMs: 4_000 } },
  "refundable-failure-standing-policy": { worker: { failBeforeArtifact: true, durationMs: 4_000 } },
  "conflicting-evidence": { worker: { crashAfterMs: 6_000 }, edge: { emptyBodyAtMs: 8_000 } },
  "billable-failure": { worker: { failBeforeArtifact: true, durationMs: 4_000 } },
  "injected-claim": { edge: { dropResponse: true } },
  "hidden-completion": { worker: { durationMs: 33_000, skipStatusWrite: true, clockOffsetMs: -2_100 } },
  "unbacked-completion-claim": {
    worker: { durationMs: 33_000, skipStatusWrite: true, losePersistence: true, clockOffsetMs: -2_100 },
  },
  "still-running": { worker: { neverFinish: true } },
  "corrupted-artifact": { worker: { corruptAfterWrite: true } },
  "claim-contradicts-delivery": {},
};

export type ServiceEvidenceSource = "edge-log" | "worker-log" | "service-status" | "artifact-store";

export interface ServiceEvidence {
  source: ServiceEvidenceSource;
  producedBy: "edge" | "worker" | "artifact-store";
  format: string;
  content: string;
  sha256: string;
}

export interface ScenarioRun {
  operationId: string;
  requestId: string;
  /** Simulated time at which the records were collected. */
  capturedAt: string;
  status: JobStatusRecord;
  invocations: number;
  store: MemoryArtifactStore;
  service: JobService;
  evidence: ServiceEvidence[];
}

export interface ScenarioInput {
  operationId: string;
  requestId: string;
  source: { id: string; text: string };
  faults: ServiceFaults;
  start?: string;
  horizonMs?: number;
}

/** A request in progress against the components, moved forward explicitly; its records can be read at any point. */
export interface ServiceRun {
  readonly operationId: string;
  readonly requestId: string;
  readonly store: MemoryArtifactStore;
  readonly service: JobService;
  /** The components' time. */
  now(): Date;
  /** Runs everything due up to `time`, in order, and moves the components' clock there. */
  advanceTo(time: Date): void;
  status(): JobStatusRecord | undefined;
  /** The four records as they stand now. */
  evidence(): ServiceEvidence[];
}

/**
 * Starts one request through the edge, job service, worker, and artifact store. Nothing runs until
 * the run is advanced, so the same run can be driven to completion at once (fixtures) or in step
 * with a wall clock (the live demo).
 */
export function startServiceRun(input: Omit<ScenarioInput, "horizonMs"> & { onResponse?: (status: number) => void }): ServiceRun {
  const clock = new ManualClock(input.start ?? "2026-10-30T10:00:00.000Z");
  const scheduler = new Scheduler(clock);
  const store = new MemoryArtifactStore();
  const worker = new Worker(scheduler, store);
  const service = new JobService(scheduler, worker);
  const edge = new EdgeProxy(scheduler, service, store);

  edge.handle(input.operationId, { requestId: input.requestId, sourceId: input.source.id, sourceText: input.source.text }, input.faults, input.onResponse);

  return {
    operationId: input.operationId,
    requestId: input.requestId,
    store,
    service,
    now: () => clock.now(),
    advanceTo: (time) => {
      const ahead = time.getTime() - clock.now().getTime();
      if (ahead > 0) scheduler.run(ahead);
    },
    status: () => service.status(input.operationId),
    evidence: () => [
      item("edge-log", "edge", "nginx access log with request and operation fields", edge.log.join("\n")),
      item("worker-log", "worker", "worker application log (own job alias and clock)", worker.log.join("\n")),
      serviceStatusEvidence(input.operationId, service.status(input.operationId)),
      item("artifact-store", "artifact-store", "artifact store records (JSON)", JSON.stringify(store.list(), null, 2)),
    ],
  };
}

/** Runs the edge, job service, worker, and artifact store against one request and collects their records. */
export function runServiceScenario(input: ScenarioInput): ScenarioRun {
  const run = startServiceRun(input);
  run.advanceTo(new Date(run.now().getTime() + (input.horizonMs ?? 120_000)));
  const status = run.status();
  if (status === undefined) throw new Error("job was not started");
  return {
    operationId: input.operationId,
    requestId: input.requestId,
    capturedAt: run.now().toISOString(),
    status,
    invocations: run.service.invocations(input.operationId),
    store: run.store,
    service: run.service,
    evidence: run.evidence(),
  };
}

/**
 * The job service's structured status for an operation. When it has no job, it says so in the
 * same format, so "never invoked" is a record from the service rather than an absence of records.
 */
export function serviceStatusEvidence(operationId: string, status: JobStatusRecord | undefined): ServiceEvidence {
  const record: JobStatusRecord = status ?? {
    operationId,
    externalJobId: null,
    state: "NOT_STARTED",
    artifactSha256: null,
    computeStarted: false,
    history: [],
  };
  if (record.operationId !== operationId) throw new Error("status belongs to another operation");
  return item("service-status", "worker", "structured job status (JSON)", JSON.stringify(record, null, 2));
}

function item(source: ServiceEvidenceSource, producedBy: ServiceEvidence["producedBy"], format: string, content: string): ServiceEvidence {
  return { source, producedBy, format, content, sha256: sha256Hex(content) };
}

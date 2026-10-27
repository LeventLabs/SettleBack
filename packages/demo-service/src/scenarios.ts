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

/** Runs the edge, job service, worker, and artifact store against one request and collects their records. */
export function runServiceScenario(input: ScenarioInput): ScenarioRun {
  const clock = new ManualClock(input.start ?? "2026-10-30T10:00:00.000Z");
  const scheduler = new Scheduler(clock);
  const store = new MemoryArtifactStore();
  const worker = new Worker(scheduler, store);
  const service = new JobService(scheduler, worker);
  const edge = new EdgeProxy(scheduler, service, store);

  edge.handle(input.operationId, { requestId: input.requestId, sourceId: input.source.id, sourceText: input.source.text }, input.faults);
  scheduler.run(input.horizonMs ?? 120_000);

  const status = service.status(input.operationId);
  if (status === undefined) throw new Error("job was not started");

  const evidence: ServiceEvidence[] = [
    item("edge-log", "edge", "nginx access log with request and operation fields", edge.log.join("\n")),
    item("worker-log", "worker", "worker application log (own job alias and clock)", worker.log.join("\n")),
    item("service-status", "worker", "structured job status (JSON)", JSON.stringify(status, null, 2)),
    item("artifact-store", "artifact-store", "artifact store records (JSON)", JSON.stringify(store.list(), null, 2)),
  ];
  return { operationId: input.operationId, requestId: input.requestId, status, invocations: service.invocations(input.operationId), store, service, evidence };
}

function item(source: ServiceEvidenceSource, producedBy: ServiceEvidence["producedBy"], format: string, content: string): ServiceEvidence {
  return { source, producedBy, format, content, sha256: sha256Hex(content) };
}

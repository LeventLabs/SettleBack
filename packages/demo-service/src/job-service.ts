import { createHash } from "node:crypto";
import { SERVICE_JOB_MACHINE, assertTransition, type Actor, type ServiceJobState } from "@settleback/domain";
import type { Scheduler } from "./scheduler.ts";
import type { Worker, WorkerFaults, WorkerJob, WorkerReport } from "./worker.ts";

export interface JobStatusRecord {
  operationId: string;
  /** Null only when the service has no job for the operation. */
  externalJobId: string | null;
  state: ServiceJobState;
  artifactSha256: string | null;
  computeStarted: boolean;
  history: { state: ServiceJobState; at: string; actor: Actor }[];
}

export interface JobRequest {
  requestId: string;
  sourceId: string;
  sourceText: string;
}

type SettledListener = (record: JobStatusRecord) => void;

/**
 * Dispatches one worker job per operation and keeps its structured status. Every state change goes
 * through the service-job state machine. Callers must have verified the original payment first.
 */
export class JobService {
  private readonly scheduler: Scheduler;
  private readonly worker: Worker;
  private readonly jobs = new Map<string, JobStatusRecord>();
  private readonly invocationCounts = new Map<string, number>();
  private readonly lastProgress = new Map<string, number>();
  private readonly listeners = new Map<string, SettledListener[]>();

  constructor(scheduler: Scheduler, worker: Worker) {
    this.scheduler = scheduler;
    this.worker = worker;
  }

  /** Starts the job at most once per operation; any later call returns the existing record. */
  startOnce(operationId: string, request: JobRequest, faults: WorkerFaults = {}): JobStatusRecord {
    const existing = this.jobs.get(operationId);
    if (existing !== undefined) return clone(existing);

    const record: JobStatusRecord = {
      operationId,
      externalJobId: alias(operationId),
      state: "NOT_STARTED",
      artifactSha256: null,
      computeStarted: false,
      history: [],
    };
    this.jobs.set(operationId, record);
    this.move(record, "INVOKED", "server");
    this.invocationCounts.set(operationId, (this.invocationCounts.get(operationId) ?? 0) + 1);

    const job: WorkerJob = { alias: alias(operationId), ...request };
    this.worker.start(job, faults, (update) => this.onReport(record, update));
    return clone(record);
  }

  status(operationId: string): JobStatusRecord | undefined {
    const record = this.jobs.get(operationId);
    return record === undefined ? undefined : clone(record);
  }

  invocations(operationId: string): number {
    return this.invocationCounts.get(operationId) ?? 0;
  }

  onSettled(operationId: string, listener: SettledListener): void {
    this.listeners.set(operationId, [...(this.listeners.get(operationId) ?? []), listener]);
  }

  /**
   * Marks a job UNKNOWN when it has stopped reporting. The job is not restarted: an uncertain run
   * may still have done its work, so recovery starts from evidence, not from a second invocation.
   */
  reconcile(operationId: string, staleAfterMs: number): JobStatusRecord | undefined {
    const record = this.jobs.get(operationId);
    if (record === undefined) return undefined;
    const last = this.lastProgress.get(operationId) ?? 0;
    if ((record.state === "INVOKED" || record.state === "RUNNING") && this.scheduler.now() - last > staleAfterMs) {
      this.move(record, "UNKNOWN", "reconciler");
    }
    return clone(record);
  }

  private onReport(record: JobStatusRecord, update: WorkerReport): void {
    this.lastProgress.set(record.operationId, this.scheduler.now());
    switch (update.kind) {
      case "accepted":
        record.computeStarted = true;
        this.move(record, "RUNNING", "service");
        return;
      case "heartbeat":
        return;
      case "completed":
        record.artifactSha256 = update.artifactSha256;
        this.move(record, "COMPLETED", "service", `artifact:${update.artifactSha256}`);
        this.notify(record);
        return;
      case "failed":
        this.move(record, "FAILED", "service", `worker-error:${record.externalJobId}`);
        this.notify(record);
        return;
    }
  }

  private move(record: JobStatusRecord, to: ServiceJobState, actor: Actor, evidenceRef?: string): void {
    assertTransition(SERVICE_JOB_MACHINE, record.state, to, evidenceRef === undefined ? { actor } : { actor, evidenceRef });
    record.state = to;
    record.history.push({ state: to, at: new Date(this.scheduler.now()).toISOString(), actor });
  }

  private notify(record: JobStatusRecord): void {
    for (const listener of this.listeners.get(record.operationId) ?? []) listener(clone(record));
  }
}

function alias(operationId: string): string {
  return `wk-${createHash("sha256").update(operationId).digest("hex").slice(0, 8)}`;
}

function clone(record: JobStatusRecord): JobStatusRecord {
  return structuredClone(record);
}

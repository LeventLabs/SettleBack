import { canonicalJson, type CanonicalValue } from "@settleback/domain/hash";
import type { MemoryArtifactStore } from "./artifact-store.ts";
import { ExtractionError, extractPriceNote } from "./extract.ts";
import { workerLine } from "./logs.ts";
import type { Scheduler } from "./scheduler.ts";

export interface WorkerFaults {
  /** Time from accepting a job to finishing it. */
  durationMs?: number;
  /** The worker's clock differs from the edge's by this much. */
  clockOffsetMs?: number;
  failBeforeArtifact?: boolean;
  /** Stops silently after this long: no artifact, no further status. */
  crashAfterMs?: number;
  /** Keeps reporting progress without finishing. */
  neverFinish?: boolean;
  /** Completion reaches only the worker's own log; the status update is lost. */
  skipStatusWrite?: boolean;
  /** Logs an artifact digest, but the artifact is not persisted. */
  losePersistence?: boolean;
  /** Stored bytes are altered after the digest was recorded. */
  corruptAfterWrite?: boolean;
}

export type WorkerReport =
  | { kind: "accepted" }
  | { kind: "heartbeat" }
  | { kind: "completed"; artifactSha256: string }
  | { kind: "failed"; reason: string };

export interface WorkerJob {
  alias: string;
  requestId: string;
  sourceId: string;
  sourceText: string;
}

const ACCEPT_DELAY_MS = 40;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_DURATION_MS = 5_000;

/** Runs extraction jobs and writes artifacts. It identifies jobs only by its own alias. */
export class Worker {
  readonly log: string[] = [];
  private readonly scheduler: Scheduler;
  private readonly store: MemoryArtifactStore;

  constructor(scheduler: Scheduler, store: MemoryArtifactStore) {
    this.scheduler = scheduler;
    this.store = store;
  }

  start(job: WorkerJob, faults: WorkerFaults, report: (update: WorkerReport) => void): void {
    const offset = faults.clockOffsetMs ?? 0;
    const duration = faults.durationMs ?? DEFAULT_DURATION_MS;
    const write = (level: "INFO" | "WARN" | "ERROR", message: string) =>
      this.log.push(workerLine({ at: new Date(this.scheduler.now() + offset), level, alias: job.alias, message }));
    let stopped = false;

    this.scheduler.after(ACCEPT_DELAY_MS, () => {
      write("INFO", `accepted request_id=${job.requestId} source=${job.sourceId} bytes=${Buffer.byteLength(job.sourceText)}`);
      report({ kind: "accepted" });
    });

    const heartbeat = () => {
      if (stopped) return;
      write("INFO", "progress heartbeat stage=extract");
      report({ kind: "heartbeat" });
      this.scheduler.after(HEARTBEAT_INTERVAL_MS, heartbeat);
    };
    this.scheduler.after(ACCEPT_DELAY_MS + HEARTBEAT_INTERVAL_MS, heartbeat);

    if (faults.crashAfterMs !== undefined) {
      this.scheduler.after(faults.crashAfterMs, () => {
        stopped = true;
      });
      return;
    }
    if (faults.neverFinish) return;

    this.scheduler.after(ACCEPT_DELAY_MS + duration, () => {
      stopped = true;
      if (faults.failBeforeArtifact) {
        const reason = "unrecoverable input error before artifact write";
        write("ERROR", `parse failed: ${reason}`);
        report({ kind: "failed", reason });
        return;
      }
      let content: string;
      try {
        content = canonicalJson(extractPriceNote(job.sourceId, job.sourceText) as unknown as CanonicalValue);
      } catch (error) {
        const reason = error instanceof ExtractionError ? error.message : "unexpected extraction error";
        write("ERROR", `parse failed: ${reason}`);
        report({ kind: "failed", reason });
        return;
      }
      const storedAt = new Date(this.scheduler.now()).toISOString();
      const record = faults.losePersistence
        ? { sha256: this.store.digestOf(content), size: Buffer.byteLength(content) }
        : this.store.put(content, job.alias, storedAt);
      write("INFO", `artifact stored sha256=${record.sha256} bytes=${record.size}`);
      if (faults.corruptAfterWrite) this.store.corrupt(record.sha256);
      if (faults.skipStatusWrite) {
        write("WARN", "status update failed: connection reset by job service");
        return;
      }
      report({ kind: "completed", artifactSha256: record.sha256 });
    });
  }
}

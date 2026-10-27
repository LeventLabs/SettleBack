import type { MemoryArtifactStore } from "./artifact-store.ts";
import type { JobRequest, JobService } from "./job-service.ts";
import { edgeAccessLine } from "./logs.ts";
import type { Scheduler } from "./scheduler.ts";
import type { WorkerFaults } from "./worker.ts";

export interface EdgeFaults {
  /** Upstream timeout; the edge answers 504 if the job has not settled by then. */
  timeoutMs?: number;
  /** The client disconnects before the response is written (nginx status 499). */
  dropResponse?: boolean;
  /** The edge answers 200 with an empty body at this time, regardless of the job. */
  emptyBodyAtMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Front door for buyer requests. Logs one access line per request in nginx style. */
export class EdgeProxy {
  readonly log: string[] = [];
  private readonly scheduler: Scheduler;
  private readonly service: JobService;
  private readonly store: MemoryArtifactStore;

  constructor(scheduler: Scheduler, service: JobService, store: MemoryArtifactStore) {
    this.scheduler = scheduler;
    this.service = service;
    this.store = store;
  }

  handle(operationId: string, request: JobRequest, faults: { edge?: EdgeFaults; worker?: WorkerFaults } = {}): void {
    const started = this.scheduler.now();
    const edge = faults.edge ?? {};
    let responded = false;
    const respond = (status: number, bytes: number) => {
      if (responded) return;
      responded = true;
      this.log.push(
        edgeAccessLine({
          at: new Date(this.scheduler.now()),
          status,
          bytes,
          requestTimeSeconds: (this.scheduler.now() - started) / 1000,
          requestId: request.requestId,
          operationId,
        }),
      );
    };

    this.service.onSettled(operationId, (record) => {
      if (record.state === "COMPLETED" && record.artifactSha256 !== null) {
        const size = this.store.record(record.artifactSha256)?.size ?? 0;
        if (edge.dropResponse) respond(499, 0);
        else respond(200, size);
      } else if (record.state === "FAILED") {
        respond(502, 0);
      }
    });
    if (edge.emptyBodyAtMs !== undefined) this.scheduler.after(edge.emptyBodyAtMs, () => respond(200, 0));
    this.scheduler.after(edge.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => respond(504, 0));

    this.service.startOnce(operationId, request, faults.worker ?? {});
  }
}

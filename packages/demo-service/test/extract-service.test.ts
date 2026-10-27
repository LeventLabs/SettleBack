import { describe, expect, it } from "vitest";
import { ManualClock } from "@settleback/adapters";
import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import { ExtractionError, JobService, MemoryArtifactStore, Scheduler, Worker, extractPriceNote } from "../src/index.ts";

const source = loadSources()[0];
if (source === undefined) throw new Error("fixture source missing");
const sourceText = loadSourceBytes(source).toString("utf8");

describe("extractPriceNote", () => {
  it("produces exactly the expected artifact recorded in the fixtures", () => {
    const artifact = extractPriceNote(source.id, sourceText);
    expect(artifact).toEqual(source.expectedArtifact);
    expect(sha256Hex(canonicalJson(artifact as unknown as CanonicalValue))).toBe(source.expectedArtifactSha256);
  });

  it("fails on documents without items or with an item lacking a price or status", () => {
    expect(() => extractPriceNote("x", "Nothing to see here.")).toThrow(ExtractionError);
    expect(() => extractPriceNote("x", "Widgets (SKU NW-9999) are available.")).toThrow(/No price or status/);
  });
});

function service() {
  const scheduler = new Scheduler(new ManualClock("2026-10-30T10:00:00.000Z"));
  const store = new MemoryArtifactStore();
  return { scheduler, store, jobs: new JobService(scheduler, new Worker(scheduler, store)) };
}

const request = { requestId: "req-1", sourceId: source.id, sourceText };

describe("JobService", () => {
  it("invokes the worker once per operation, however often it is started", () => {
    const { scheduler, jobs } = service();
    jobs.startOnce("op-1", request);
    jobs.startOnce("op-1", request);
    scheduler.run(1_000);
    jobs.startOnce("op-1", request);
    scheduler.run(10_000);
    expect(jobs.invocations("op-1")).toBe(1);
    expect(jobs.status("op-1")?.state).toBe("COMPLETED");
  });

  it("records every state change through the state machine with its actor", () => {
    const { scheduler, jobs } = service();
    jobs.startOnce("op-1", request);
    scheduler.run(10_000);
    expect(jobs.status("op-1")?.history.map((h) => [h.state, h.actor])).toEqual([
      ["INVOKED", "server"],
      ["RUNNING", "service"],
      ["COMPLETED", "service"],
    ]);
  });

  it("marks a silent job unknown and never restarts it", () => {
    const { scheduler, jobs } = service();
    jobs.startOnce("op-1", request, { crashAfterMs: 2_000 });
    scheduler.run(60_000);
    expect(jobs.reconcile("op-1", 30_000)?.state).toBe("UNKNOWN");
    const again = jobs.startOnce("op-1", request);
    scheduler.run(60_000);
    expect(again.state).toBe("UNKNOWN");
    expect(jobs.invocations("op-1")).toBe(1);
    expect(jobs.status("op-1")?.history.at(-1)).toMatchObject({ state: "UNKNOWN", actor: "reconciler" });
  });

  it("does not mark a job that is still reporting progress as unknown", () => {
    const { scheduler, jobs } = service();
    jobs.startOnce("op-1", request, { neverFinish: true });
    scheduler.run(60_000);
    expect(jobs.reconcile("op-1", 30_000)?.state).toBe("RUNNING");
  });
});

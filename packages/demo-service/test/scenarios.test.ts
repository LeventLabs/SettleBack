import { describe, expect, it } from "vitest";
import { ManualClock } from "@settleback/adapters";
import { loadCases, loadSourceBytes, loadSources } from "@settleback/fixtures";
import {
  JobService,
  MemoryArtifactStore,
  SERVICE_SCENARIOS,
  Scheduler,
  Worker,
  runServiceScenario,
  type ScenarioRun,
  type ServiceEvidenceSource,
} from "../src/index.ts";

const source = loadSources()[0];
if (source === undefined) throw new Error("fixture source missing");
const text = loadSourceBytes(source).toString("utf8");
const SERVICE_SOURCES: readonly string[] = ["edge-log", "worker-log", "service-status", "artifact-store"];

/**
 * Cases whose fault is on the gateway side. No job runs, so the only service-side evidence is
 * the absence of an invocation, read from the job service by the case builder, not simulated here.
 */
const GATEWAY_SIDE_CASES: readonly string[] = ["lost-payment-notification", "payment-never-broadcast"];

function run(caseId: string): ScenarioRun {
  const faults = SERVICE_SCENARIOS[caseId];
  if (faults === undefined) throw new Error(`no scenario for ${caseId}`);
  return runServiceScenario({ operationId: "op-demo-0001", requestId: "req-7f3a", source: { id: source!.id, text }, faults });
}

function content(result: ScenarioRun, sourceName: ServiceEvidenceSource): string {
  return result.evidence.find((e) => e.source === sourceName)?.content ?? "";
}

function edgeStatus(result: ScenarioRun): string | undefined {
  return / HTTP\/1\.1" ([0-9]{3}) /.exec(content(result, "edge-log"))?.[1];
}

/** Worker timestamps are on the worker's clock; correct them with the scenario's offset to compare with the edge. */
function workerTime(line: string, offsetMs: number): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/.exec(line);
  if (match === null) throw new Error(`not a worker line: ${line}`);
  return Date.parse(`${match[1]}T${match[2]}.${match[3]}Z`) - offsetMs;
}

describe("fixture coverage", () => {
  const cases = loadCases();

  it("maps only to real fixture cases", () => {
    const ids = new Set(cases.map((c) => c.id));
    for (const id of Object.keys(SERVICE_SCENARIOS)) expect(ids.has(id), id).toBe(true);
  });

  it("has a scenario for every case whose evidence comes from the service, and produces every source the case needs", () => {
    for (const fixture of cases) {
      const needed = fixture.evidence.map((e) => e.source).filter((s) => SERVICE_SOURCES.includes(s));
      if (needed.length === 0 || GATEWAY_SIDE_CASES.includes(fixture.id)) continue;
      const result = run(fixture.id);
      const produced = new Set(result.evidence.filter((e) => e.content.trim() !== "" && e.content !== "[]").map((e) => e.source));
      for (const sourceName of needed) {
        if (sourceName === "artifact-store" && fixture.evidence.some((e) => e.source === "artifact-store" && /no artifact/.test(e.shows))) continue;
        expect(produced.has(sourceName as ServiceEvidenceSource), `${fixture.id} needs ${sourceName}`).toBe(true);
      }
    }
  });

  it("keeps gateway-side cases out of the service: their evidence is that no job was invoked", () => {
    for (const id of GATEWAY_SIDE_CASES) {
      expect(SERVICE_SCENARIOS[id], id).toBeUndefined();
      const fixture = cases.find((c) => c.id === id);
      const serviceEvidence = fixture?.evidence.filter((e) => SERVICE_SOURCES.includes(e.source)) ?? [];
      for (const evidence of serviceEvidence) expect(evidence.shows, id).toMatch(/no job invocation/);
    }
    const scheduler = new Scheduler(new ManualClock("2026-10-30T10:00:00.000Z"));
    const jobs = new JobService(scheduler, new Worker(scheduler, new MemoryArtifactStore()));
    expect(jobs.status("op-never-started")).toBeUndefined();
    expect(jobs.invocations("op-never-started")).toBe(0);
  });

  it("is deterministic: the same scenario yields byte-identical evidence", () => {
    for (const id of Object.keys(SERVICE_SCENARIOS)) {
      expect(run(id).evidence.map((e) => e.sha256), id).toEqual(run(id).evidence.map((e) => e.sha256));
    }
  });
});

describe("the three headline histories differ for real reasons", () => {
  it("lost response, terminal failure, and hidden completion leave different records", () => {
    const lost = run("lost-response");
    const failed = run("refundable-failure-per-case");
    const hidden = run("hidden-completion");

    expect([edgeStatus(lost), edgeStatus(failed), edgeStatus(hidden)]).toEqual(["499", "502", "504"]);
    expect([lost.status.state, failed.status.state, hidden.status.state]).toEqual(["COMPLETED", "FAILED", "RUNNING"]);
    expect(lost.store.list()).toHaveLength(1);
    expect(failed.store.list()).toHaveLength(0);
    expect(content(failed, "worker-log")).toMatch(/ERROR \[wk-[0-9a-f]{8}\] parse failed/);
    const hashes = [lost, failed, hidden].flatMap((r) => r.evidence.map((e) => e.sha256));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("each invoked the worker exactly once", () => {
    for (const id of Object.keys(SERVICE_SCENARIOS)) expect(run(id).invocations, id).toBe(1);
  });
});

describe("hidden completion", () => {
  const result = run("hidden-completion");
  const offset = SERVICE_SCENARIOS["hidden-completion"]?.worker?.clockOffsetMs ?? 0;
  const workerLog = content(result, "worker-log");
  const stored = workerLog.split("\n").find((line) => line.includes("artifact stored"));

  it("times out at the edge while the structured status stays non-terminal", () => {
    expect(edgeStatus(result)).toBe("504");
    expect(content(result, "edge-log")).toContain("request_time=30.000");
    expect(result.status.state).toBe("RUNNING");
    expect(result.status.artifactSha256).toBeNull();
  });

  it("records the artifact only in the worker's own log, about three seconds after the timeout", () => {
    if (stored === undefined) throw new Error("no artifact line");
    const edgeAt = Date.parse("2026-10-30T10:00:30.000Z");
    expect(workerTime(stored, offset) - edgeAt).toBe(3_040);
    expect(stored).toContain(`sha256=${source!.expectedArtifactSha256}`);
    expect(workerLog).not.toContain("op-demo-0001");
  });

  it("leaves enough to verify the lead in code: the digest is stored and was written by this operation's job", () => {
    const record = result.store.record(source!.expectedArtifactSha256);
    expect(record?.writer).toBe(result.status.externalJobId);
    expect(record?.currentSha256).toBe(record?.sha256);
    expect(workerLog).toContain(`[${result.status.externalJobId}]`);
  });
});

describe("other service-side cases", () => {
  it("unbacked completion: the worker logs a digest that the store does not hold", () => {
    const result = run("unbacked-completion-claim");
    expect(content(result, "worker-log")).toContain(`sha256=${source!.expectedArtifactSha256}`);
    expect(result.store.record(source!.expectedArtifactSha256)).toBeUndefined();
    expect(result.status.state).toBe("RUNNING");
  });

  it("corrupted artifact: the stored bytes no longer match the recorded digest", () => {
    const result = run("corrupted-artifact");
    const record = result.store.record(result.status.artifactSha256 ?? "");
    expect(result.status.state).toBe("COMPLETED");
    expect(record?.currentSha256).not.toBe(record?.sha256);
  });

  it("still running: progress continues, nothing finishes, and the edge times out", () => {
    const result = run("still-running");
    expect(edgeStatus(result)).toBe("504");
    expect(result.status.state).toBe("RUNNING");
    expect(content(result, "worker-log").match(/progress heartbeat/g)?.length).toBeGreaterThanOrEqual(10);
    expect(content(result, "worker-log")).not.toMatch(/artifact stored|parse failed/);
  });

  it("conflicting evidence: an empty 200, no terminal status, and no artifact", () => {
    const result = run("conflicting-evidence");
    expect(content(result, "edge-log")).toMatch(/" 200 0 /);
    expect(result.status.state).toBe("RUNNING");
    expect(result.store.list()).toHaveLength(0);
  });

  it("claim contradicts delivery: the edge delivered a body the size of the stored artifact", () => {
    const result = run("claim-contradicts-delivery");
    const size = result.store.list()[0]?.size;
    expect(edgeStatus(result)).toBe("200");
    expect(content(result, "edge-log")).toContain(`" 200 ${size} `);
  });
});

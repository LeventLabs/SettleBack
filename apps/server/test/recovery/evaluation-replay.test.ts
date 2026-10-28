import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAssessmentPrompt, checkSpan, decideAssessment, readArtifactLead } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { COUNTERFACTUAL_CASE, EVALUATION_SCHEMA, report, summarize, type EvaluationRun, type EvaluationSummary } from "../../eval/summary.ts";
import { interpretReply, recordedServiceStatuses } from "../../src/recovery/assessment.ts";

const DIR = fileURLToPath(new URL("../../../../evaluation/", import.meta.url));

interface EvaluationFile {
  schema: string;
  origin: string;
  model: string;
  effort: string;
  promptVersion: string;
  runsPerAbstainingCase: number;
  startedAt: string;
  summary: EvaluationSummary;
  runs: EvaluationRun[];
}

const file = JSON.parse(readFileSync(`${DIR}assessment-runs.json`, "utf8")) as EvaluationFile;

/** Rebuilds what the product derived from the services' recorded answers. */
function replayLead(run: EvaluationRun): { lead: ReturnType<typeof readArtifactLead>; failed: boolean } {
  if (run.lead === null || run.lead === undefined) return { lead: undefined, failed: false };
  const raw = run.lead as { digest: string; jobStatus?: string | null; artifactRecords?: string; error?: string };
  if (raw.error !== undefined || raw.artifactRecords === undefined || raw.jobStatus === undefined) return { lead: undefined, failed: true };
  const lead = readArtifactLead(raw.digest, raw.jobStatus, raw.artifactRecords);
  return { lead, failed: lead === undefined };
}

describe("recorded assessment evaluation", () => {
  it("is labeled as live output of the pinned model", () => {
    expect(file.schema).toBe(EVALUATION_SCHEMA);
    expect(file.origin).toBe("live");
    expect(file.model).toBe("claude-opus-5-5");
    for (const run of file.runs) {
      if (run.reply !== null) expect(run.reply.model).toBe(file.model);
    }
  });

  it.each(file.runs.map((run) => [`${run.fixtureId} #${run.run}`, run] as const))("%s replays to the recorded result", (_name, run) => {
    // The recorded snapshot is exactly what was sent.
    const prompt = buildAssessmentPrompt(run.snapshot);
    expect(sha256Hex(`${prompt.system}\n\n${prompt.user}`)).toBe(run.prompt.sha256);

    if (run.reply === null) {
      expect(run.outcome.ok).toBe(false);
      return;
    }
    const interpreted = interpretReply({ ...run.reply }, file.model, run.snapshot);
    expect(interpreted.ok).toBe(run.outcome.ok);
    if (interpreted.ok && run.outcome.ok) {
      expect(interpreted.assessment).toEqual(run.outcome.assessment);
      const contentById = new Map(run.snapshot.evidence.map((item) => [item.id, item.content]));
      for (const finding of interpreted.assessment.findings) {
        for (const span of finding.citations) expect(checkSpan(contentById.get(span.evidenceId) ?? "", span)).toBe(true);
      }
    }
    if (!interpreted.ok && !run.outcome.ok) expect(interpreted.code).toBe(run.outcome.code);

    if (run.mode === "probe") {
      expect(run.snapshot.baseline.outcome).toBe("RESOLVES");
      expect(run.decision).toBeNull();
      return;
    }
    const { lead, failed } = replayLead(run);
    const decision = decideAssessment({
      operationId: run.snapshot.operationId,
      baseline: run.snapshot.baseline,
      assessment: interpreted.ok ? interpreted.assessment : undefined,
      lead: interpreted.ok ? lead : undefined,
      leadLookupFailed: failed,
      recordedStatuses: recordedServiceStatuses(run.snapshot),
    });
    expect(decision).toEqual(run.decision);
  });

  it("retrieves only after a verified lead, and never on the counterfactual", () => {
    for (const run of file.runs) {
      if (run.decision?.action !== "RETRIEVE") continue;
      expect(run.decision.basis).toBe("VERIFIED_ARTIFACT_LEAD");
      expect(replayLead(run).lead?.artifact?.sha256).toBe(run.decision.artifactSha256);
      expect(run.fixtureId).not.toBe(COUNTERFACTUAL_CASE);
    }
  });

  it("matches its recorded summary and the published report", () => {
    const summary = summarize(file.runs);
    expect(summary).toEqual(file.summary);
    expect(readFileSync(`${DIR}README.md`, "utf8")).toBe(report(file, summary, file.runs));
  });
});

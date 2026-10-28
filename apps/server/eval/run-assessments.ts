// Runs the pinned model over every fixture case and writes the labeled results.
// Usage (from apps/server): node --env-file=../../.env eval/run-assessments.ts [--runs 3] [--concurrency 3]
// Every run is a live, billed API call.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildAssessmentPrompt } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { loadCases, type FixtureCase } from "@settleback/fixtures";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { assessCase, interpretReply, toAssessmentSnapshot } from "../src/recovery/assessment.ts";
import { readCaseBaseline } from "../src/recovery/baseline.ts";
import { ClaudeAssessmentProvider } from "../src/recovery/claude-provider.ts";
import { ProviderError } from "../src/recovery/provider.ts";
import { NOW, SELLER, TERMS, registerFixturePolicies, setupFixtureCase } from "./fixture-case.ts";
import { EVALUATION_SCHEMA, finalAction, report, summarize, type EvaluationRun } from "./summary.ts";

const OUTPUT_DIR = fileURLToPath(new URL("../../../evaluation/", import.meta.url));

const { values } = parseArgs({ options: { runs: { type: "string", default: "3" }, concurrency: { type: "string", default: "3" } } });
const runsPerAbstainingCase = Number(values.runs);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(runsPerAbstainingCase) || runsPerAbstainingCase < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--runs and --concurrency must be positive integers");
}

const config = loadConfig();
const apiKey = config.assessment.apiKey;
if (apiKey === undefined) throw new Error("ANTHROPIC_API_KEY is not set; the evaluation needs live access");
const provider = new ClaudeAssessmentProvider({ ...config.assessment, apiKey: apiKey.reveal() });

async function evaluate(fixture: FixtureCase, run: number): Promise<EvaluationRun> {
  const db = openDatabase({ path: ":memory:", environment: "local", now: () => NOW });
  try {
    registerFixturePolicies(db);
    const setup = await setupFixtureCase(db, fixture.id);
    const caseSnapshot = toAssessmentSnapshot(readCaseBaseline(db, setup.caseId, TERMS));
    const prompt = buildAssessmentPrompt(caseSnapshot);
    const base = {
      fixtureId: fixture.id,
      category: fixture.category,
      run,
      expected: {
        action: fixture.expected.action,
        rulesBaseline: fixture.expected.rulesBaseline,
        citationSources: fixture.expected.citations.map((citation) => citation.source),
        forbidden: fixture.expected.forbidden,
      },
      snapshot: caseSnapshot,
      prompt: { version: prompt.version, sha256: sha256Hex(`${prompt.system}\n\n${prompt.user}`) },
    };

    if (caseSnapshot.baseline.outcome === "ABSTAINS") {
      const result = await assessCase(db, {
        caseId: setup.caseId,
        requestedBy: { role: "seller", identity: SELLER },
        provider,
        lookup: setup.lookup,
        terms: TERMS,
        timeoutMs: config.assessment.timeoutMs,
      });
      if (result.kind !== "ASSESSED" || result.record.result === undefined) throw new Error(`${fixture.id}: no assessment recorded`);
      const stored = result.record.result;
      return {
        ...base,
        mode: "assessed",
        reply:
          stored.servedModel === null
            ? null
            : {
                model: stored.servedModel,
                stopReason: stored.stopReason ?? "none",
                text: stored.responseText,
                refusalCategory: stored.refusalCategory,
                usage:
                  stored.inputTokens === null || stored.outputTokens === null
                    ? null
                    : { inputTokens: stored.inputTokens, outputTokens: stored.outputTokens, thinkingTokens: stored.thinkingTokens },
              },
        durationMs: stored.durationMs,
        outcome:
          stored.assessment === null
            ? { ok: false, code: stored.failureCode ?? "UNKNOWN", detail: stored.failureDetail ?? "" }
            : { ok: true, assessment: stored.assessment },
        lead: stored.lead,
        decision: stored.decision,
      };
    }

    const started = Date.now();
    try {
      const reply = await provider.assess(prompt, AbortSignal.timeout(config.assessment.timeoutMs));
      const interpreted = interpretReply(reply, provider.model, caseSnapshot);
      return {
        ...base,
        mode: "probe",
        reply,
        durationMs: Date.now() - started,
        outcome: interpreted.ok ? { ok: true, assessment: interpreted.assessment } : { ok: false, code: interpreted.code, detail: interpreted.detail },
        lead: null,
        decision: null,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return { ...base, mode: "probe", reply: null, durationMs: Date.now() - started, outcome: { ok: false, code: error.code, detail: error.message }, lead: null, decision: null };
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const fixtures = loadCases();
  const tasks = fixtures.flatMap((fixture) => {
    const count = fixture.expected.rulesBaseline === "ABSTAINS" ? runsPerAbstainingCase : 1;
    return Array.from({ length: count }, (_, index) => ({ fixture, run: index + 1 }));
  });
  console.log(`${tasks.length} live calls to ${provider.model} (effort ${config.assessment.effort}), ${concurrency} at a time`);

  const startedAt = new Date().toISOString();
  const runs: EvaluationRun[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task === undefined) return;
      const result = await evaluate(task.fixture, task.run);
      runs[index] = result;
      console.log(`${task.fixture.id} #${task.run}: ${finalAction(result)} (${result.outcome.ok ? "valid" : result.outcome.code}, ${result.durationMs} ms)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  const summary = summarize(runs);
  const file = {
    schema: EVALUATION_SCHEMA,
    origin: "live",
    model: provider.model,
    effort: config.assessment.effort,
    maxTokens: config.assessment.maxTokens,
    timeoutMs: config.assessment.timeoutMs,
    promptVersion: runs[0]?.prompt.version,
    runsPerAbstainingCase,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    runs,
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, "assessment-runs.json"), `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(join(OUTPUT_DIR, "README.md"), report(file, summary, runs));
  console.log(`criteria met: ${String(summary.criteria.met)}; invalid outputs: ${summary.invalidOutputs}/${summary.totalRuns}`);
}

await main();

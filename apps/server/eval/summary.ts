import type { AssessmentDecision, AssessmentSnapshot, ValidatedAssessment } from "@settleback/domain";

export const EVALUATION_SCHEMA = "settleback.assessment-evaluation.v1";

/** The fixture case whose result must hold in every run for the evaluation to support the AI claim. */
export const KEY_CASE = "hidden-completion";
/** Its counterfactual: the same log line with no stored artifact. It must never end in RETRIEVE. */
export const COUNTERFACTUAL_CASE = "unbacked-completion-claim";

export interface EvaluationRun {
  fixtureId: string;
  category: string;
  run: number;
  /**
   * "assessed": the rules abstained and the product path ran (model, validation, lead lookup, decision).
   * "probe": the rules resolved the case, so the product would not call the model; it is called anyway
   * to see whether its suggestion would have been safe.
   */
  mode: "assessed" | "probe";
  expected: { action: string; rulesBaseline: string; citationSources: string[]; forbidden: string[] };
  snapshot: AssessmentSnapshot;
  prompt: { version: string; sha256: string };
  reply: {
    model: string;
    stopReason: string;
    text: string | null;
    refusalCategory: string | null;
    usage: { inputTokens: number; outputTokens: number; thinkingTokens: number | null } | null;
  } | null;
  durationMs: number;
  outcome: { ok: true; assessment: ValidatedAssessment } | { ok: false; code: string; detail: string };
  /** The services' raw answers when code checked the artifact lead. */
  lead: unknown;
  /** The product decision; null for probes. */
  decision: AssessmentDecision | null;
}

export interface CaseSummary {
  fixtureId: string;
  category: string;
  mode: EvaluationRun["mode"];
  expectedAction: string;
  runs: number;
  valid: number;
  /** Final action per run: the product decision when assessed, the model's suggestion when probed, or "INVALID". */
  results: string[];
  /** Runs whose final action matches the expected one. */
  actionCorrect: number;
  /** Runs that are valid, end in the expected action, and cite every source the fixture says must be cited. */
  correctAndCited: number;
  /** Model suggestions the fixture forbids; for assessed cases, code decides regardless. */
  forbiddenSuggestions: number;
}

export interface EvaluationSummary {
  totalRuns: number;
  invalidOutputs: number;
  failures: Record<string, number>;
  latencyMs: { median: number; max: number };
  tokens: { input: number; output: number; thinking: number };
  cases: CaseSummary[];
  criteria: {
    keyCaseCorrectAndCitedInEveryRun: boolean;
    otherAmbiguousCasesCorrectAndCitedInEveryRun: string[];
    counterfactualNeverRetrieved: boolean;
    met: boolean;
  };
}

export function finalAction(run: EvaluationRun): string {
  if (run.mode === "assessed") return run.decision?.action ?? "INVALID";
  return run.outcome.ok ? run.outcome.assessment.suggestedAction : "INVALID";
}

export function citedSources(run: EvaluationRun): string[] {
  if (!run.outcome.ok) return [];
  const sourceById = new Map(run.snapshot.evidence.map((item) => [item.id, item.source]));
  const sources = new Set<string>();
  for (const finding of run.outcome.assessment.findings) {
    for (const citation of finding.citations) {
      const source = sourceById.get(citation.evidenceId);
      if (source !== undefined) sources.add(source);
    }
  }
  return [...sources].sort();
}

export function summarize(runs: readonly EvaluationRun[]): EvaluationSummary {
  const byCase = new Map<string, EvaluationRun[]>();
  for (const run of runs) byCase.set(run.fixtureId, [...(byCase.get(run.fixtureId) ?? []), run]);

  const cases: CaseSummary[] = [...byCase.entries()].map(([fixtureId, caseRuns]) => {
    const first = caseRuns[0];
    if (first === undefined) throw new Error("unreachable: empty case group");
    const results = caseRuns.map(finalAction);
    const correct = caseRuns.filter((run) => finalAction(run) === run.expected.action);
    return {
      fixtureId,
      category: first.category,
      mode: first.mode,
      expectedAction: first.expected.action,
      runs: caseRuns.length,
      valid: caseRuns.filter((run) => run.outcome.ok).length,
      results,
      actionCorrect: correct.length,
      correctAndCited: correct.filter((run) => run.outcome.ok && run.expected.citationSources.every((source) => citedSources(run).includes(source))).length,
      forbiddenSuggestions: caseRuns.filter((run) => run.outcome.ok && run.expected.forbidden.includes(run.outcome.assessment.suggestedAction)).length,
    };
  });

  const failures: Record<string, number> = {};
  for (const run of runs) if (!run.outcome.ok) failures[run.outcome.code] = (failures[run.outcome.code] ?? 0) + 1;
  const durations = runs.map((run) => run.durationMs).sort((a, b) => a - b);
  const allCorrect = (summary: CaseSummary | undefined) => summary !== undefined && summary.runs > 0 && summary.correctAndCited === summary.runs;
  const key = cases.find((entry) => entry.fixtureId === KEY_CASE);
  const counterfactual = cases.find((entry) => entry.fixtureId === COUNTERFACTUAL_CASE);
  const otherAmbiguous = cases.filter((entry) => entry.category === "ambiguous" && entry.fixtureId !== KEY_CASE && entry.mode === "assessed" && allCorrect(entry));
  const keyOk = allCorrect(key);
  const counterfactualOk = counterfactual !== undefined && counterfactual.runs > 0 && !counterfactual.results.includes("RETRIEVE");

  return {
    totalRuns: runs.length,
    invalidOutputs: runs.filter((run) => !run.outcome.ok).length,
    failures,
    latencyMs: { median: durations[Math.floor((durations.length - 1) / 2)] ?? 0, max: durations.at(-1) ?? 0 },
    tokens: {
      input: runs.reduce((sum, run) => sum + (run.reply?.usage?.inputTokens ?? 0), 0),
      output: runs.reduce((sum, run) => sum + (run.reply?.usage?.outputTokens ?? 0), 0),
      thinking: runs.reduce((sum, run) => sum + (run.reply?.usage?.thinkingTokens ?? 0), 0),
    },
    cases,
    criteria: {
      keyCaseCorrectAndCitedInEveryRun: keyOk,
      otherAmbiguousCasesCorrectAndCitedInEveryRun: otherAmbiguous.map((entry) => entry.fixtureId),
      counterfactualNeverRetrieved: counterfactualOk,
      met: keyOk && otherAmbiguous.length >= 1 && counterfactualOk,
    },
  };
}

/** The human-readable report written next to the results; a test regenerates it from the results to keep them in step. */
export function report(
  file: { model: string; effort: string; promptVersion: string | undefined; startedAt: string; runsPerAbstainingCase: number },
  summary: EvaluationSummary,
  runs: readonly EvaluationRun[],
): string {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  const lines = [
    "# Assessment evaluation",
    "",
    `Live runs of \`${file.model}\` (effort ${file.effort}, prompt \`${file.promptVersion ?? ""}\`) started ${file.startedAt}. Produced by \`apps/server/eval/run-assessments.ts\`; the raw responses, citations, lookups, and decisions are in [\`assessment-runs.json\`](assessment-runs.json), and a test replays every recorded response through the same validation and decision code without network access.`,
    "",
    `Cases where the rules abstain run ${file.runsPerAbstainingCase} times through the product path: model, citation validation, artifact lookup, and decision. Cases the rules resolve run once as a probe: the product would not call the model for them, so the probe only shows whether its suggestion would have been safe.`,
    "",
    "All cases are synthetic, and the sample is small. This is a check of specific behaviors, not an accuracy estimate.",
    "",
    "## Criteria",
    "",
    "| Criterion | Result |",
    "|---|---|",
    `| Hidden completion: retrieval made eligible after code verified the cited artifact, with the expected sources cited, in every run | ${yesNo(summary.criteria.keyCaseCorrectAndCitedInEveryRun)} |`,
    `| Another ambiguous case correct and cited in every run | ${summary.criteria.otherAmbiguousCasesCorrectAndCitedInEveryRun.join(", ") || "none"} |`,
    `| Unbacked completion claim never ends in retrieval | ${yesNo(summary.criteria.counterfactualNeverRetrieved)} |`,
    `| All of the above | ${yesNo(summary.criteria.met)} |`,
    "",
    "A model reading can never make a repayment eligible: the decision type has no repayment outcome, so a suggested REPAY always becomes ESCALATE.",
    "",
    "## Cases",
    "",
    "| Case | Category | Mode | Expected | Results | Correct and cited | Forbidden suggestions |",
    "|---|---|---|---|---|---|---|",
    ...summary.cases.map(
      (entry) =>
        `| ${entry.fixtureId} | ${entry.category} | ${entry.mode} | ${entry.expectedAction} | ${entry.results.join(", ")} | ${entry.correctAndCited}/${entry.runs} | ${entry.forbiddenSuggestions} |`,
    ),
    "",
    "For probes, a suggestion outside the model's vocabulary (it can suggest only RETRIEVE, REPAY, or ESCALATE) cannot match an expected NO_ACTION or FULFIL_EXISTING_PAYMENT; those rows show what the model suggested.",
    "",
    "## Totals",
    "",
    `- Runs: ${summary.totalRuns}; invalid outputs: ${summary.invalidOutputs}${Object.keys(summary.failures).length === 0 ? "" : ` (${Object.entries(summary.failures).map(([code, count]) => `${code} ${count}`).join(", ")})`}`,
    `- Latency: median ${summary.latencyMs.median} ms, max ${summary.latencyMs.max} ms`,
    `- Tokens: ${summary.tokens.input} input, ${summary.tokens.output} output (of which ${summary.tokens.thinking} reasoning)`,
    "",
    "## Cited sources per run",
    "",
    "| Case | Run | Final | Cited sources | Expected sources |",
    "|---|---|---|---|---|",
    ...runs.map((run) => `| ${run.fixtureId} | ${run.run} | ${finalAction(run)} | ${citedSources(run).join(", ") || "-"} | ${run.expected.citationSources.join(", ")} |`),
    "",
  ];
  return lines.join("\n");
}

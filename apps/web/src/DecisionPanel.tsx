import { api } from "./api.ts";
import type { Runner } from "./CaseWorkspace.tsx";
import { SOURCE_LABELS, actionLabel, short, when } from "./format.ts";
import type { AssessmentView, CaseView } from "./types.ts";
import type { WalletAccount } from "./wallet.ts";

const ASSESSABLE = ["OPEN", "ASSESSING", "REVIEW_REQUIRED"];

/** What the deterministic rules found, and what a cited assessment added when they abstained. */
export function DecisionPanel({ data, wallet, runner }: { data: CaseView; wallet: WalletAccount | null; runner: Runner }) {
  const rules = data.rules;
  const canAssess = (data.relations.includes("seller") || data.relations.includes("operator")) && ASSESSABLE.includes(data.status) && data.recoveryAction === null;
  const latest = data.assessments === undefined ? undefined : data.assessments[data.assessments.length - 1];
  const sourceOf = (evidenceId: string) => {
    const item = data.evidence.items.find((entry) => entry.id === evidenceId);
    return item === undefined ? "unknown item" : (SOURCE_LABELS[item.source] ?? item.source);
  };

  async function assess() {
    await runner.run("assess", async () => {
      const result = await api<{ kind: string; assessment?: AssessmentView }>(`/api/cases/${encodeURIComponent(data.id)}/assess`, { method: "POST", wallet });
      if (result.kind === "RULES_RESOLVED") return "The rules already settle this case; no model was asked.";
      return result.assessment?.status === "SUCCEEDED"
        ? "The assessment finished; its findings are below."
        : { tone: "attention", text: `The assessment failed (${result.assessment?.failureCode ?? "unknown"}); nothing was decided by it.` };
    });
  }

  return (
    <section className="panel" aria-labelledby="decision-title">
      <h2 id="decision-title">Decision</h2>
      <h3>Deterministic rules</h3>
      {rules === null && <p className="empty">The service terms for this case's policy are not loaded, so the rules cannot run.</p>}
      {rules?.outcome === "RESOLVES" && (
        <>
          <p className="verdict">
            Rules resolve: <strong>{actionLabel(rules.action)}</strong> <span className="panel__aside">({rules.classification})</span>
          </p>
          <Findings findings={rules.findings.map((finding) => ({ statement: finding.statement, support: finding.support, quotes: finding.citations.map((citation) => ({ source: sourceOf(citation.evidenceId), quote: citation.quote })) }))} />
        </>
      )}
      {rules?.outcome === "ABSTAINS" && (
        <>
          <p className="verdict">The rules abstain: the records do not settle this case on their own.</p>
          <ul className="reasons">
            {rules.reasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
          {rules.missingEvidence.length > 0 && <p className="panel__aside">Missing: {rules.missingEvidence.join("; ")}</p>}
        </>
      )}

      <h3>Cited assessment</h3>
      {data.assessments === undefined && <p className="empty">Assessments quote the seller's records, so they are visible to the seller and operators.</p>}
      {data.assessments !== undefined && latest === undefined && <p className="empty">No assessment requested. One is needed only when the rules abstain.</p>}
      {latest !== undefined && <Assessment assessment={latest} sourceOf={sourceOf} />}
      {canAssess && rules?.outcome === "ABSTAINS" && (
        <div className="action">
          <p className="action__why">Claude reads the records and terms and must quote them exactly. It can at most make delivery of an existing result eligible, after code verifies the artifact; it never authorizes a payment.</p>
          <button type="button" className="button" disabled={runner.working !== null || wallet === null} onClick={() => void assess()}>
            {runner.working === "assess" ? "Assessing… (up to a minute)" : latest?.status === "FAILED" ? "Retry the assessment" : "Request a cited assessment"}
          </button>
        </div>
      )}
    </section>
  );
}

function Assessment({ assessment, sourceOf }: { assessment: AssessmentView; sourceOf: (evidenceId: string) => string }) {
  const result = assessment.assessment;
  return (
    <div className="assessment">
      <p className="panel__aside">
        {assessment.failureCode === "PROVIDER_NOT_CONFIGURED" ? "No model configured" : assessment.origin === "live" ? `Live ${assessment.model}` : `${assessment.origin} input labeled as such`} · attempt {assessment.attempt} · evidence revision {assessment.evidenceRevision} · {when(assessment.completedAt ?? assessment.requestedAt)}
      </p>
      {assessment.status === "IN_PROGRESS" && <p className="chip chip--pending">In progress</p>}
      {assessment.status === "FAILED" && <p className="inline-error">The assessment failed ({assessment.failureCode}); the case stays with a person.</p>}
      {assessment.decision?.action === "RETRIEVE" && (
        <p className="verdict">
          Code verified the artifact lead: <strong>deliver the existing result</strong> <span className="panel__aside">artifact {short(assessment.decision.artifactSha256)} written by job {assessment.decision.writer}</span>
        </p>
      )}
      {assessment.decision?.action === "ESCALATE" && (
        <>
          <p className="verdict">Escalated to a person.</p>
          <ul className="reasons">
            {assessment.decision.reasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
        </>
      )}
      {result !== null && (
        <>
          <p>
            Suggested: <strong>{actionLabel(result.suggestedAction)}</strong>
          </p>
          <p className="assessment__explanation">{result.explanation}</p>
          <Findings findings={result.findings.map((finding) => ({ statement: finding.statement, support: finding.support, quotes: finding.citations.map((citation) => ({ source: sourceOf(citation.evidenceId), quote: citation.quote })) }))} />
          {result.missingEvidence.length > 0 && <p className="panel__aside">Missing: {result.missingEvidence.join("; ")}</p>}
        </>
      )}
    </div>
  );
}

function Findings({ findings }: { findings: { statement: string; support: string; quotes: { source: string; quote: string }[] }[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="findings">
      {findings.map((finding, index) => (
        <li key={index}>
          <span className={finding.support === "supported" ? "badge" : "badge badge--attention"}>{finding.support}</span> {finding.statement}
          {finding.quotes.map((quote, quoteIndex) => (
            <blockquote key={quoteIndex} className="quote">
              <span className="quote__source">{quote.source}</span>
              <code>{quote.quote}</code>
            </blockquote>
          ))}
        </li>
      ))}
    </ul>
  );
}

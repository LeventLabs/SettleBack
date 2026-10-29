import { api, describeError } from "./api.ts";
import { actionLabel, roleLabel, short, stateLabel, toneOf } from "./format.ts";
import type { CaseSummary, Session } from "./types.ts";
import { usePoll } from "./usePoll.ts";

export function CaseList({ session, selected, onSelect, buying, onBuy }: { session: Session; selected: string | null; onSelect: (caseId: string) => void; buying: boolean; onBuy: () => void }) {
  const cases = usePoll(() => api<{ cases: CaseSummary[] }>("/api/cases").then((body) => body.cases), 5000, session.address);

  return (
    <nav className="inbox" aria-label="Cases">
      <button type="button" className={buying ? "inbox__buy inbox__buy--selected" : "inbox__buy"} aria-current={buying ? "page" : undefined} onClick={onBuy}>
        <span className="inbox__name">Buy a job</span>
        <span className="inbox__meta">Pay for a new job from this wallet</span>
      </button>
      <h2 className="inbox__title">Cases</h2>
      {cases.error !== undefined && <p className="inline-error">Could not refresh: {describeError(cases.error)}</p>}
      {cases.loading && cases.data === undefined && <p className="empty">Loading cases…</p>}
      {cases.data !== undefined && cases.data.length === 0 && <p className="empty">No cases involve this account.</p>}
      <ul className="inbox__list">
        {cases.data?.map((entry) => (
          <li key={entry.id}>
            <button type="button" className={!buying && entry.id === selected ? "inbox__item inbox__item--selected" : "inbox__item"} aria-current={!buying && entry.id === selected ? "true" : undefined} onClick={() => onSelect(entry.id)}>
              <span className="inbox__row">
                <span className="inbox__name">Case {short(entry.id, 4)}</span>
                <span className={`chip chip--${toneOf(entry.status)}`}>{stateLabel(entry.status)}</span>
              </span>
              <span className="inbox__meta">
                {entry.serviceId} · ${entry.priceUsd} · {roleLabel(entry.relations)}
              </span>
              <span className="inbox__summary">{entry.rules === null ? "Rules unavailable" : entry.rules.outcome === "RESOLVES" ? `Rules: ${actionLabel(entry.rules.action).toLowerCase()}` : "Rules abstain: needs a cited assessment"}</span>
              <span className="inbox__meta">{entry.recovery === null ? "No recovery prepared" : `${actionLabel(entry.recovery.action)}: ${stateLabel(entry.recovery.state)}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

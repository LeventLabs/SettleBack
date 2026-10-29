import { useState } from "react";
import { api, describeError } from "./api.ts";
import { DecisionPanel } from "./DecisionPanel.tsx";
import { PROVENANCE_LABELS, SOURCE_LABELS, laneOf, networkName, paymentLabel, paymentTone, roleLabel, short, stateLabel, toneOf, when, type Tone } from "./format.ts";
import { RecoveryPanel } from "./RecoveryPanel.tsx";
import type { CaseView, EvidenceItem, Health, Session } from "./types.ts";
import { usePoll } from "./usePoll.ts";
import type { WalletAccount } from "./wallet.ts";

export interface Runner {
  working: string | null;
  /** Runs one user action, shows its outcome, and refreshes the case. */
  run: (label: string, work: () => Promise<string | { tone: Tone; text: string } | void>) => Promise<void>;
}

export function CaseWorkspace({ caseId, session, wallet, health }: { caseId: string; session: Session; wallet: WalletAccount | null; health: Health }) {
  const view = usePoll(() => api<CaseView>(`/api/cases/${encodeURIComponent(caseId)}`), 3000, caseId);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const runner: Runner = {
    working,
    run: async (label, work) => {
      setWorking(label);
      setMessage(null);
      try {
        const outcome = await work();
        if (typeof outcome === "string") setMessage({ tone: "pending", text: outcome });
        else if (outcome !== undefined) setMessage(outcome);
      } catch (error) {
        setMessage({ tone: "attention", text: describeError(error) });
      } finally {
        setWorking(null);
        await view.reload();
      }
    },
  };

  if (view.data === undefined) {
    return (
      <section className="workspace" aria-label="Case workspace">
        {view.error === undefined ? <p className="empty">Loading case…</p> : <p className="inline-error">Could not load the case: {describeError(view.error)}</p>}
      </section>
    );
  }
  const data = view.data;
  return (
    <section className="workspace" aria-label={`Case ${short(data.id, 4)}`}>
      <CaseHeader data={data} health={health} session={session} />
      {view.error !== undefined && <p className="inline-error">Showing the last loaded state; refreshing failed: {describeError(view.error)}</p>}
      {message !== null && (
        <div className={`notice notice--${message.tone}`} role="status">
          {message.text}
        </div>
      )}
      <Timeline data={data} />
      <div className="workspace__grid">
        <DecisionPanel data={data} wallet={wallet} runner={runner} />
        <RecoveryPanel data={data} wallet={wallet} runner={runner} />
      </div>
      <EvidencePanel data={data} />
    </section>
  );
}

function CaseHeader({ data, health, session }: { data: CaseView; health: Health; session: Session }) {
  const party = (address: string) => (address === session.address ? `${short(address, 4)} (you)` : short(address, 4));
  return (
    <header className="case-header">
      <div className="case-header__title">
        <h1>Case {short(data.id, 4)}</h1>
        <span className={`chip chip--${toneOf(data.status)}`}>{stateLabel(data.status)}</span>
        <span className="case-header__role">You: {roleLabel(data.relations)}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Job</dt>
          <dd>
            {data.operation.serviceId} for ${data.operation.priceUsd}
          </dd>
        </div>
        <div>
          <dt>Buyer → seller</dt>
          <dd>
            {party(data.operation.buyer)} → {party(data.operation.seller)}
          </dd>
        </div>
        <div>
          <dt>Payment network</dt>
          <dd>
            Chain {data.operation.chainId}, token {short(data.operation.token, 4)}
          </dd>
        </div>
        <div>
          <dt>Inputs</dt>
          <dd>
            {health.mode === "simulated" ? "Synthetic fixture · simulated gateway and payment chain" : "Live records"}
            {health.mode === "simulated" && health.registry.status === "connected" && health.registry.provenance === "LIVE" ? ` · registry live on ${networkName(health.registry.chainId)}` : ""}
          </dd>
        </div>
      </dl>
    </header>
  );
}

interface LaneEntry {
  key: string;
  at: string | null;
  title: string;
  detail: string;
  tone: Tone;
}

const LANES: { id: "payment" | "execution" | "delivery"; title: string }[] = [
  { id: "payment", title: "Payment" },
  { id: "execution", title: "Execution" },
  { id: "delivery", title: "Delivery" },
];

/** Payment, execution, and delivery kept apart: each lane shows only its own records and states. */
function Timeline({ data }: { data: CaseView }) {
  const lanes: Record<"payment" | "execution" | "delivery", LaneEntry[]> = { payment: [], execution: [], delivery: [] };
  for (const item of data.evidence.items) {
    const lane = laneOf(item.source);
    if (lane === "terms") continue;
    lanes[lane].push({ key: item.id, at: item.observedAt ?? item.receivedAt, title: SOURCE_LABELS[item.source] ?? item.source, detail: summarize(item), tone: item.provenance === "CLAIM" ? "attention" : "neutral" });
  }
  if (data.originalPayment !== null) {
    lanes.payment.unshift({ key: "original", at: null, title: "Original payment", detail: paymentLabel(data.originalPayment.state), tone: paymentTone(data.originalPayment.state) });
  }
  if (data.repayment !== null) {
    lanes.payment.push({
      key: "repayment",
      at: data.repayment.updatedAt,
      title: "Repayment (separate transfer)",
      detail: `${paymentLabel(data.repayment.state)}${data.repayment.txHash === null ? "" : ` · tx ${short(data.repayment.txHash)}`}`,
      tone: paymentTone(data.repayment.state),
    });
  }
  if (data.delivery !== null) {
    lanes.delivery.push({ key: "ack", at: data.delivery.acknowledgedAt, title: "Buyer acknowledged receipt", detail: `artifact ${short(data.delivery.artifactSha256)}`, tone: toneOf(data.status) });
  }
  return (
    <section className="timeline" aria-label="Timeline">
      {LANES.map((lane) => (
        <div key={lane.id} className="lane">
          <h2 className="lane__title">{lane.title}</h2>
          {lanes[lane.id].length === 0 ? (
            <p className="empty">No records.</p>
          ) : (
            <ol className="lane__entries">
              {lanes[lane.id].map((entry) => (
                <li key={entry.key} className={`lane__entry lane__entry--${entry.tone}`}>
                  <span className="lane__entry-title">{entry.title}</span>
                  <span className="lane__entry-detail">{entry.detail}</span>
                  {entry.at !== null && <time dateTime={entry.at}>{when(entry.at)}</time>}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

/** A one-line reading of a record for the timeline; the full text stays in the evidence panel. */
function summarize(item: EvidenceItem): string {
  const provenance = PROVENANCE_LABELS[item.provenance] ?? item.provenance;
  if (item.content === undefined) return `${provenance} · digest ${short(item.storedSha256)}`;
  try {
    const parsed = JSON.parse(item.content) as Record<string, unknown> | unknown[];
    if (Array.isArray(parsed)) return `${provenance} · ${parsed.length} record${parsed.length === 1 ? "" : "s"}`;
    const status = parsed.status ?? parsed.state;
    if (typeof status === "string") return `${provenance} · ${status}`;
  } catch {
    // Plain-text logs: show their last line.
  }
  const lines = item.content.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  return `${provenance} · ${last.length > 110 ? `${last.slice(0, 110)}…` : last}`;
}

function EvidencePanel({ data }: { data: CaseView }) {
  return (
    <section className="panel" aria-labelledby="evidence-title">
      <h2 id="evidence-title">
        Evidence and terms <span className="panel__aside">revision {data.evidence.revision} · {short(data.evidence.sha256)}</span>
      </h2>
      <ul className="evidence">
        {data.evidence.items.map((item) => (
          <li key={item.id} className="evidence__item">
            <details>
              <summary>
                <span className="evidence__source">{SOURCE_LABELS[item.source] ?? item.source}</span>
                <span className={item.provenance === "CLAIM" ? "badge badge--attention" : "badge"}>{PROVENANCE_LABELS[item.provenance] ?? item.provenance}</span>
                <span className="evidence__time">{when(item.observedAt ?? item.receivedAt)}</span>
              </summary>
              <p className="evidence__digest">
                Item {short(item.id, 4)} · SHA-256 {short(item.storedSha256)}
              </p>
              {item.content === undefined ? <p className="empty">The text is visible to the seller and operators; you see its digest.</p> : <pre className="evidence__content">{item.content}</pre>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

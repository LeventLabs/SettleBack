import { useState, type ReactNode } from "react";
import { api, describeError } from "./api.ts";
import { AuthorizationReview, type PendingAuthorization } from "./Authorization.tsx";
import { explorerLink, networkName, short, stateLabel, when, type Tone } from "./format.ts";
import type { Health, PurchaseCheck, PurchaseView, Session, SignatureRequest, TypedData } from "./types.ts";
import { usePoll } from "./usePoll.ts";
import { signTypedData, switchChain, type WalletAccount } from "./wallet.ts";

const SCENARIOS = [
  { id: "response-lost", label: "Response lost after completion" },
  { id: "job-fails", label: "Job fails before producing a result" },
  { id: "finishes-late", label: "Job finishes after the response deadline" },
  { id: "succeeds", label: "Completes normally" },
] as const;

const STAGES = [
  { id: "review", label: "Review quote" },
  { id: "authorize", label: "Authorize" },
  { id: "payment", label: "Payment" },
  { id: "job", label: "Job" },
] as const;

const CHECK_STATUS: Record<PurchaseCheck["status"], string> = { passed: "Passed", blocked: "Blocked", "not-checked": "Not checked" };

const EVENT_LABELS: Record<PurchaseView["events"][number]["kind"], string> = {
  "payment-verified": "Payment verified",
  "payment-unknown": "Payment outcome unknown",
  "job-started": "Job started",
  delivered: "Result delivered",
  "error-response": "The service answered with an error and no result",
  "deadline-passed": "Response deadline passed with no response",
  "case-opened": "Recovery case opened",
  "records-updated": "New service records added to the case",
};

interface Stored {
  operationId?: string;
  /** Generated before the purchase request, so a retry after a lost response returns the same purchase. */
  pendingKey?: string;
}

function storageKey(address: string): string {
  return `settleback.purchase.${address}`;
}

function readStored(address: string): Stored {
  try {
    return JSON.parse(window.localStorage.getItem(storageKey(address)) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

function writeStored(address: string, value: Stored): void {
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(value));
  } catch {
    // Storage is a convenience: without it a refresh starts a new purchase view, and nothing is paid twice.
  }
}

/** Base units of a six-decimal stablecoin, without floating point. */
function usdc(baseUnits: string | null): string {
  if (baseUnits === null) return "—";
  const value = BigInt(baseUnits);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction} USDC`;
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(undefined, { timeStyle: "medium" });
}

/**
 * Buying a job from the workspace. The seller's receiving agent quotes, the buyer's Payment Agent
 * checks the quote and the authorization, the buyer's wallet signs it, the gateway (simulated, or
 * HSP on HSK Chain testnet) executes it, and the job runs. Every stage follows the server's state;
 * nothing here advances on a timer.
 */
export function BuyJob({ session, wallet, health, onViewCase }: { session: Session; wallet: WalletAccount | null; health: Health; onViewCase: (caseId: string) => void }) {
  const [operationId, setOperationId] = useState<string | null>(() => readStored(session.address).operationId ?? null);
  const [scenario, setScenario] = useState<string>("response-lost");
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const purchase = usePoll(
    () => (operationId === null ? Promise.resolve(null) : api<PurchaseView>(`/api/purchases/${encodeURIComponent(operationId)}`)),
    1500,
    `${session.address}:${operationId ?? "new"}`,
  );
  const view = purchase.data ?? null;
  const registryLive = health.registry.status === "connected" && health.registry.provenance === "LIVE";
  const live = view === null ? health.paymentGateway === "hsp-agentic" : view.payments.gateway === "hsp-agentic";
  const [pending, setPending] = useState<PendingAuthorization | null>(null);

  async function run(label: string, work: () => Promise<string | { tone: Tone; text: string } | void>): Promise<void> {
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
      await purchase.reload();
    }
  }

  async function quote(): Promise<void> {
    if (wallet === null) return;
    await run("quote", async () => {
      const stored = readStored(session.address);
      const key = stored.pendingKey ?? crypto.randomUUID();
      writeStored(session.address, { pendingKey: key });
      const created = await api<PurchaseView>("/api/purchases", { method: "POST", body: { scenario, key }, wallet });
      writeStored(session.address, { operationId: created.operationId });
      setOperationId(created.operationId);
    });
  }

  /** Signs on the chain the authorization's domain names; wallets sign typed data only there. */
  async function signOnPaymentChain(typedData: TypedData): Promise<{ signature: string; signer: WalletAccount }> {
    if (wallet === null) throw new Error("Connect your wallet first.");
    const paymentChain = typedData.domain.chainId;
    if (wallet.chainId !== paymentChain) await switchChain(paymentChain);
    const signer = { ...wallet, chainId: paymentChain };
    return { signature: await signTypedData(signer, typedData), signer };
  }

  async function submit(operation: string, signature: string, signer: WalletAccount): Promise<string | { tone: Tone; text: string }> {
    const outcome = await api<{ status: string; reason?: string }>(`/api/purchases/${encodeURIComponent(operation)}/authorize/signature`, { method: "POST", body: { signature }, wallet: signer });
    if (outcome.status === "SUBMITTED") return live ? "HSP accepted the payment once. The job starts when HSP's record and the transfer on HSK Chain testnet agree." : "Your authorization was submitted once. The job starts when the payment is verified.";
    if (outcome.status === "ALREADY_REQUESTED") return "This authorization was already submitted; it is not paid twice.";
    return { tone: "attention", text: `The submission's outcome is unknown (${outcome.reason ?? "no reason given"}). It is reconciled from the gateway and the chain; the job does not start until the payment is verified.` };
  }

  async function authorize(): Promise<void> {
    if (wallet === null || view === null) return;
    const operation = view.operationId;
    await run("authorize", async () => {
      const requested = await api<SignatureRequest>(`/api/purchases/${encodeURIComponent(operation)}/authorize`, { method: "POST", wallet });
      if (requested.status !== "SIGNATURE_REQUIRED" || requested.typedData === undefined || requested.authorization === undefined) return "This payment was already authorized; it is not paid twice.";
      // HSP's authorization is reviewed, signed, and submitted in separate steps the buyer confirms.
      if (requested.authorization.preparedBy === "hsp") {
        setPending({ typedData: requested.typedData, authorization: requested.authorization, signature: null });
        return;
      }
      const { signature, signer } = await signOnPaymentChain(requested.typedData);
      return submit(operation, signature, signer);
    });
  }

  async function signPending(): Promise<void> {
    if (pending === null) return;
    await run("sign", async () => {
      const { signature } = await signOnPaymentChain(pending.typedData);
      setPending({ ...pending, signature });
    });
  }

  async function submitPending(): Promise<void> {
    if (pending === null || pending.signature === null || view === null || wallet === null) return;
    const signature = pending.signature;
    const operation = view.operationId;
    await run("submit", async () => {
      try {
        return await submit(operation, signature, { ...wallet, chainId: pending.typedData.domain.chainId });
      } finally {
        setPending(null);
      }
    });
  }

  function startOver(): void {
    writeStored(session.address, {});
    setOperationId(null);
    setMessage(null);
    setPending(null);
  }

  const current = view === null ? -1 : STAGES.findIndex((stage) => stage.id === view.stage);
  const finished = view !== null && (view.caseId !== null || view.events.some((event) => event.kind === "delivered"));

  return (
    <section className="workspace" aria-labelledby="buy-title">
      <header className="case-header">
        <div className="case-header__title">
          <h1 id="buy-title">Buy a job</h1>
          <span className="badge">Wallet-assisted agent payment</span>
          {view !== null && (
            <span className="badge badge--simulated" title="Faults are injected into the demo service; the case receives the records its components actually wrote.">
              Demo scenario: {view.scenario.label}
            </span>
          )}
        </div>
        <p className="case-header__role">
          Structured extraction of a supplier price note, from SettleBack Demo Seller, for $1.00. Your Payment Agent checks the seller's quote; your wallet authorizes the payment
          {live ? ", and HSP's gateway executes it on HSK Chain testnet." : "."}
        </p>
        <ol className="stepper" aria-label="Purchase progress">
          {STAGES.map((stage, index) => {
            const status = index < current || (index === current && finished) ? "done" : index === current ? "current" : "todo";
            return (
              <li key={stage.id} className={`stepper__item stepper__item--${status}`} aria-current={status === "current" ? "step" : undefined}>
                <span className="stepper__index">{status === "done" ? "✓" : index + 1}</span>
                {stage.label}
              </li>
            );
          })}
        </ol>
      </header>

      {message !== null && !finished && (
        <div className={`notice notice--${message.tone === "done" ? "done" : message.tone === "attention" ? "attention" : "neutral"}`} role="status">
          {message.text}
        </div>
      )}
      {purchase.error !== undefined && <p className="inline-error">Could not refresh the purchase: {describeError(purchase.error)}</p>}

      <div className="buy">
        <div className="buy__main">
          {operationId === null ? (
            <Start live={live} scenario={scenario} onScenario={setScenario} onQuote={() => void quote()} busy={working !== null || wallet === null} working={working === "quote"} />
          ) : view === null ? (
            purchase.error === undefined ? (
              <p className="empty panel">Loading the purchase…</p>
            ) : (
              // A purchase this server no longer knows, for example after a restart, cannot be resumed here.
              <div className="empty panel">
                <p>This purchase cannot be loaded from the server.</p>
                <button type="button" className="button button--quiet" onClick={startOver}>
                  Start another purchase
                </button>
              </div>
            )
          ) : (
            <>
              <Completed view={view} current={current} />
              <Current
                view={view}
                working={working}
                canAct={wallet !== null && working === null}
                onAuthorize={() => void authorize()}
                onViewCase={onViewCase}
                review={
                  pending === null ? null : (
                    <AuthorizationReview
                      pending={pending}
                      decimals={view.payments.tokenDecimals}
                      symbol={view.payments.coin}
                      busy={working !== null}
                      working={working === "sign" ? "sign" : working === "submit" ? "submit" : null}
                      onSign={() => void signPending()}
                      onSubmit={() => void submitPending()}
                      onCancel={() => setPending(null)}
                    />
                  )
                }
              />
              {finished && (
                <button type="button" className="button button--quiet buy__again" onClick={startOver}>
                  Start another purchase
                </button>
              )}
            </>
          )}
        </div>
        <Summary view={view} live={live} registryLive={registryLive} registryChainId={health.registry.status === "connected" ? health.registry.chainId : null} />
      </div>
    </section>
  );
}

function Start({ live, scenario, onScenario, onQuote, busy, working }: { live: boolean; scenario: string; onScenario: (value: string) => void; onQuote: () => void; busy: boolean; working: boolean }) {
  return (
    <section className="panel" aria-labelledby="start-title">
      <h2 id="start-title">Get a quote</h2>
      <p className="actor">Seller's receiving agent</p>
      <p>
        {live
          ? "The seller's agent creates an HSP order for this job: price, token, chain, recipient, and expiry. HSP signs the cart for the team. Nothing is signed or paid yet."
          : "The seller's agent answers with a merchant-signed Cart Mandate for this job: price, token, chain, recipient, and expiry. Nothing is signed or paid yet."}
      </p>
      <label className="field">
        <span className="field__label">Demo scenario</span>
        <select value={scenario} onChange={(event) => onScenario(event.target.value)} disabled={busy}>
          {SCENARIOS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="field__hint">What goes wrong is injected into the demo's job service before you pay. The case only ever receives the records the service actually writes.</span>
      </label>
      <div className="action">
        <button type="button" className="button" disabled={busy} onClick={onQuote}>
          {working ? "Requesting a quote…" : "Request a quote"}
        </button>
      </div>
    </section>
  );
}

function Checks({ checks }: { checks: PurchaseCheck[] }) {
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.id} className={`check check--${check.status}`}>
          <span className="check__status">{CHECK_STATUS[check.status]}</span>
          <span className="check__label">
            {check.label}
            {check.reason !== null && <span className="check__reason">{check.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Completed({ view, current }: { view: PurchaseView; current: number }) {
  const passed = view.checks.filter((check) => check.status === "passed").length;
  const live = view.payments.gateway === "hsp-agentic";
  const transferLink = view.payment?.txHash ? explorerLink(view.payments.chainId, "tx", view.payment.txHash) : null;
  return (
    <>
      {current > 0 && (
        <details className="stage-summary">
          <summary>
            <span className="stage-summary__title">Review quote</span> {passed} of {view.checks.length} checks passed
          </summary>
          <Checks checks={view.checks} />
        </details>
      )}
      {current > 1 && view.quote !== null && (
        <details className="stage-summary">
          <summary>
            <span className="stage-summary__title">Authorize</span> signed in your wallet{view.signatureSubmittedAt === null ? "" : ` at ${time(view.signatureSubmittedAt)}`}
          </summary>
          <dl className="facts facts--stacked">
            <div>
              <dt>{live ? "Authorization" : "Mandate"}</dt>
              <dd>
                {live
                  ? "EIP-3009 TransferWithAuthorization prepared by HSP and checked by your Payment Agent; HSP built the AP2 Payment Mandate from your signature"
                  : "AP2 Payment Mandate (simulated format) carrying an EIP-3009 TransferWithAuthorization"}
              </dd>
            </div>
            {view.authorization !== null && (
              <div>
                <dt>Authorized amount</dt>
                <dd>
                  <code>{view.authorization.amountBaseUnits}</code> raw units
                </dd>
              </div>
            )}
            {view.quote.flowId !== null && (
              <div>
                <dt>HSP flow</dt>
                <dd>
                  <code>{view.quote.flowId}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Payment request</dt>
              <dd>
                <code>{view.quote.paymentRequestId}</code>
              </dd>
            </div>
            <div>
              <dt>Cart hash</dt>
              <dd>
                <code title={view.quote.cartSha256}>{short(view.quote.cartSha256, 10)}</code>
              </dd>
            </div>
          </dl>
        </details>
      )}
      {current > 2 && view.payment !== null && (
        <details className="stage-summary">
          <summary>
            <span className="stage-summary__title">Payment</span> {paymentStatus(view)}
          </summary>
          <dl className="facts facts--stacked">
            <div>
              <dt>Transfer</dt>
              <dd>
                {view.payment.txHash === null ? (
                  "—"
                ) : live ? (
                  <>
                    <code title={view.payment.txHash}>{short(view.payment.txHash, 10)}</code>{" "}
                    {transferLink !== null && (
                      <a href={transferLink} target="_blank" rel="noreferrer">
                        View on explorer
                      </a>
                    )}
                  </>
                ) : (
                  <code title={view.payment.txHash}>{short(view.payment.txHash, 10)} (simulated chain)</code>
                )}
              </dd>
            </div>
          </dl>
        </details>
      )}
    </>
  );
}

function paymentStatus(view: PurchaseView): string {
  const state = view.payment?.state;
  const live = view.payments.gateway === "hsp-agentic";
  if (state === "VERIFIED") return live ? "Verified: HSP's record and the transfer on HSK Chain testnet agree" : "Simulated payment verified on the gateway and its chain";
  if (state === "UNKNOWN") return "Payment outcome unknown";
  if (state === "OBSERVED") return live ? "Transfer included on HSK Chain testnet; waiting for HSP's final confirmation" : "Transfer observed on the simulated chain; waiting for finality";
  if (state === "SUBMITTED") return live ? "HSP accepted the payment; waiting for the transfer" : "The gateway accepted the mandate";
  if (state === "SIGNING_REQUESTED" && view.signatureSubmittedAt !== null) return live ? "Submitted to HSP" : "Submitted to the gateway (simulated)";
  return state === undefined ? "Not started" : stateLabel(state);
}

/** The payment's state in a few words, for the order summary. */
function paymentShort(view: PurchaseView | null): string {
  const state = view?.payment?.state;
  if (view === null || state === undefined) return "Not started";
  if (state === "VERIFIED") return view.payments.gateway === "hsp-agentic" ? "Verified on chain" : "Verified (simulated)";
  if (state === "UNKNOWN") return "Outcome unknown";
  if (state === "OBSERVED") return "Observed, awaiting finality";
  if (state === "SUBMITTED") return "Accepted by the gateway";
  if (state === "SIGNING_REQUESTED") return view.signatureSubmittedAt === null ? "Awaiting your signature" : view.payments.gateway === "hsp-agentic" ? "Submitted to HSP" : "Submitted (simulated)";
  return stateLabel(state);
}

function Current({
  view,
  working,
  canAct,
  onAuthorize,
  onViewCase,
  review,
}: {
  view: PurchaseView;
  working: string | null;
  canAct: boolean;
  onAuthorize: () => void;
  onViewCase: (caseId: string) => void;
  review: ReactNode;
}) {
  const live = view.payments.gateway === "hsp-agentic";
  if (live && (view.stage === "review" || view.stage === "authorize")) {
    const blocked = view.checks.some((check) => check.status === "blocked");
    return (
      <section className="panel" aria-labelledby="stage-title">
        <h2 id="stage-title">{review === null ? "Review the quote" : "Review HSP's authorization"}</h2>
        <p className="actor">Your Payment Agent's checks</p>
        <Checks checks={view.checks} />
        <p className="panel__aside">
          HSP signs carts for hackathon teams and holds those keys, so there is no seller key to pin. Instead your agent checks every field of the authorization HSP prepares against this order and this buyer's spending limits, before your wallet sees it.
        </p>
        {review ?? (
          <div className="action">
            {blocked ? (
              <p className="action__why inline-error">A check failed, so nothing can be signed.</p>
            ) : (
              <p className="action__why">HSP prepares an EIP-3009 authorization for this order. Your agent checks it, then shows you the recipient, payer, and exact amount before anything is signed.</p>
            )}
            <button type="button" className="button" disabled={!canAct || blocked} onClick={onAuthorize}>
              {working === "authorize" ? "HSP is preparing the authorization…" : "Prepare authorization"}
            </button>
          </div>
        )}
      </section>
    );
  }
  if (view.stage === "review" || view.stage === "authorize") {
    const blocked = view.checks.some((check) => check.status !== "passed");
    return (
      <section className="panel" aria-labelledby="stage-title">
        <h2 id="stage-title">{view.stage === "review" ? "Review the quote" : "Authorize in your wallet"}</h2>
        <p className="actor">Your Payment Agent checked the seller's Cart Mandate</p>
        <Checks checks={view.checks} />
        <p className="panel__aside">The merchant key is the demo seller's, pinned by your agent before the quote. The limits are this demo buyer's spending policy.</p>
        <div className="action">
          {blocked ? (
            <p className="action__why inline-error">The quote failed a check, so nothing can be signed.</p>
          ) : (
            <p className="action__why">
              Your agent prepared the payment. Your wallet authorizes the displayed amount and recipient as an EIP-3009 authorization inside an AP2 Payment Mandate. Signing permits one submission; it is not settlement.
            </p>
          )}
          <button type="button" className="button" disabled={!canAct || blocked} onClick={onAuthorize}>
            {working === "authorize" ? "Waiting for your wallet…" : view.stage === "review" ? "Authorize payment" : "Sign in your wallet"}
          </button>
        </div>
      </section>
    );
  }

  if (view.stage === "payment") {
    const unknown = view.payment?.state === "UNKNOWN";
    return (
      <section className="panel" aria-labelledby="stage-title">
        <h2 id="stage-title">Payment</h2>
        <p className="actor">{live ? "HSP Agentic Payment gateway · HSK Chain testnet" : "Payment gateway (simulated)"}</p>
        <p className={unknown ? "chip chip--attention" : "chip chip--pending"}>{paymentStatus(view)}</p>
        {unknown ? (
          <p>The job will not start. The attempt is reconciled from the gateway and the chain and is never paid twice.</p>
        ) : (
          <p className="panel__aside">The job starts only after the gateway record and the transfer on its chain agree.</p>
        )}
      </section>
    );
  }

  const outcome = view.events.find((event) => event.kind === "case-opened" || event.kind === "delivered");
  const errored = view.events.some((event) => event.kind === "error-response");
  return (
    <section className="panel" aria-labelledby="stage-title">
      <h2 id="stage-title">Job</h2>
      <p className="actor">Seller's job service</p>
      <ol className="trail">
        {view.events.map((event) => (
          <li key={event.kind + event.at} className={`trail__item trail__item--${event.kind === "payment-unknown" || event.kind === "error-response" || event.kind === "deadline-passed" ? "attention" : "done"}`}>
            <span className="trail__label">{EVENT_LABELS[event.kind]}</span>
            <time dateTime={event.at}>{time(event.at)}</time>
          </li>
        ))}
        {outcome === undefined && view.run !== null && (
          <li className="trail__item trail__item--pending">
            <span className="trail__label">Waiting for the job's response</span>
            <span className="panel__aside">deadline {time(view.run.deadlineAt)}</span>
          </li>
        )}
      </ol>
      {view.caseId !== null && (
        <div className="notice notice--attention outcome">
          <p>
            {errored ? "The service answered with an error and no result." : "No response received by the deadline."} A recovery case has been opened.
            {errored ? "" : " The job may still be running."}
          </p>
          <button type="button" className="button" onClick={() => onViewCase(view.caseId ?? "")}>
            View case
          </button>
        </div>
      )}
      {outcome?.kind === "delivered" && <div className="notice notice--done outcome">The result was delivered. No case was needed.</div>}
    </section>
  );
}

function Summary({ view, live, registryLive, registryChainId }: { view: PurchaseView | null; live: boolean; registryLive: boolean; registryChainId: number | null }) {
  return (
    <aside className="panel buy__summary" aria-label="Order summary">
      <h2>Order</h2>
      <dl className="facts facts--stacked">
        <div>
          <dt>Job</dt>
          <dd>Structured extraction</dd>
        </div>
        <div>
          <dt>Seller</dt>
          <dd>SettleBack Demo Seller{view === null ? "" : ` · ${short(view.job.seller, 4)}`}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>$1.00 · {usdc(view?.job.amountBaseUnits ?? "1000000")}</dd>
        </div>
        <div>
          <dt>Maximum fee</dt>
          <dd>{usdc(view?.quote?.maxFeeBaseUnits ?? "100000")}</dd>
        </div>
        <div>
          <dt>Gross ceiling</dt>
          <dd>{view?.quote?.grossLimitBaseUnits ? usdc(view.quote.grossLimitBaseUnits) : "—"}</dd>
        </div>
        <div>
          <dt>Asset</dt>
          <dd>USDC on {networkName(view?.job.chainId ?? 133)}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{paymentShort(view)}</dd>
        </div>
        {view?.quote && (
          <div>
            <dt>Quote expires</dt>
            <dd>{when(view.quote.expiresAt)}</dd>
          </div>
        )}
      </dl>
      <ul className="provenance">
        {live ? (
          <li className="badge badge--live">Payments: HSP Agentic Payment on HSK Chain testnet</li>
        ) : (
          <li className="badge badge--simulated">Payment gateway and payment chain: simulated</li>
        )}
        <li className={registryLive ? "badge badge--live" : "badge"}>Recovery registry: {registryLive && registryChainId !== null ? networkName(registryChainId) : "local chain (simulated)"}</li>
      </ul>
    </aside>
  );
}

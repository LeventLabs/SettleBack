import { useState } from "react";
import { api, retrieveResult, type DeliveredResult } from "./api.ts";
import type { Runner } from "./CaseWorkspace.tsx";
import { actionLabel, short, stateLabel, toneOf, when } from "./format.ts";
import type { ActionView, CaseView } from "./types.ts";
import { sendTransaction, signTypedData, switchChain, type WalletAccount } from "./wallet.ts";

const STEPS: Record<"RETRIEVE" | "REPAY", { state: string; label: string }[]> = {
  RETRIEVE: [
    { state: "PREPARED", label: "Prepared and registered" },
    { state: "RESERVED", label: "Reserved by the verifier" },
    { state: "EXECUTION_REQUESTED", label: "Delivered to the buyer" },
    { state: "DELIVERY_ACKED", label: "Receipt acknowledged" },
    { state: "RECORD_PENDING", label: "Registry record pending" },
    { state: "COMPLETED", label: "Recorded as recovered" },
  ],
  REPAY: [
    { state: "PREPARED", label: "Prepared and registered" },
    { state: "RESERVED", label: "Reserved by the seller" },
    { state: "EXECUTION_REQUESTED", label: "Repayment requested" },
    { state: "VERIFIED", label: "Transfer verified" },
    { state: "RECORD_PENDING", label: "Registry record pending" },
    { state: "COMPLETED", label: "Recorded as repaid" },
  ],
};

interface ApprovalOutcome {
  status: "CONFIRMED" | "PENDING" | "REJECTED";
  reason?: string;
}

/** The one recovery a case may have: its fixed terms, where it stands, and the next step for the signed-in party. */
export function RecoveryPanel({ data, wallet, runner }: { data: CaseView; wallet: WalletAccount | null; runner: Runner }) {
  const action = data.recoveryAction;
  const isSeller = data.relations.includes("seller");
  const canPrepare = isSeller || data.relations.includes("operator");

  async function prepare() {
    await runner.run("prepare", async () => {
      const prepared = await api<{ action: ActionView; policyGaps: string[] }>(`/api/cases/${encodeURIComponent(data.id)}/recovery/prepare`, { method: "POST", wallet });
      const gaps = prepared.policyGaps.length > 0 ? ` The seller's standing policy did not cover it: ${prepared.policyGaps.join("; ")}.` : "";
      return `${actionLabel(prepared.action.action)} prepared and registered on the registry (${stateLabel(prepared.action.state)}).${gaps}`;
    });
  }

  return (
    <section className="panel" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Recovery</h2>
      {action === null ? (
        <>
          <p className="empty">No recovery is prepared. A case gets at most one, fixed before anyone approves it.</p>
          {canPrepare ? (
            <div className="action">
              <p className="action__why">Eligibility is recomputed from the current evidence. Preparing registers the case and its terms on the registry; it does not move money.</p>
              <button type="button" className="button" disabled={runner.working !== null || wallet === null} onClick={() => void prepare()}>
                {runner.working === "prepare" ? "Preparing…" : "Prepare recovery"}
              </button>
            </div>
          ) : (
            <p className="panel__aside">The seller or an operator prepares the recovery.</p>
          )}
        </>
      ) : (
        <>
          <Terms data={data} action={action} />
          <Steps action={action} />
          <NextStep data={data} action={action} wallet={wallet} runner={runner} isSeller={isSeller} />
          <References data={data} action={action} />
        </>
      )}
    </section>
  );
}

function Terms({ data, action }: { data: CaseView; action: ActionView }) {
  const { proposal } = action;
  const expired = Date.parse(proposal.deadline) <= Date.now();
  return (
    <dl className="facts facts--stacked">
      <div>
        <dt>Action</dt>
        <dd>
          {actionLabel(action.action)} <span className="panel__aside">({proposal.basis.toLowerCase().replaceAll("_", " ")})</span>
        </dd>
      </div>
      {proposal.transfer !== null && (
        <div>
          <dt>Exact transfer</dt>
          <dd>
            ${data.operation.priceUsd} ({proposal.transfer.amountBaseUnits} base units) from {short(proposal.transfer.payer, 4)} to the buyer {short(proposal.transfer.payee, 4)}, chain {proposal.transfer.chainId}
          </dd>
        </div>
      )}
      {proposal.artifactSha256 !== null && (
        <div>
          <dt>Artifact</dt>
          <dd>SHA-256 {short(proposal.artifactSha256)}</dd>
        </div>
      )}
      <div>
        <dt>Authority</dt>
        <dd>{proposal.authorization === null ? "Verifier (no money moves)" : proposal.authorization.mode === "PER_CASE" ? "Seller's explicit per-case approval" : `Seller's standing policy, version ${proposal.authorization.version}`}</dd>
      </div>
      <div>
        <dt>Deadline</dt>
        <dd className={expired && action.state === "PREPARED" ? "inline-error" : undefined}>
          {when(proposal.deadline)}
          {expired && action.state === "PREPARED" ? " · expired, cannot execute" : ""}
        </dd>
      </div>
      <div>
        <dt>Registry case</dt>
        <dd>
          {short(proposal.caseKey)} on chain {proposal.registry.chainId}
        </dd>
      </div>
    </dl>
  );
}

function Steps({ action }: { action: ActionView }) {
  const steps = STEPS[action.action];
  const current = steps.findIndex((step) => step.state === action.state);
  if (action.state === "STRANDED") return <p className="chip chip--attention">Stranded by an operator; it will never execute.</p>;
  return (
    <ol className="steps" aria-label="Recovery progress">
      {steps.map((step, index) => {
        const status = index < current || (index === current && action.state === "COMPLETED") ? "done" : index === current ? "current" : "todo";
        return (
          <li key={step.state} className={`steps__item steps__item--${status}`} aria-current={status === "current" ? "step" : undefined}>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function NextStep({ data, action, wallet, runner, isSeller }: { data: CaseView; action: ActionView; wallet: WalletAccount | null; runner: Runner; isSeller: boolean }) {
  const isBuyer = data.relations.includes("buyer");
  const [reported, setReported] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<DeliveredResult | null>(null);
  const base = `/api/cases/${encodeURIComponent(data.id)}`;
  const busy = runner.working !== null || wallet === null;

  async function approve() {
    const call = data.sellerCall;
    if (call === null || wallet === null) return;
    await runner.run("approve", async () => {
      const txHash = reported ?? (await sendTransaction(wallet, call));
      setReported(txHash);
      return confirmApproval(txHash);
    });
  }

  async function confirmApproval(txHash: string): Promise<string> {
    // The chain decides: a reported reservation counts only once it is mined and matches the case.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const outcome = await api<ApprovalOutcome>(`${base}/recovery/approval-tx`, { method: "POST", body: { txHash }, wallet });
      if (outcome.status === "CONFIRMED") {
        setReported(null);
        return "The registry confirmed your reservation. The repayment can now be paid.";
      }
      if (outcome.status === "REJECTED") {
        setReported(null);
        throw new Error(`The reservation was not accepted: ${outcome.reason ?? "no reason given"}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return "The reservation is not mined yet. Check again in a moment.";
  }

  async function repay() {
    if (wallet === null) return;
    await runner.run("repay", async () => {
      const requested = await api<{ status: string; typedData?: { domain: { chainId: number } } }>(`${base}/recovery/repay`, { method: "POST", wallet });
      if (requested.status !== "SIGNATURE_REQUIRED" || requested.typedData === undefined) return "This repayment was already submitted; it is not paid twice.";
      // The authorization names the payment chain; wallets sign typed data only on the chain its domain names.
      const paymentChain = requested.typedData.domain.chainId;
      if (wallet.chainId !== paymentChain) await switchChain(paymentChain);
      const signer = { ...wallet, chainId: paymentChain };
      // The wallet signs an EIP-3009 authorization of exactly this transfer; the server checks it before submitting.
      const signature = await signTypedData(signer, requested.typedData);
      const outcome = await api<{ status: string; reason?: string }>(`${base}/recovery/repay/signature`, { method: "POST", body: { signature }, wallet: signer });
      if (outcome.status === "SUBMITTED") return "Your authorization was submitted once. The case closes after the transfer is final on chain and the registry records it.";
      if (outcome.status === "ALREADY_REQUESTED") return "This authorization was already submitted; it is not paid twice.";
      return { tone: "attention", text: `The submission's outcome is unknown (${outcome.reason ?? "no reason given"}). It is reconciled from the gateway and the chain, never paid twice.` };
    });
  }

  async function retrieve() {
    if (wallet === null) return;
    await runner.run("retrieve", async () => {
      setDelivered(await retrieveResult(data.operationId, wallet));
      return "The result arrived. Check the digest your browser computed before acknowledging it.";
    });
  }

  async function acknowledge() {
    if (delivered === null) return;
    await runner.run("acknowledge", async () => {
      const outcome = await api<{ outcome: { status: string; reason?: string } }>(`/api/operations/${encodeURIComponent(data.operationId)}/result/ack`, {
        method: "POST",
        body: { artifactSha256: delivered.computedSha256 },
        wallet,
      });
      return outcome.outcome.status === "RECORDED" ? "Receipt acknowledged and recorded on the registry. The case is recovered." : `Receipt acknowledged; the registry record is pending (${outcome.outcome.reason ?? "retrying"}).`;
    });
  }

  if (action.action === "REPAY") {
    if (action.state === "PREPARED" && action.authorizationMode === "STANDING_POLICY") return <p className="panel__aside">Waiting for the seller's delegate to reserve the repayment under the active policy.</p>;
    if (action.state === "PREPARED" && isSeller && data.sellerCall !== null) {
      const call = data.sellerCall;
      const wrongChain = wallet !== null && wallet.chainId !== call.chainId;
      return (
        <div className="action">
          <p className="action__why">
            Approve this exact repayment by reserving it on the registry from your own wallet. Your wallet will show a call to the registry {short(call.to, 4)} on chain {call.chainId}. No funds move in this step.
          </p>
          {wrongChain && <p className="inline-error">Switch your wallet to chain {call.chainId} first.</p>}
          <button type="button" className="button" disabled={busy || wrongChain} onClick={() => void approve()}>
            {runner.working === "approve" ? "Waiting for the wallet and the chain…" : reported === null ? "Approve in wallet" : "Check the reservation again"}
          </button>
        </div>
      );
    }
    if (action.state === "PREPARED") return <p className="panel__aside">Waiting for the seller to approve the reservation from its wallet.</p>;
    const awaitingSignature = action.state === "EXECUTION_REQUESTED" && data.repayment?.state === "SIGNING_REQUESTED";
    if ((action.state === "RESERVED" || awaitingSignature) && isSeller) {
      return (
        <div className="action">
          <p className="action__why">
            Pay a new transfer of ${data.operation.priceUsd} from your account to the buyer who paid. Your wallet signs an EIP-3009 authorization of exactly this amount, token, and recipient, inside
            an AP2 Payment Mandate. Its nonce lets the token execute it once, however often you sign or click. Your wallet switches to the payment chain ({data.operation.chainId}) to sign. The gateway that executes it is simulated in this local demo; the signature is real.
          </p>
          {awaitingSignature && <p className="panel__aside">The mandate is issued. If you already signed it, signing again cannot pay twice.</p>}
          <button type="button" className="button" disabled={busy} onClick={() => void repay()}>
            {runner.working === "repay" ? "Waiting for the wallet…" : awaitingSignature ? "Sign the repayment again" : "Pay the repayment"}
          </button>
        </div>
      );
    }
    if (action.state === "RESERVED") return <p className="panel__aside">Reserved. Waiting for the seller to pay the repayment.</p>;
    if (action.state !== "COMPLETED") {
      return (
        <p className={`chip chip--${toneOf(data.repayment?.state ?? action.state, false)}`}>
          Repayment {stateLabel(data.repayment?.state ?? action.state).toLowerCase()}. The case closes only after the transfer is final and the registry records it.
        </p>
      );
    }
    return <p className="chip chip--done">Repaid and recorded on the registry.</p>;
  }

  if (action.state === "PREPARED") return <p className="panel__aside">Waiting for the verifier's reservation on the registry.</p>;
  if ((action.state === "RESERVED" || action.state === "EXECUTION_REQUESTED") && isBuyer) {
    const expected = action.proposal.artifactSha256 ?? "";
    const matches = delivered !== null && delivered.computedSha256 === expected;
    return (
      <div className="action">
        <p className="action__why">Download the result that already exists. Nothing runs again and nothing is charged.</p>
        <button type="button" className="button" disabled={busy} onClick={() => void retrieve()}>
          {runner.working === "retrieve" ? "Downloading…" : delivered === null ? "Retrieve the result" : "Download again"}
        </button>
        {delivered !== null && (
          <>
            <dl className="facts facts--stacked">
              <div>
                <dt>Expected</dt>
                <dd>{short(expected, 10)}</dd>
              </div>
              <div>
                <dt>Computed here</dt>
                <dd className={matches ? undefined : "inline-error"}>
                  {short(delivered.computedSha256, 10)} {matches ? "· matches" : "· does not match; do not acknowledge"}
                </dd>
              </div>
            </dl>
            <pre className="result">{new TextDecoder().decode(delivered.bytes)}</pre>
            <button type="button" className="button" disabled={busy || !matches} onClick={() => void acknowledge()}>
              {runner.working === "acknowledge" ? "Recording…" : "Acknowledge receipt"}
            </button>
          </>
        )}
      </div>
    );
  }
  if (action.state === "RESERVED" || action.state === "EXECUTION_REQUESTED") return <p className="panel__aside">Waiting for the buyer to retrieve and acknowledge the result.</p>;
  if (action.state !== "COMPLETED") return <p className={`chip chip--${toneOf(action.state)}`}>{stateLabel(action.state)}. The registry outcome is retried automatically.</p>;
  return <p className="chip chip--done">Recovered and recorded on the registry.</p>;
}

function References({ data, action }: { data: CaseView; action: ActionView }) {
  const rows: [string, string][] = [];
  if (action.approvalTx !== null) rows.push([action.action === "RETRIEVE" ? "Verifier's reservation" : "Seller's reservation", action.approvalTx]);
  if (action.policyTx !== null) rows.push(["Delegate's reservation", action.policyTx]);
  if (data.repayment?.txHash) rows.push(["Repayment transfer (simulated chain)", data.repayment.txHash]);
  if (action.registryTx !== null) rows.push(["Registry outcome", action.registryTx]);
  if (rows.length === 0) return null;
  return (
    <dl className="facts facts--stacked references">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            <code title={value}>{short(value, 10)}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}


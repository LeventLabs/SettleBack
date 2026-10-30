import { useEffect, useState } from "react";
import { explorerLink, networkName, short } from "./format.ts";
import type { AuthorizationSummary, TypedData } from "./types.ts";

/** An authorization the server returned for the wallet, and the wallet's signature once it signs. */
export interface PendingAuthorization {
  typedData: TypedData;
  authorization: AuthorizationSummary;
  signature: string | null;
}

/** Raw token units as a decimal amount, without rounding. */
export function tokenAmount(baseUnits: string, decimals: number, symbol: string): string {
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${value / scale}.${fraction} ${symbol}`;
}

function secondsLeft(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const end = Date.parse(iso);
  return Number.isNaN(end) ? null : Math.max(0, Math.floor((end - now) / 1000));
}

/**
 * The authorization HSP prepared, shown before the wallet signs it and again before the signature
 * is submitted: recipient, payer, and the exact raw amount, each confirmed by a separate click, as
 * HSP's guide asks. Nothing moves until the second click; the gateway broadcasts after that.
 */
export function AuthorizationReview({
  pending,
  decimals,
  symbol,
  busy,
  working,
  onSign,
  onSubmit,
  onCancel,
}: {
  pending: PendingAuthorization;
  decimals: number;
  symbol: string;
  busy: boolean;
  working: "sign" | "submit" | null;
  onSign: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { authorization, typedData, signature } = pending;
  const left = secondsLeft(authorization.quoteExpiresAt, now);
  const expired = left !== null && left <= 30;
  const chainId = typedData.domain.chainId;
  const token = typedData.domain.verifyingContract;
  const tokenLink = explorerLink(chainId, "address", token);

  return (
    <div className="authorization">
      <p className="actor">{signature === null ? "Step 1 of 2 · sign in your wallet" : "Step 2 of 2 · submit to HSP"}</p>
      <dl className="facts facts--stacked">
        <div>
          <dt>Recipient</dt>
          <dd>
            <code title={authorization.recipient}>{authorization.recipient}</code>
          </dd>
        </div>
        <div>
          <dt>Payer</dt>
          <dd>
            <code title={authorization.payer}>{authorization.payer}</code>
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>
            <code>{authorization.amountBaseUnits}</code> raw units · {tokenAmount(authorization.amountBaseUnits, decimals, symbol)}
          </dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            {typedData.domain.name} on {networkName(chainId)} ·{" "}
            {tokenLink === null ? (
              <code>{short(token, 4)}</code>
            ) : (
              <a href={tokenLink} target="_blank" rel="noreferrer">
                <code>{short(token, 4)}</code>
              </a>
            )}
          </dd>
        </div>
        {left !== null && (
          <div>
            <dt>Quote</dt>
            <dd className={expired ? "inline-error" : undefined}>{expired ? "Expired or about to expire; prepare a new authorization." : `valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</dd>
          </div>
        )}
      </dl>
      <div className="action">
        {signature === null ? (
          <p className="action__why">
            HSP prepared this EIP-3009 authorization and your Payment Agent checked every field against the order. Your wallet signs exactly it. Signing alone moves nothing.
          </p>
        ) : (
          <p className="action__why">Signed. Confirm the recipient, payer, and amount once more: submitting hands the signature to HSP, whose gateway broadcasts the transfer. It is submitted once.</p>
        )}
        <div className="action__buttons">
          {signature === null ? (
            <button type="button" className="button" disabled={busy || expired} onClick={onSign}>
              {working === "sign" ? "Waiting for your wallet…" : "Sign in your wallet"}
            </button>
          ) : (
            <button type="button" className="button" disabled={busy || expired} onClick={onSubmit}>
              {working === "submit" ? "Submitting to HSP…" : "Submit to HSP"}
            </button>
          )}
          <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
            {expired ? "Prepare a new one" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

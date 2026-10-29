import { useCallback, useEffect, useState } from "react";
import { ApiError, api, describeError } from "./api.ts";
import { CaseList } from "./CaseList.tsx";
import { CaseWorkspace } from "./CaseWorkspace.tsx";
import { explorerLink, networkName, short } from "./format.ts";
import type { Health, Session, SignInChallenge } from "./types.ts";
import { connectWallet, currentAccount, hasWallet, signMessage, watchWallet, type WalletAccount } from "./wallet.ts";

type Loadable<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "unavailable"; reason: string };

/** The registry is labeled live only on HSK Chain, where it links to the explorer; a disposable chain is labeled by its ID. */
function RegistryBadge({ chainId, address, live }: { chainId: number; address: string; live: boolean }) {
  const text = live ? `Registry live on ${networkName(chainId)} · ${short(address, 4)}` : `Registry ${short(address, 4)} · chain ${chainId}`;
  const link = explorerLink(chainId, "address", address);
  return (
    <span className={live ? "badge badge--live" : "badge"} title={address}>
      {link === null ? text : <a href={link} target="_blank" rel="noreferrer">{text}</a>}
    </span>
  );
}

export function App() {
  const [health, setHealth] = useState<Loadable<Health>>({ status: "loading" });
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [wallet, setWallet] = useState<WalletAccount | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api<Health>("/api/health").then(
      (value) => setHealth({ status: "ready", value }),
      (error: unknown) => setHealth({ status: "unavailable", reason: describeError(error) }),
    );
    api<Session>("/api/auth/session").then(setSession, (error: unknown) => {
      setSession(null);
      if (!(error instanceof ApiError && error.status === 401)) setNotice(describeError(error));
    });
    currentAccount().then(setWallet, () => setWallet(null));
  }, []);

  const signOut = useCallback(async (reason?: string) => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      setSession(null);
      setSelected(null);
      if (reason !== undefined) setNotice(reason);
    }
  }, []);

  // A different account in the wallet ends the session: nothing approved under it may carry over.
  useEffect(
    () =>
      watchWallet(
        (address) => {
          setWallet((previous) => (address === null ? null : { address, chainId: previous?.chainId ?? 0 }));
          if (session !== null && session !== undefined && address !== session.address) void signOut("The wallet's account changed, so you were signed out. Sign in again with the account you want to use.");
        },
        (chainId) => setWallet((previous) => (previous === null ? null : { ...previous, chainId })),
      ),
    [session, signOut],
  );

  const mismatch = session !== null && session !== undefined && wallet !== null && wallet.address !== session.address;

  async function signIn() {
    setBusy(true);
    setNotice(null);
    try {
      const account = await connectWallet();
      setWallet(account);
      const issued = await api<SignInChallenge>("/api/auth/challenge", { method: "POST", body: { address: account.address, chainId: account.chainId } });
      const signature = await signMessage(account, issued.message);
      setSession(await api<Session>("/api/auth/verify", { method: "POST", body: { challenge: issued.challenge, signature } }));
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const ready = health.status === "ready" ? health.value : undefined;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__name">SettleBack</span>
          <span className="brand__tagline">Recovery for paid agent jobs</span>
        </div>
        <div className="topbar__network" aria-label="Network">
          {health.status === "loading" && <span className="badge">Checking server…</span>}
          {health.status === "unavailable" && <span className="badge badge--attention">Server unavailable</span>}
          {ready !== undefined && (
            <>
              <span className={ready.mode === "simulated" ? "badge badge--simulated" : "badge badge--live"}>{ready.mode === "simulated" ? "Simulation · no real funds" : "Live"}</span>
              <span className="badge">{ready.networkLabel}</span>
              {ready.registry.status === "connected" ? <RegistryBadge chainId={ready.registry.chainId} address={ready.registry.address} live={ready.registry.provenance === "LIVE"} /> : <span className="badge">No registry</span>}
              <span className={ready.paymentWrites === "enabled" ? "badge" : "badge badge--muted"}>Payment writes {ready.paymentWrites}</span>
            </>
          )}
        </div>
        <div className="topbar__account">
          {session ? (
            <>
              <span className="account" title={session.address}>
                {short(session.address, 4)}
                {session.roles.includes("operator") ? " · operator" : ""}
                {wallet !== null && ` · chain ${wallet.chainId}`}
              </span>
              <button type="button" className="button button--quiet" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => void signIn()} disabled={busy || session === undefined || !hasWallet()}>
              {busy ? "Waiting for wallet…" : "Sign in with wallet"}
            </button>
          )}
        </div>
      </header>

      {notice !== null && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" className="button button--quiet" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {mismatch && (
        <div className="notice notice--attention" role="alert">
          The wallet is on {short(wallet.address, 4)}, but you signed in as {short(session.address, 4)}.{" "}
          <button type="button" className="button button--quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}

      {session === undefined && <p className="empty">Loading…</p>}
      {session === null && <SignedOut walletAvailable={hasWallet()} />}
      {session && ready !== undefined && (
        <main className="layout">
          <CaseList session={session} selected={selected} onSelect={setSelected} />
          {selected === null ? (
            <section className="workspace workspace--empty" aria-label="Case workspace">
              <p>Select a case to see its payment, execution, and delivery records and what can be done next.</p>
            </section>
          ) : (
            <CaseWorkspace key={selected} caseId={selected} session={session} wallet={mismatch ? null : wallet} health={ready} />
          )}
        </main>
      )}
    </div>
  );
}

function SignedOut({ walletAvailable }: { walletAvailable: boolean }) {
  return (
    <main className="signed-out">
      <h1>Recover a paid agent job</h1>
      <p>
        SettleBack reconciles the payment, execution, and delivery records of a paid job. It delivers a result that already exists, coordinates a separate repayment the seller
        approves from its own wallet, or leaves the case explicitly unresolved. Model output never authorizes a transfer.
      </p>
      <p>Sign in with the wallet of the buyer, the seller, or an operator. Signing in proves you control the account; it authorizes no payment or transaction.</p>
      {!walletAvailable && <p className="notice notice--attention">No browser wallet was found. Install one, such as MetaMask, and reload.</p>}
    </main>
  );
}

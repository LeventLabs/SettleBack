import { useEffect, useState } from "react";

interface Health {
  environment: string;
  mode: "simulated" | "live";
  networkLabel: string;
  paymentWrites: "enabled" | "disabled";
}

type HealthState =
  | { status: "loading" }
  | { status: "ready"; health: Health }
  | { status: "unavailable"; reason: string };

function isHealth(value: unknown): value is Health {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.environment === "string" &&
    (record.mode === "simulated" || record.mode === "live") &&
    typeof record.networkLabel === "string" &&
    (record.paymentWrites === "enabled" || record.paymentWrites === "disabled")
  );
}

export function App() {
  const [state, setState] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (!isHealth(body)) throw new Error("Unexpected health response");
        setState({ status: "ready", health: body });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <header className="shell__header">
        <h1>SettleBack</h1>
        <p className="shell__tagline">Recovery for paid agent jobs.</p>
      </header>
      <section aria-live="polite" className="shell__status">
        {state.status === "loading" && <p>Checking server…</p>}
        {state.status === "unavailable" && (
          <p className="status status--unavailable">Server unavailable: {state.reason}</p>
        )}
        {state.status === "ready" && (
          <dl className="status">
            <dt>Mode</dt>
            <dd>
              <span className={state.health.mode === "simulated" ? "badge badge--simulated" : "badge"}>
                {state.health.mode === "simulated" ? "Simulation, no real funds" : "Live"}
              </span>
            </dd>
            <dt>Network</dt>
            <dd>
              <span className="badge">{state.health.networkLabel}</span>
            </dd>
            <dt>Payment writes</dt>
            <dd>{state.health.paymentWrites}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}

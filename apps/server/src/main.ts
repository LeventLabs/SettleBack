import { buildApp } from "./app.ts";
import { loadConfig, type HspConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { startHspDemoWorld } from "./demo/hsp-world.ts";
import { startDemoWorld } from "./demo/world.ts";
import { startReconciler } from "./payments/reconciler.ts";
import { ClaudeAssessmentProvider } from "./recovery/claude-provider.ts";
import { connectRegistry } from "./registry/connect.ts";

// Also HSP's guidance for querying a payment's status.
const RECONCILE_INTERVAL_MS = 15_000;
// The demo moves faster so a person watching sees payments settle within seconds.
const DEMO_RECONCILE_INTERVAL_MS = 3_000;
const DEMO_GATEWAY_TICK_MS = 1_000;

const config = loadConfig();
const db = openDatabase({ path: config.databasePath, environment: config.environment });
// A configured but unreachable or mismatched registry stops startup instead of running without it.
const registry = await connectRegistry(config.registry);
// The app's logger exists only after buildApp, so the demo world reports through this indirection.
let reportDemoError = (error: unknown): void => console.error(error);
const onDemoError = (error: unknown): void => reportDemoError(error);
const demo =
  config.demo === undefined
    ? undefined
    : config.demo.kind === "hsp-testnet"
      ? await startHspDemoWorld(db, { parties: config.demo, hsp: requireHsp(config.hsp), tickMs: DEMO_GATEWAY_TICK_MS, onError: onDemoError })
      : await startDemoWorld(db, { parties: config.demo, tickMs: DEMO_GATEWAY_TICK_MS, onError: onDemoError });
const apiKey = config.assessment.apiKey;
const provider = apiKey === undefined ? undefined : new ClaudeAssessmentProvider({ ...config.assessment, apiKey: apiKey.reveal() });
const app = buildApp(config, { db, registry, provider, terms: demo?.terms, lookup: demo?.lookup, payments: demo?.payments, purchases: demo?.purchases });
reportDemoError = (error) => app.log.error(error, "demo purchase step failed");
if (config.demo?.kind === "fixtures" && demo !== undefined) app.log.info({ cases: demo.cases, buyer: config.demo.buyer, seller: config.demo.seller }, "demo cases seeded (simulated, in memory)");
if (config.demo?.kind === "hsp-testnet") app.log.info({ seller: config.demo.seller, merchantName: config.hsp?.merchantName }, "HSP testnet demo ready: purchases and repayments pay through HSP Agentic Payment");
// Outside the demo no payment rail is configured yet, so the passes retry pending registry outcomes only.
const reconciler = startReconciler({
  db,
  rail: demo?.rail,
  registry,
  now: () => new Date(),
  requiredLevel: "FINAL",
  intervalMs: config.demo?.kind === "fixtures" ? DEMO_RECONCILE_INTERVAL_MS : RECONCILE_INTERVAL_MS,
  onRun: (run) => {
    for (const item of [...run.attempts, ...run.outcomes]) if (item.error !== undefined) app.log.warn(item, "reconciliation item failed");
  },
  onError: (error) => app.log.error(error, "reconciliation pass failed"),
});
app.addHook("onClose", async () => {
  demo?.stop();
  await reconciler.stop();
  db.close();
});

function requireHsp(hsp: HspConfig | undefined): HspConfig {
  if (hsp === undefined) throw new Error("the HSP testnet demo has no HSP configuration");
  return hsp;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ databasePath: config.databasePath }, "database ready");
} catch (error) {
  app.log.error(error, "failed to start");
  process.exit(1);
}

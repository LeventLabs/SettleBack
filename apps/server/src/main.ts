import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { startDemoWorld } from "./demo/world.ts";
import { startReconciler } from "./payments/reconciler.ts";
import { ClaudeAssessmentProvider } from "./recovery/claude-provider.ts";
import { connectRegistry } from "./registry/connect.ts";

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
const demo = config.demo === undefined ? undefined : await startDemoWorld(db, { parties: config.demo, tickMs: DEMO_GATEWAY_TICK_MS, onError: (error) => reportDemoError(error) });
const apiKey = config.assessment.apiKey;
const provider = apiKey === undefined ? undefined : new ClaudeAssessmentProvider({ ...config.assessment, apiKey: apiKey.reveal() });
const app = buildApp(config, { db, registry, provider, terms: demo?.terms, lookup: demo?.lookup, payments: demo?.payments, purchases: demo?.purchases });
reportDemoError = (error) => app.log.error(error, "demo purchase step failed");
if (demo !== undefined) app.log.info({ cases: demo.cases, buyer: config.demo?.buyer, seller: config.demo?.seller }, "demo cases seeded (simulated, in memory)");
// Outside the demo no payment rail is configured yet, so the passes retry pending registry outcomes only.
const reconciler = startReconciler({
  db,
  rail: demo?.rail,
  registry,
  now: () => new Date(),
  requiredLevel: "FINAL",
  intervalMs: demo === undefined ? RECONCILE_INTERVAL_MS : DEMO_RECONCILE_INTERVAL_MS,
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

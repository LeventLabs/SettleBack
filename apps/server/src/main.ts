import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { startReconciler } from "./payments/reconciler.ts";
import { connectRegistry } from "./registry/connect.ts";

const RECONCILE_INTERVAL_MS = 15_000;

const config = loadConfig();
const db = openDatabase({ path: config.databasePath, environment: config.environment });
// A configured but unreachable or mismatched registry stops startup instead of running without it.
const registry = await connectRegistry(config.registry, config.environment);
const app = buildApp(config, { db, registry });
// No payment rail is configured yet, so the passes retry pending registry outcomes only.
const reconciler = startReconciler({
  db,
  rail: undefined,
  registry,
  now: () => new Date(),
  requiredLevel: "FINAL",
  intervalMs: RECONCILE_INTERVAL_MS,
  onRun: (run) => {
    for (const item of [...run.attempts, ...run.outcomes]) if (item.error !== undefined) app.log.warn(item, "reconciliation item failed");
  },
  onError: (error) => app.log.error(error, "reconciliation pass failed"),
});
app.addHook("onClose", async () => {
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

import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { connectRegistry } from "./registry/connect.ts";

const config = loadConfig();
const db = openDatabase({ path: config.databasePath, environment: config.environment });
// A configured but unreachable or mismatched registry stops startup instead of running without it.
const registry = await connectRegistry(config.registry, config.environment);
const app = buildApp(config, { registry });
app.addHook("onClose", async () => {
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

import { parentPort, workerData } from "node:worker_threads";
import { openCase } from "../../src/db/cases.ts";
import { openDatabase } from "../../src/db/database.ts";

// Opens the same case from a separate connection once every worker is ready, to exercise
// concurrent writers on one database file.
const { path, operationId, buyer, now, gate } = workerData as { path: string; operationId: string; buyer: string; now: string; gate: SharedArrayBuffer };
const db = openDatabase({ path, environment: "local", now: () => now });
try {
  const flag = new Int32Array(gate);
  Atomics.wait(flag, 0, 0);
  const result = openCase(db, { operationId, openedBy: { role: "buyer", identity: buyer }, now });
  parentPort?.postMessage({ id: result.case.id, created: result.created });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}

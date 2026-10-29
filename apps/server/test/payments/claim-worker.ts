import { parentPort, workerData } from "node:worker_threads";
import type { ValidatedCart } from "@settleback/adapters";
import { openDatabase } from "../../src/db/database.ts";
import { claimExecution } from "../../src/payments/execution.ts";

// Claims the same attempt's permit from a separate connection once every worker is ready, to
// exercise concurrent writers on one database file.
const { path, attemptId, payer, cart, now, gate } = workerData as { path: string; attemptId: string; payer: string; cart: ValidatedCart; now: string; gate: SharedArrayBuffer };
const db = openDatabase({ path, environment: "local", now: () => now });
try {
  Atomics.wait(new Int32Array(gate), 0, 0);
  const claim = claimExecution(db, { attemptId, requestedBy: payer, cart, provenances: ["SIMULATED"], now });
  parentPort?.postMessage({ fencingToken: claim.fencingToken, paymentMandateSha256: claim.paymentMandateSha256 });
} catch (error) {
  parentPort?.postMessage({ code: (error as { code?: string }).code ?? "UNEXPECTED", message: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}

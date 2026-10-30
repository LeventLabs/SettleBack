import type { DatabaseSync } from "node:sqlite";
import type { RegistryGateway } from "@settleback/adapters";
import { readTransaction } from "../db/database.ts";
import { completeRepayment } from "../recovery/repayment.ts";
import { recordRetrievalOutcome, type OutcomeRecording } from "../recovery/retrieval.ts";
import { RECONCILABLE, reconcileAttempt, type PaymentObserver, type Reconciliation } from "./reconcile.ts";

export interface ReconcileRunInput {
  db: DatabaseSync;
  /** Without a rail, payment attempts are left for a run that has one. */
  rail: PaymentObserver | undefined;
  /** Without a registry, pending outcome records are left for a run that has one. */
  registry: RegistryGateway | undefined;
  now: () => Date;
  requiredLevel: "SAFE" | "FINAL";
  pinnedUsdRate?: string;
}

export interface ReconcileRun {
  attempts: { attemptId: string; result?: Reconciliation; error?: string }[];
  outcomes: { actionId: string; result?: OutcomeRecording; error?: string }[];
}

/**
 * One pass over everything that waits on the outside world: payment attempts whose permit was
 * consumed, repayments whose transfer or registry record is not final yet, and acknowledged
 * retrievals whose registry outcome is not recorded yet. Attempts are observed first, so a
 * repayment settled in this pass is completed in it too. Each item is observed or retried on its
 * own; one failure does not stop the others. Nothing here starts a new payment, signs, or submits.
 */
export async function reconcilePending(input: ReconcileRunInput): Promise<ReconcileRun> {
  const { db } = input;
  const run: ReconcileRun = { attempts: [], outcomes: [] };
  const rail = input.rail;
  if (rail !== undefined) {
    const placeholders = RECONCILABLE.map(() => "?").join(", ");
    const ids = readTransaction(db, () =>
      db.prepare(`SELECT id FROM payment_attempts WHERE state IN (${placeholders}) ORDER BY updated_at, id`).all(...RECONCILABLE).map((row) => String(row.id)),
    );
    for (const attemptId of ids) {
      try {
        const result = await reconcileAttempt(db, {
          attemptId,
          rail,
          now: input.now,
          requiredLevel: input.requiredLevel,
          ...(input.pinnedUsdRate === undefined ? {} : { pinnedUsdRate: input.pinnedUsdRate }),
        });
        run.attempts.push({ attemptId, result });
      } catch (error) {
        run.attempts.push({ attemptId, error: describe(error) });
      }
    }
  }
  const registry = input.registry;
  if (registry !== undefined) {
    const ids = readTransaction(db, () =>
      db
        .prepare(
          `SELECT id, action FROM recovery_actions
           WHERE (action = 'RETRIEVE' AND state IN ('DELIVERY_ACKED', 'RECORD_PENDING'))
              OR (action = 'REPAY' AND state IN ('EXECUTION_REQUESTED', 'VERIFIED', 'RECORD_PENDING'))
           ORDER BY updated_at, id`,
        )
        .all()
        .map((row) => ({ id: String(row.id), repay: row.action === "REPAY" })),
    );
    for (const { id: actionId, repay } of ids) {
      try {
        const result = repay
          ? await completeRepayment(db, { actionId, registry, now: input.now })
          : await recordRetrievalOutcome(db, { actionId, registry, now: input.now });
        run.outcomes.push({ actionId, result });
      } catch (error) {
        run.outcomes.push({ actionId, error: describe(error) });
      }
    }
  }
  return run;
}

export interface Reconciler {
  /** Runs one pass now, or waits for the pass already running. */
  runOnce(): Promise<ReconcileRun>;
  /** Stops the timer and waits for a running pass to finish. */
  stop(): Promise<void>;
}

/** Runs `reconcilePending` on an interval. Passes never overlap: a tick during a pass is skipped. */
export function startReconciler(input: ReconcileRunInput & { intervalMs: number; onRun?: (run: ReconcileRun) => void; onError?: (error: unknown) => void }): Reconciler {
  let running: Promise<ReconcileRun> | undefined;
  const runOnce = (): Promise<ReconcileRun> => {
    if (running !== undefined) return running;
    const pass = reconcilePending(input).finally(() => {
      running = undefined;
    });
    running = pass;
    return pass;
  };
  const timer = setInterval(() => {
    if (running !== undefined) return;
    runOnce().then(
      (run) => input.onRun?.(run),
      (error: unknown) => input.onError?.(error),
    );
  }, input.intervalMs);
  timer.unref();
  return {
    runOnce,
    async stop() {
      clearInterval(timer);
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

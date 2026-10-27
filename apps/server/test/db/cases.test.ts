import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { getCase, openCase } from "../../src/db/cases.ts";
import { openDatabase } from "../../src/db/database.ts";
import { CaseOpenForbiddenError, OperationNotFoundError } from "../../src/db/errors.ts";
import { BUYER, NOW, SELLER, memoryDatabase, seedOperation } from "./helpers.ts";

describe("openCase", () => {
  it("creates one case however many times it is opened, by buyer or operator", () => {
    const db = memoryDatabase();
    try {
      const operationId = seedOperation(db);
      const results = Array.from({ length: 10 }, (_, i) =>
        openCase(db, { operationId, openedBy: i % 2 === 0 ? { role: "buyer", identity: BUYER.toUpperCase().replace("0X", "0x") } : { role: "operator", identity: "ops-1" }, now: NOW }),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.case.id)).size).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM cases").get()?.n).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE event_type = 'CASE_OPENED'").get()?.n).toBe(1);
      const opened = results[0]?.case;
      expect(opened?.status).toBe("OPEN");
      expect(opened?.openedBy).toBe(`buyer:${BUYER}`);
      expect(opened?.evidence.revision).toBe(1);
      expect(getCase(db, opened?.id ?? "")).toEqual(opened);
    } finally {
      db.close();
    }
  });

  it("refuses anyone but the operation's buyer or an operator", () => {
    const db = memoryDatabase();
    try {
      const operationId = seedOperation(db);
      expect(() => openCase(db, { operationId, openedBy: { role: "buyer", identity: SELLER }, now: NOW })).toThrow(CaseOpenForbiddenError);
      expect(() => openCase(db, { operationId, openedBy: { role: "operator", identity: " " }, now: NOW })).toThrow(CaseOpenForbiddenError);
      const forged = { role: "seller", identity: SELLER } as unknown as { role: "buyer"; identity: string };
      expect(() => openCase(db, { operationId, openedBy: forged, now: NOW })).toThrow(CaseOpenForbiddenError);
      expect(() => openCase(db, { operationId: "missing", openedBy: { role: "operator", identity: "ops-1" }, now: NOW })).toThrow(OperationNotFoundError);
      expect(db.prepare("SELECT count(*) AS n FROM cases").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM evidence_items").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("converges on one case when ten connections open it at the same moment", async () => {
    await withTempDirAsync(async (dir) => {
      const path = join(dir, "settleback-local.db");
      const setup = openDatabase({ path, environment: "local", now: () => NOW });
      const operationId = seedOperation(setup);
      setup.close();

      const gate = new SharedArrayBuffer(4);
      const workers = Array.from(
        { length: 10 },
        () => new Worker(new URL("./open-case-worker.ts", import.meta.url), { workerData: { path, operationId, buyer: BUYER, now: NOW, gate } }),
      );
      const results = workers.map(
        (worker) =>
          new Promise<{ id?: string; created?: boolean; error?: string }>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      const settled = await Promise.all(results);
      await Promise.all(workers.map((worker) => worker.terminate()));

      expect(settled.filter((result) => result.error !== undefined)).toEqual([]);
      expect(settled.filter((result) => result.created === true)).toHaveLength(1);
      expect(new Set(settled.map((result) => result.id)).size).toBe(1);
      const check = openDatabase({ path, environment: "local", now: () => NOW });
      try {
        expect(check.prepare("SELECT count(*) AS n FROM cases").get()?.n).toBe(1);
        expect(check.prepare("SELECT count(*) AS n FROM evidence_items WHERE source = 'policy'").get()?.n).toBe(1);
      } finally {
        check.close();
      }
    });
  });
});

async function withTempDirAsync(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "settleback-test-"));
  try {
    await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

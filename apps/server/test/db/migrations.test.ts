import { appendFileSync, copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDatabase } from "../../src/db/database.ts";
import { EnvironmentMismatchError, MigrationError } from "../../src/db/errors.ts";
import { NOW, memoryDatabase, withTempDir } from "./helpers.ts";

const EXPECTED_TABLES = [
  "assessment_requests",
  "assessment_results",
  "cases",
  "delivery_acks",
  "events",
  "evidence_contents",
  "evidence_items",
  "execution_permits",
  "idempotency_records",
  "meta",
  "operations",
  "payment_attempts",
  "policies",
  "proof_allocations",
  "recovery_actions",
  "recovery_proposals",
  "schema_migrations",
  "service_jobs",
  "sessions",
];

describe("openDatabase", () => {
  it("applies migrations to a new database with foreign keys and strict tables", () => {
    const db = memoryDatabase();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(EXPECTED_TABLES);
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      const strict = db.prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'").all();
      for (const row of strict) {
        if (EXPECTED_TABLES.includes(String(row.name))) expect(row.strict, String(row.name)).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("reopens an existing file database without reapplying migrations, in WAL mode", () => {
    withTempDir((dir) => {
      const path = join(dir, "data", "settleback-local.db");
      openDatabase({ path, environment: "local", now: () => NOW }).close();
      const db = openDatabase({ path, environment: "local", now: () => NOW });
      try {
        const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
        expect(files.length).toBeGreaterThan(1);
        expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n).toBe(files.length);
        expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      } finally {
        db.close();
      }
    });
  });

  it("refuses to open a database that belongs to another environment", () => {
    withTempDir((dir) => {
      const path = join(dir, "settleback.db");
      openDatabase({ path, environment: "testnet", now: () => NOW }).close();
      expect(() => openDatabase({ path, environment: "mainnet", now: () => NOW })).toThrow(EnvironmentMismatchError);
    });
  });

  it("refuses a migration that changed after it was applied", () => {
    withTempDir((dir) => {
      const migrationsDir = join(dir, "migrations");
      cpSync(MIGRATIONS_DIR, migrationsDir, { recursive: true });
      const path = join(dir, "settleback.db");
      openDatabase({ path, environment: "local", migrationsDir, now: () => NOW }).close();
      appendFileSync(join(migrationsDir, "0001_core.sql"), "\n-- edited\n");
      expect(() => openDatabase({ path, environment: "local", migrationsDir, now: () => NOW })).toThrow(
        /changed after it was applied/,
      );
    });
  });

  it("refuses a database that has migrations this code does not know", () => {
    withTempDir((dir) => {
      const path = join(dir, "settleback.db");
      openDatabase({ path, environment: "local", now: () => NOW }).close();
      const emptyMigrations = join(dir, "empty");
      mkdirSync(emptyMigrations);
      expect(() => openDatabase({ path, environment: "local", migrationsDir: emptyMigrations, now: () => NOW })).toThrow(
        MigrationError,
      );
    });
  });

  it("will not drop the placeholder assessments table if it ever held rows", () => {
    withTempDir((dir) => {
      const migrationsDir = join(dir, "migrations");
      mkdirSync(migrationsDir);
      for (const name of ["0001_core.sql", "0002_evidence_contents.sql"]) copyFileSync(join(MIGRATIONS_DIR, name), join(migrationsDir, name));
      const path = join(dir, "settleback.db");
      const db = openDatabase({ path, environment: "local", migrationsDir, now: () => NOW });
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(
        `INSERT INTO assessments (id, case_id, case_revision, policy_sha256, provider, model, prompt_version, validation_status, findings_json, created_at)
         VALUES ('a1', 'missing-case', 0, '${"0".repeat(64)}', 'p', 'm', 'v', 'FAILED', '[]', '${NOW}')`,
      );
      db.close();
      copyFileSync(join(MIGRATIONS_DIR, "0003_assessments.sql"), join(migrationsDir, "0003_assessments.sql"));
      expect(() => openDatabase({ path, environment: "local", migrationsDir, now: () => NOW })).toThrow(/CHECK constraint failed/);
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare("SELECT count(*) AS n FROM assessments").get()?.n).toBe(1);
        expect(raw.prepare("SELECT max(version) AS v FROM schema_migrations").get()?.v).toBe(2);
      } finally {
        raw.close();
      }
    });
  });
});

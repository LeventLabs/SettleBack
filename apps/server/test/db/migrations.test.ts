import { appendFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDatabase } from "../../src/db/database.ts";
import { EnvironmentMismatchError, MigrationError } from "../../src/db/errors.ts";
import { NOW, memoryDatabase, withTempDir } from "./helpers.ts";

const EXPECTED_TABLES = [
  "assessments",
  "cases",
  "delivery_acks",
  "events",
  "evidence_items",
  "execution_permits",
  "idempotency_records",
  "meta",
  "operations",
  "payment_attempts",
  "policies",
  "proof_allocations",
  "recovery_actions",
  "schema_migrations",
  "service_jobs",
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
        expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n).toBe(1);
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
});

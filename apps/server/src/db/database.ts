import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Environment } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { EnvironmentMismatchError, MigrationError } from "./errors.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations/", import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  path: string;
  environment: Environment;
  migrationsDir?: string;
  now?: () => string;
}

/**
 * Opens a database bound to one environment, applies pending migrations, and refuses to open a
 * database created for a different environment.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new DatabaseSync(options.path);
  try {
    configure(db);
    const now = options.now ?? (() => new Date().toISOString());
    migrate(db, options.migrationsDir ?? MIGRATIONS_DIR, now);
    bindEnvironment(db, options.environment, now);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Runs `work` inside BEGIN IMMEDIATE so concurrent writers serialize before reading state. */
export function immediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) {
    throw new Error("Nested transactions are not supported");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: DatabaseSync, migrationsDir: string, now: () => string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const files = readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  const onDisk = new Map<number, string>();
  for (const name of files) {
    const version = Number(MIGRATION_FILE.exec(name)?.[1]);
    if (onDisk.has(version)) throw new MigrationError(`Duplicate migration version ${version} in ${migrationsDir}`);
    onDisk.set(version, name);
  }

  const applied = new Map<number, { name: string; sha256: string }>();
  for (const row of db.prepare("SELECT version, name, sha256 FROM schema_migrations").all()) {
    applied.set(Number(row.version), { name: String(row.name), sha256: String(row.sha256) });
  }
  for (const version of applied.keys()) {
    if (!onDisk.has(version)) {
      throw new MigrationError(`Database has migration ${version}, which is missing from ${migrationsDir}`);
    }
  }

  const newlyApplied: string[] = [];
  for (const [version, name] of onDisk) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    const sha256 = sha256Hex(sql);
    const existing = applied.get(version);
    if (existing !== undefined) {
      if (existing.name !== name || existing.sha256 !== sha256) {
        throw new MigrationError(`Migration ${name} changed after it was applied`);
      }
      continue;
    }
    immediateTransaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)").run(
        version,
        name,
        sha256,
        now(),
      );
    });
    newlyApplied.push(name);
  }
  return newlyApplied;
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA synchronous = FULL");
  db.prepare("PRAGMA journal_mode = WAL").get();
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get();
  if (foreignKeys?.foreign_keys !== 1) {
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
}

function bindEnvironment(db: DatabaseSync, environment: Environment, now: () => string): void {
  immediateTransaction(db, () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'environment'").get();
    if (row === undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('environment', ?), ('created_at', ?)").run(environment, now());
      return;
    }
    if (row.value !== environment) {
      throw new EnvironmentMismatchError(environment, String(row.value));
    }
  });
}

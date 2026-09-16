import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hasColumn, migrate, MIGRATIONS, openDatabase, schemaVersion } from "./db";

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** A database as fabPlane 0.2.87 through 0.2.99 created it: migration 1 only, with `runs.log_path` already there. */
function databaseFrom0_2_87(): Database {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.run(MIGRATIONS[0]!.sql);
  db.run("ALTER TABLE runs ADD COLUMN log_path TEXT");
  db.run("INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-09-10T08:57:49.923Z')");
  db.run(
    "INSERT INTO threads(id, title, created_at, updated_at, agent_id) VALUES ('t1', 'old thread', '2026-09-10T09:00:00Z', '2026-09-10T09:00:00Z', 'claude')",
  );
  db.run(
    "INSERT INTO runs(id, thread_id, agent_id, status, started_at, log_path) VALUES ('r1', 't1', 'claude', 'done', '2026-09-10T09:00:00Z', '/tmp/r1.jsonl')",
  );
  return db;
}

describe("migrate", () => {
  test("a fresh database reaches the latest version", () => {
    const db = new Database(":memory:", { strict: true });
    expect(migrate(db)).toBe(LATEST);
    expect(schemaVersion(db)).toBe(LATEST);
    expect(hasColumn(db, "runs", "log_path")).toBe(true);
    expect(hasColumn(db, "run_dumps", "dump_json")).toBe(true);
  });

  test("a database created by 0.2.87 upgrades although runs.log_path already exists", () => {
    const db = databaseFrom0_2_87();
    expect(hasColumn(db, "runs", "log_path")).toBe(true);
    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(LATEST);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().filter((c) => c.name === "log_path");
    expect(cols).toHaveLength(1);
    expect(db.query<{ log_path: string }, []>("SELECT log_path FROM runs WHERE id = 'r1'").get()?.log_path).toBe("/tmp/r1.jsonl");
    expect(hasColumn(db, "run_dumps", "dump_json")).toBe(true);
  });

  test("migrating twice is a no-op", () => {
    const db = databaseFrom0_2_87();
    migrate(db);
    expect(migrate(db)).toBe(LATEST);
  });

  test("openDatabase migrates an in-memory database to the latest version", () => {
    expect(schemaVersion(openDatabase(":memory:"))).toBe(LATEST);
  });
});

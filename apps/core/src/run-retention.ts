/** Local run history only. Never follows symlinks or removes the user's project. */
import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseDumpFile } from "./run-dump-file";
import { partReceiptPrefix } from "./usage-parts";
import { errMsg, logger } from "./log";

export const RUN_DUMP_RETENTION = { rows: 100, bytes: 512 * 1024 * 1024, localRuns: 50, pendingBytes: 5 * 1024 ** 3 } as const;
export type RunCapture = { createdAt: string; runDirectory: string };
type History = { run_id: string; created_at: string; run_directory: string | null; file_path: string | null; destinations_json: string; dump_bytes: number | null; dump_reference: string | null;
  directory_bytes: number | null; file_bytes: number | null; shared_bytes: number | null };
type RetentionFileSystem = Pick<typeof import("node:fs"), "lstatSync" | "readdirSync" | "rmSync">;
// Only small descriptors may cross into JS; inline events/blobs stay in SQLite.
const dumpReference = `CASE WHEN length(d.dump_json) <= 65536 AND json_valid(d.dump_json)
  THEN CASE WHEN json_extract(d.dump_json, '$.schema') = 'fabdesk.llm-run-file/v1' THEN d.dump_json END END`;
const dumpColumns = `length(CAST(d.dump_json AS BLOB)) AS dump_bytes, ${dumpReference} AS dump_reference`;
const filesystem = { lstatSync, readdirSync, rmSync };
const ownedDirectory = (path: string, id: string) => /^[a-zA-Z0-9_-]+$/.test(id)
  && basename(path) === id && basename(dirname(path)) === "runs" && basename(dirname(dirname(path))) === ".fabdesk";
const ownedFile = (path: string, id: string, db: Database) => db.filename !== ":memory:"
  && resolve(path) === resolve(dirname(db.filename), "run-dumps", `${id}.json`);
const activeByDatabase = new WeakMap<Database, Set<string>>();
const recoveredCaptures = new WeakSet<Database>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class RunRetention {
  private readonly active: Set<string>;
  constructor(private readonly db: Database, private readonly limits: { rows: number; bytes: number; localRuns: number; pendingBytes: number } = RUN_DUMP_RETENTION,
    private readonly fs: RetentionFileSystem = filesystem) {
    this.active = activeByDatabase.get(db) ?? new Set<string>();
    activeByDatabase.set(db, this.active);
    // Adopt known pre-retention records. Unknown folders are preserved: their backup state is unknown.
    for (const row of db.query<{run_id:string; created_at:string; dump_json:string|null; archive_destinations_json:string; log_path:string|null}, []>(`
      SELECT d.run_id, d.created_at,
        COALESCE(${dumpReference}, 'null') AS dump_json,
        d.archive_destinations_json, r.log_path
      FROM run_dumps d LEFT JOIN runs r ON r.id = d.run_id
      WHERE NOT EXISTS (SELECT 1 FROM run_dump_history h WHERE h.run_id = d.run_id)`).all()) {
      const ref = parseDumpFile(row.dump_json!);
      const directory = row.log_path ? dirname(row.log_path) : ref && ownedDirectory(dirname(ref.path), row.run_id) ? dirname(ref.path) : null;
      this.register(row.run_id, row.created_at, directory, row.dump_json!, JSON.parse(row.archive_destinations_json) as string[]);
    }
    // Recover interrupted captures from builds that only indexed successful dumps.
    // No complete dump or destination assignment survives for these legacy captures.
    if (!recoveredCaptures.has(db)) {
      for (const row of db.query<{ id: string; started_at: string; log_path: string }, []>(`
        SELECT r.id, r.started_at, r.log_path FROM runs r WHERE r.log_path IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM run_dump_history h WHERE h.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM run_backup_drops b WHERE b.run_id = r.id)`).all()) {
        const directory = dirname(row.log_path);
        if (ownedDirectory(directory, row.id)) this.indexCapture(row.id, { createdAt: row.started_at, runDirectory: directory }, []);
      }
      recoveredCaptures.add(db);
    }
  }
  private indexCapture(runId: string, capture: RunCapture, destinations: readonly string[]): void {
    if (!ownedDirectory(capture.runDirectory, runId)) return;
    this.db.run(`INSERT OR IGNORE INTO run_dump_history(run_id, created_at, run_directory, destinations_json)
      VALUES (?, ?, ?, ?)`, [runId, capture.createdAt, resolve(capture.runDirectory), JSON.stringify(destinations)]);
  }
  begin(runId: string, capture?: RunCapture, destinations: readonly string[] = []): void {
    if (capture) this.indexCapture(runId, capture, destinations);
    this.active.add(runId);
  }
  end(runId: string): void { this.active.delete(runId); }
  register(runId: string, createdAt: string, directory: string | null, dumpJson: string, destinations: readonly string[]): void {
    const reference = parseDumpFile(dumpJson);
    const runDirectory = directory && ownedDirectory(directory, runId) ? resolve(directory) : null;
    const filePath = reference && ownedFile(reference.path, runId, this.db) ? resolve(reference.path) : null;
    this.db.run(`INSERT INTO run_dump_history(run_id, created_at, run_directory, file_path, destinations_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
      run_directory = COALESCE(excluded.run_directory, run_directory), file_path = COALESCE(excluded.file_path, file_path), destinations_json = excluded.destinations_json`,
      [runId, createdAt, runDirectory, filePath, JSON.stringify(destinations)]);
    // put is called only after capture/export finishes; these paths are immutable from here on.
    const row = this.db.query<History, [string]>(`SELECT h.*, ${dumpColumns} FROM run_dump_history h LEFT JOIN run_dumps d ON d.run_id = h.run_id WHERE h.run_id = ?`).get(runId)!;
    try { this.measure(row, true); }
    catch (error) { logger.debug("could not size local run history", { runId, error: errMsg(error) }); }
  }
  private measure(row: History, finalized = false): void {
    // Project purge can remove a finalized tree outside retention. Check its root only;
    // immutable surviving trees still use their cached sizes without another traversal.
    if (row.run_directory) {
      try { this.fs.lstatSync(row.run_directory); }
      catch (error) {
        if (!missing(error)) throw error;
        if (!this.active.has(row.run_id)) {
          this.db.run("UPDATE run_dump_history SET run_directory = NULL, directory_bytes = 0, shared_bytes = 0 WHERE run_id = ?", [row.run_id]);
          row.run_directory = null; row.directory_bytes = 0; row.shared_bytes = 0;
        }
      }
    }
    if (row.directory_bytes !== null && row.file_bytes !== null && row.shared_bytes !== null) return;
    const seen = new Set<string>();
    const directoryBytes = row.run_directory ? treeBytes(row.run_directory, seen, this.fs) : 0;
    const exclusiveFileBytes = row.file_path ? treeBytes(row.file_path, seen, this.fs) : 0;
    const fileBytes = row.file_path ? treeBytes(row.file_path, new Set(), this.fs) : 0;
    row.directory_bytes = directoryBytes; row.file_bytes = fileBytes; row.shared_bytes = fileBytes - exclusiveFileBytes;
    // Active traces can grow. Count the current snapshot, but cache only after finalization.
    if (finalized || !this.active.has(row.run_id)) this.saveMeasurement(row);
  }
  private saveMeasurement(row: History): void {
    this.db.run("UPDATE run_dump_history SET directory_bytes = ?, file_bytes = ?, shared_bytes = ? WHERE run_id = ?",
      [row.directory_bytes, row.file_bytes, row.shared_bytes, row.run_id]);
  }
  private bytes(row: History): number {
    return (row.directory_bytes ?? 0) + (row.file_bytes ?? 0) - (row.shared_bytes ?? 0)
      + (row.dump_bytes ?? 0);
  }
  private pending(row: History): boolean {
    return (JSON.parse(row.destinations_json) as string[]).some(destination =>
      !this.db.query("SELECT 1 FROM usage_archive_uploads WHERE destination = ? AND record_id = ?").get(destination, `run-dump:${row.run_id}`));
  }
  /** Metadata operations and deletes are synchronous so acknowledgement cannot interleave a prune. */
  prune(): void {
    try { this.apply(); }
    catch (error) { logger.debug("could not prune local run history", { error: errMsg(error) }); }
  }
  private apply(): void {
    const rows = this.db.query<History, []>(`SELECT h.*, ${dumpColumns} FROM run_dump_history h
      LEFT JOIN run_dumps d ON d.run_id = h.run_id ORDER BY h.created_at DESC, h.run_id DESC`).all();
    const failed = new Set<string>();
    const attempt = (row: History, action: () => void) => {
      if (failed.has(row.run_id)) return;
      try { action(); }
      catch (error) {
        failed.add(row.run_id);
        logger.debug("could not prune local run history entry", { runId: row.run_id, error: errMsg(error) });
      }
    };
    // One-time adoption also covers history whose SQLite payload has already been evicted.
    // An unmeasurable history keeps its NULL footprint and is protected for this pass.
    for (const row of rows) attempt(row, () => this.measure(row));
    // Recover a drop interrupted by a filesystem error/crash. Its delivery guard is already durable.
    for (const row of rows) {
      if (this.db.query("SELECT 1 FROM run_backup_drops WHERE run_id = ?").get(row.run_id)) {
        attempt(row, () => { this.clearReceipts(row.run_id); this.removeDirectory(row); this.removeDump(row); });
      }
    }
    const protectedIds = new Set(this.active);
    if (rows[0]) protectedIds.add(rows[0].run_id);
    const groups = new Map<string, number>();
    const newestDirectories = new Set<string>();
    let dbRows = 0, dbBytes = 0;
    for (const row of rows) {
      if (row.run_directory) {
        const group = dirname(row.run_directory), index = (groups.get(group) ?? 0) + 1;
        groups.set(group, index);
        if (index === 1) newestDirectories.add(row.run_id);
        if (index > this.limits.localRuns && !protectedIds.has(row.run_id) && !this.pending(row)) {
          attempt(row, () => this.removeDirectory(row));
        }
      }
      if (row.dump_bytes !== null) {
        dbRows++;
        // The SQLite limit counts actual SQLite payload bytes, including file descriptors.
        dbBytes += row.dump_bytes;
        if ((dbRows > this.limits.rows || dbBytes > this.limits.bytes) && !protectedIds.has(row.run_id) && !this.pending(row)) {
          attempt(row, () => this.removeDump(row));
        }
      }
    }
    // Sum finalized footprints. Each run's project/profile hard link is charged once;
    // generated captures do not share files across runs. SQLite remains a separate copy.
    // Failed unknown footprints contribute only known bytes and cannot be dropped this pass.
    const pending = rows.filter(row => this.pending(row));
    let total = pending.reduce((sum, row) => sum + this.bytes(row), 0);
    for (const row of [...pending].reverse()) {
      if (total <= this.limits.pendingBytes) break;
      if (failed.has(row.run_id) || protectedIds.has(row.run_id) || newestDirectories.has(row.run_id)) continue;
      const bytes = this.bytes(row);
      const reason = "pending-backup-storage-cap";
      this.db.run("INSERT OR IGNORE INTO run_backup_drops(run_id, bytes, reason, dropped_at) VALUES (?, ?, ?, ?)",
        [row.run_id, bytes, reason, new Date().toISOString()]);
      logger.debug("dropped unsent run backup at local storage cap", { runId: row.run_id, bytes, reason });
      attempt(row, () => {
        this.clearReceipts(row.run_id);
        this.removeDirectory(row);
        this.removeDump(row);
      });
      // Account for successful components even if a later deletion failed.
      total -= bytes - this.bytes(row);
    }
    if (total > this.limits.pendingBytes)
      logger.debug("pending run storage exceeds cap; current/newest runs protected", { bytes: total, cap: this.limits.pendingBytes });
    this.db.run(`DELETE FROM run_dump_history WHERE run_directory IS NULL AND file_path IS NULL
      AND NOT EXISTS (SELECT 1 FROM run_dumps d WHERE d.run_id = run_dump_history.run_id)`);
  }
  private clearReceipts(runId: string): void {
    const prefix = partReceiptPrefix(`run-dumps/${runId}.json`);
    this.db.run("DELETE FROM settings WHERE substr(key, 1, ?) = ?", [prefix.length, prefix]);
  }
  private removeDirectory(row: History): void {
    if (row.run_directory && ownedDirectory(row.run_directory, row.run_id)) {
      if (!safeAncestors(row.run_directory, this.fs)) throw new Error("symlink in run-history path");
      if (row.dump_reference && parseDumpFile(row.dump_reference)?.path === join(row.run_directory, "llm-dump.json")) this.removeDump(row);
      this.fs.rmSync(row.run_directory, { recursive: true, force: true });
      this.db.run("UPDATE run_dump_history SET run_directory = NULL, directory_bytes = 0, shared_bytes = 0 WHERE run_id = ?", [row.run_id]);
      row.run_directory = null;
      row.directory_bytes = 0; row.shared_bytes = 0;
    }
  }
  private removeDump(row: History): void {
    if (row.file_path && ownedFile(row.file_path, row.run_id, this.db)) {
      if (!safeAncestors(row.file_path, this.fs)) throw new Error("symlink in profile run-dump path");
      this.fs.rmSync(row.file_path, { force: true });
      this.db.run("UPDATE run_dump_history SET file_path = NULL, file_bytes = 0, shared_bytes = 0 WHERE run_id = ?", [row.run_id]);
      row.file_path = null;
      row.file_bytes = 0; row.shared_bytes = 0;
    }
    this.db.run("DELETE FROM run_dumps WHERE run_id = ?", [row.run_id]);
    row.dump_bytes = null; row.dump_reference = null;
  }
}

function treeBytes(path: string, seen: Set<string>, fs: RetentionFileSystem): number {
  let info;
  try { info = fs.lstatSync(path, { bigint: true }); }
  catch (error) { if (missing(error)) return 0; throw error; }
  if (info.isSymbolicLink()) return 0;
  if (info.isDirectory()) return fs.readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name), seen, fs), 0);
  const key = `${info.dev}:${info.ino}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  return Number(info.size);
}

function safeAncestors(path: string, fs: RetentionFileSystem): boolean {
  for (let parent = dirname(path); dirname(parent) !== parent; parent = dirname(parent)) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) return false; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return true;
}

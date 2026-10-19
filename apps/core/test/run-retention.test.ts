import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db";
import { RunRetention, RUN_DUMP_RETENTION } from "../src/run-retention";
import { UsageArchive } from "../src/usage-archive";
import { captureSnapshotFile } from "../src/run-telemetry";
import { logger } from "../src/log";
import { partReceiptPrefix } from "../src/usage-parts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-retention-"));
  const store = Store.open(join(root, "fabdesk.db"));
  function put(index: number, destinations: string[] = [], project = "project") {
    const runId = `run_${String(index).padStart(3, "0")}`, createdAt = new Date(1_700_000_000_000 + index).toISOString();
    const directory = join(root, project, ".fabdesk", "runs", runId);
    const file = join(root, "run-dumps", `${runId}.json`);
    mkdirSync(directory, { recursive: true }); mkdirSync(join(root, "run-dumps"), { recursive: true });
    writeFileSync(join(directory, "trace.jsonl"), "trace".repeat(10));
    const content = `{"run":"${runId}"}`;
    writeFileSync(join(directory, "llm-dump.json"), content);
    linkSync(join(directory, "llm-dump.json"), file);
    const dump = { runId, traceId: "trace", threadId: "thread", agentId: "test", projectId: project, createdAt,
      runDirectory: directory, dumpJson: JSON.stringify({ schema: "fabdesk.llm-run-file/v1", path: file,
        bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }) };
    store.runDumps.put(dump, destinations);
    return { dump, directory, file };
  }
  return { root, store, put, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("bounded local run history", () => {
  test("backup off keeps 50 project folders and 100 database/profile copies", async () => {
    const f = await fixture();
    try {
      const oldest = f.put(0);
      for (let i = 1; i <= 100; i++) f.put(i);
      expect(existsSync(oldest.directory)).toBe(false);
      expect(existsSync(oldest.file)).toBe(false);
      expect(f.store.runDumps.get(oldest.dump.runId)).toBeNull();
      expect(f.store.db.query("SELECT COUNT(*) AS n FROM run_dump_history WHERE run_directory IS NOT NULL").get()).toEqual({ n: 50 });
      expect(f.store.runDumps.list(200)).toHaveLength(100);
      expect(existsSync(join(f.root, "run-dumps/run_001.json"))).toBe(true);
    } finally { f.close(); }
  });

  test("all destinations must acknowledge before normal limits remove folders, profile and row", async () => {
    const f = await fixture();
    try {
      const oldest = f.put(0, ["first", "second"]);
      for (let i = 1; i <= 100; i++) f.put(i, ["first", "second"]);
      expect(existsSync(oldest.directory)).toBe(true);
      const first = new UsageArchive({ id: "first", async write() {}, async writeFile() {} });
      const second = new UsageArchive({ id: "second", async write() {}, async writeFile() {} });
      await first.put(oldest.dump, f.store.db);
      expect(existsSync(oldest.file)).toBe(true);
      expect(existsSync(oldest.directory)).toBe(true);
      await second.put(oldest.dump, f.store.db);
      expect(existsSync(oldest.directory)).toBe(false);
      expect(existsSync(oldest.file)).toBe(false);
      expect(f.store.runDumps.get(oldest.dump.runId)).toBeNull();
      expect(f.store.runDumps.get("run_001")).not.toBeNull();
    } finally { f.close(); }
  });

  test("put scopes destination assignment to its own run", async () => {
    const f = await fixture();
    try {
      f.put(0); f.put(1, ["api:test"]);
      expect(f.store.db.query("SELECT archive_destinations_json FROM run_dumps WHERE run_id = 'run_000'").get()).toEqual({ archive_destinations_json: "[]" });
      expect(f.store.db.query("SELECT destinations_json FROM run_dump_history WHERE run_id = 'run_000'").get()).toEqual({ destinations_json: "[]" });
    } finally { f.close(); }
  });

  test("cap counts every copy once per inode, drops oldest pending run and records debugLog", async () => {
    const f = await fixture(), debugLog = spyOn(logger, "debug");
    try {
      const oldest = f.put(0, ["api:test"]), newest = f.put(1, ["api:test"]);
      const bytes = 50 + readFileSync(oldest.file).length + Buffer.byteLength(oldest.dump.dumpJson);
      f.store.settings.writeRaw(`${partReceiptPrefix(`run-dumps/${oldest.dump.runId}.json`)}test-receipt`, true);
      const retention = new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: bytes * 2 });
      retention.prune();
      expect(existsSync(oldest.directory)).toBe(true); // hard link is not charged twice
      const reopened = Store.open(join(f.root, "fabdesk.db"));
      try { new RunRetention(reopened.db, { ...RUN_DUMP_RETENTION, pendingBytes: bytes * 2 - 1 }).prune(); }
      finally { reopened.close(); }
      expect(existsSync(oldest.directory)).toBe(false);
      expect(existsSync(oldest.file)).toBe(false);
      expect(existsSync(newest.directory)).toBe(true);
      expect(f.store.runDumps.get(oldest.dump.runId)).toBeNull();
      expect(f.store.db.query("SELECT * FROM settings WHERE key LIKE 'usage_archive_part_%'").all()).toEqual([]);
      expect(f.store.db.query("SELECT * FROM run_backup_drops").get()).toMatchObject({ run_id: oldest.dump.runId, bytes, reason: "pending-backup-storage-cap", dropped_at: expect.stringMatching(/Z$/) });
      expect(debugLog.mock.calls.some(call => call[0] === "dropped unsent run backup at local storage cap")).toBe(true);
      expect(f.store.db.query("SELECT * FROM usage_archive_uploads").all()).toEqual([]);
    } finally { debugLog.mockRestore(); f.close(); }
  });

  test("current and newest runs survive protected-only cap excess", async () => {
    const f = await fixture(), debugLog = spyOn(logger, "debug");
    try {
      const oldest = f.put(0, ["api:test"]); f.store.runDumps.begin(oldest.dump.runId);
      const newest = f.put(1, ["api:test"]);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 1 }).prune();
      expect(existsSync(oldest.file)).toBe(true); expect(existsSync(newest.file)).toBe(true);
      expect(debugLog.mock.calls.some(call => call[0] === "pending run storage exceeds cap; current/newest runs protected")).toBe(true);
    } finally { debugLog.mockRestore(); f.close(); }
  });

  test("finalized sizes survive register, prune and reopen without walking trees; multiple drops use stored totals", async () => {
    const f = await fixture();
    const files = { lstatSync, readdirSync, rmSync };
    const stat = spyOn(files, "lstatSync"), read = spyOn(files, "readdirSync");
    try {
      const runs = Array.from({ length: 4 }, (_, i) => f.put(i, ["api:test"]));
      const bytes = 50 + readFileSync(runs[0]!.file).length + Buffer.byteLength(runs[0]!.dump.dumpJson);
      const reopened = Store.open(join(f.root, "fabdesk.db"));
      try {
        const retention = new RunRetention(reopened.db, RUN_DUMP_RETENTION, files);
        const first = runs[0]!.dump;
        retention.register(first.runId, first.createdAt, first.runDirectory, first.dumpJson, ["api:test"]);
        retention.prune(); retention.prune();
        expect(stat.mock.calls.every(([path]) => runs.some(run => path === run.directory))).toBe(true);
        expect(read).not.toHaveBeenCalled();
        new RunRetention(reopened.db, { ...RUN_DUMP_RETENTION, pendingBytes: bytes * 2 }, files).prune();
        expect(runs.map(run => existsSync(run.directory))).toEqual([false, false, true, true]);
        expect(reopened.db.query("SELECT bytes FROM run_backup_drops ORDER BY run_id").all()).toEqual([{ bytes }, { bytes }]);
        expect(read).not.toHaveBeenCalled();
        // Only directory roots and deletion ancestors are checked, never payload files.
        expect(stat.mock.calls.every(([path]) => !runs.some(run => path === run.file || path === join(run.directory, "llm-dump.json") || path === join(run.directory, "trace.jsonl")))).toBe(true);
      } finally { reopened.close(); }
    } finally { stat.mockRestore(); read.mockRestore(); f.close(); }
  });

  test("legacy history is sized once and stays sized after its SQLite payload is evicted", async () => {
    const f = await fixture();
    const files = { lstatSync, readdirSync, rmSync };
    const stat = spyOn(files, "lstatSync"), read = spyOn(files, "readdirSync");
    try {
      const oldest = f.put(0); f.put(1);
      // Model a pre-migration index, including a history surviving prior SQLite eviction.
      f.store.db.run("DELETE FROM run_dumps WHERE run_id = ?", [oldest.dump.runId]);
      f.store.db.run("UPDATE run_dump_history SET directory_bytes = NULL, file_bytes = NULL, shared_bytes = NULL WHERE run_id = ?", [oldest.dump.runId]);
      const retention = new RunRetention(f.store.db, RUN_DUMP_RETENTION, files);
      retention.prune();
      const contentBytes = readFileSync(oldest.file).length;
      expect(f.store.db.query("SELECT directory_bytes, file_bytes, shared_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId))
        .toEqual({ directory_bytes: 50 + contentBytes, file_bytes: contentBytes, shared_bytes: contentBytes });
      expect(read.mock.calls).toHaveLength(1);
      stat.mockClear(); read.mockClear();
      retention.prune();
      new RunRetention(f.store.db, RUN_DUMP_RETENTION, files).prune();
      expect(stat.mock.calls.every(([path]) => path === oldest.directory || path === join(f.root, "project/.fabdesk/runs/run_001"))).toBe(true);
      expect(read).not.toHaveBeenCalled();
    } finally { stat.mockRestore(); read.mockRestore(); f.close(); }
  });

  test("successful directory deletion keeps the surviving profile hard link fully accounted", async () => {
    const f = await fixture();
    try {
      const oldest = f.put(0); f.put(1);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, localRuns: 1 }).prune();
      expect(existsSync(oldest.directory)).toBe(false); expect(existsSync(oldest.file)).toBe(true);
      expect(f.store.db.query("SELECT directory_bytes, file_bytes, shared_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId))
        .toEqual({ directory_bytes: 0, file_bytes: readFileSync(oldest.file).length, shared_bytes: 0 });
    } finally { f.close(); }
  });

  test("failed legacy measurement stays unknown until a successful retry, then is cached", async () => {
    const f = await fixture(), debugLog = spyOn(logger, "debug");
    const files = { lstatSync, readdirSync, rmSync };
    try {
      const oldest = f.put(0, ["api:test"]);
      f.store.db.run("UPDATE run_dump_history SET directory_bytes = NULL, file_bytes = NULL, shared_bytes = NULL WHERE run_id = ?", [oldest.dump.runId]);
      const read = spyOn(files, "readdirSync").mockImplementation(() => { throw new Error("injected sizing failure"); });
      const retention = new RunRetention(f.store.db, RUN_DUMP_RETENTION, files);
      retention.prune();
      expect(f.store.db.query("SELECT directory_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId)).toEqual({ directory_bytes: null });
      read.mockRestore();
      const retry = spyOn(files, "readdirSync");
      retention.prune(); retention.prune();
      expect(retry.mock.calls).toHaveLength(1);
      expect(f.store.db.query("SELECT directory_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId))
        .toEqual({ directory_bytes: 50 + readFileSync(oldest.file).length });
      retry.mockRestore();
    } finally { debugLog.mockRestore(); f.close(); }
  });

  test("a failed profile deletion persists the remaining footprint and retries without remeasuring", async () => {
    const f = await fixture(), debugLog = spyOn(logger, "debug");
    const files = { lstatSync, readdirSync, rmSync };
    const read = spyOn(files, "readdirSync");
    try {
      const oldest = f.put(0, ["api:test"]); f.put(1, ["api:test"]);
      const contentBytes = readFileSync(oldest.file).length;
      const remove = spyOn(files, "rmSync").mockImplementation((path, options) => {
        if (path === oldest.file) throw new Error("injected profile deletion failure");
        rmSync(path, options);
      });
      const retention = new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 1 }, files);
      retention.prune();
      expect(existsSync(oldest.directory)).toBe(false); expect(existsSync(oldest.file)).toBe(true);
      expect(f.store.db.query("SELECT directory_bytes, file_bytes, shared_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId))
        .toEqual({ directory_bytes: 0, file_bytes: contentBytes, shared_bytes: 0 });
      expect(f.store.runDumps.get(oldest.dump.runId)).not.toBeNull();
      remove.mockRestore();
      retention.prune();
      expect(existsSync(oldest.file)).toBe(false);
      expect(f.store.runDumps.get(oldest.dump.runId)).toBeNull();
      expect(f.store.db.query("SELECT * FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); debugLog.mockRestore(); f.close(); }
  });

  test("pruning and legacy adoption return bounded metadata for inline dumps with exact UTF-8 accounting", async () => {
    const f = await fixture();
    try {
      const dumpJson = JSON.stringify({ events: ["界".repeat(100_000)] });
      const bytes = Buffer.byteLength(dumpJson);
      for (let i = 0; i < 4; i++) f.store.runDumps.put({ runId: `inline_${i}`, traceId: "trace", threadId: "thread",
        agentId: "test", projectId: null, createdAt: new Date(1_700_000_000_000 + i).toISOString(), dumpJson }, ["offline"]);
      // Exercise pre-retention adoption as well as the ordinary prune query.
      f.store.db.run("DELETE FROM run_dump_history");
      let returnedStringBytes = 0;
      const original = f.store.db.query.bind(f.store.db);
      const bounded = spyOn(f.store.db, "query").mockImplementation(((sql: string) => {
        const statement = original(sql);
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args as []);
          for (const row of rows) for (const value of Object.values(row as object))
            if (typeof value === "string") returnedStringBytes += Buffer.byteLength(value);
          return rows;
        }) as typeof statement.all;
        return statement;
      }) as typeof f.store.db.query);
      try {
        new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: bytes * 3 }).prune();
        expect(returnedStringBytes).toBeLessThan(64 * 1024);
        expect(f.store.db.query("SELECT run_id, bytes FROM run_backup_drops").all()).toEqual([{ run_id: "inline_0", bytes }]);
        expect(f.store.runDumps.list(10)).toHaveLength(3);
      } finally { bounded.mockRestore(); }
    } finally { f.close(); }
  });

  test.each(["measure", "delete"])("a persistent %s failure preserves its history while independent cleanup continues", async failure => {
    const f = await fixture();
    const files = { lstatSync, readdirSync, rmSync };
    try {
      const old = f.put(0), healthy = f.put(1), inaccessible = f.put(2, [], "inaccessible"), newest = f.put(3);
      if (failure === "measure") f.store.db.run("UPDATE run_dump_history SET directory_bytes = NULL, file_bytes = NULL, shared_bytes = NULL WHERE run_id = ?", [inaccessible.dump.runId]);
      const read = spyOn(files, "readdirSync").mockImplementation((path, ...args) => {
        if (path === inaccessible.directory) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return readdirSync(path, ...args as []) as ReturnType<typeof readdirSync>;
      });
      const remove = spyOn(files, "rmSync").mockImplementation((path, options) => {
        if (path === inaccessible.file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        rmSync(path, options);
      });
      try {
        const retention = new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, rows: 1, localRuns: 1 }, files);
        retention.prune(); retention.prune();
        expect(existsSync(old.directory)).toBe(false);
        expect(existsSync(healthy.directory)).toBe(false);
        expect(f.store.runDumps.list(10).map(row => row.runId).sort()).toEqual([inaccessible.dump.runId, newest.dump.runId].sort());
        expect(existsSync(inaccessible.directory)).toBe(true);
        expect(existsSync(inaccessible.file)).toBe(true);
        expect(f.store.db.query("SELECT directory_bytes FROM run_dump_history WHERE run_id = ?").get(inaccessible.dump.runId))
          .toEqual({ directory_bytes: failure === "measure" ? null : 50 + readFileSync(inaccessible.file).length });
        expect(f.store.db.query("SELECT * FROM run_backup_drops").all()).toEqual([]);
      } finally { read.mockRestore(); remove.mockRestore(); }
    } finally { f.close(); }
  });

  test("the cap preserves unmeasurable pending history and still drops healthy pending runs", async () => {
    const f = await fixture();
    const files = { lstatSync, readdirSync, rmSync };
    try {
      const unknown = f.put(0, ["offline"]), healthy = f.put(1, ["offline"]), newest = f.put(2, ["offline"]);
      f.store.db.run("UPDATE run_dump_history SET directory_bytes = NULL, file_bytes = NULL, shared_bytes = NULL WHERE run_id = ?", [unknown.dump.runId]);
      const read = spyOn(files, "readdirSync").mockImplementation((path, ...args) => {
        if (path === unknown.directory) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return readdirSync(path, ...args as []) as ReturnType<typeof readdirSync>;
      });
      const retention = new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 1 }, files);
      try {
        retention.prune(); retention.prune();
        expect(existsSync(unknown.directory)).toBe(true);
        expect(f.store.runDumps.get(unknown.dump.runId)).not.toBeNull();
        expect(f.store.db.query("SELECT directory_bytes FROM run_dump_history WHERE run_id = ?").get(unknown.dump.runId)).toEqual({ directory_bytes: null });
        expect(f.store.runDumps.get(healthy.dump.runId)).toBeNull();
        expect(existsSync(newest.directory)).toBe(true);
        expect(f.store.db.query("SELECT run_id FROM run_backup_drops").all()).toEqual([{ run_id: healthy.dump.runId }]);
      } finally { read.mockRestore(); }
      retention.prune();
      expect(f.store.runDumps.get(unknown.dump.runId)).toBeNull();
    } finally { f.close(); }
  });

  test("a failed cap deletion does not block dropping later histories or lose the remaining byte count", async () => {
    const f = await fixture();
    const files = { lstatSync, readdirSync, rmSync };
    try {
      const oldest = f.put(0, ["offline"]), middle = f.put(1, ["offline"]), newest = f.put(2, ["offline"]);
      const bytes = 50 + readFileSync(oldest.file).length + Buffer.byteLength(oldest.dump.dumpJson);
      const remove = spyOn(files, "rmSync").mockImplementation((path, options) => {
        if (path === oldest.file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        rmSync(path, options);
      });
      try {
        new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: bytes * 2 }, files).prune();
        expect(existsSync(oldest.directory)).toBe(false);
        expect(existsSync(oldest.file)).toBe(true);
        expect(existsSync(middle.directory)).toBe(false);
        expect(f.store.runDumps.get(middle.dump.runId)).toBeNull();
        expect(existsSync(newest.directory)).toBe(true);
        expect(f.store.db.query("SELECT run_id FROM run_backup_drops ORDER BY run_id").all())
          .toEqual([{ run_id: oldest.dump.runId }, { run_id: middle.dump.runId }]);
      } finally { remove.mockRestore(); }
      f.store.runDumps.retention.prune();
      expect(existsSync(oldest.file)).toBe(false);
    } finally { f.close(); }
  });

  test("cap drop racing accepted upload never records delivery", async () => {
    const f = await fixture();
    try {
      const oldest = f.put(0, ["api:test"]); f.put(1, ["api:test"]);
      let release!: () => void;
      const archive = new UsageArchive({ id: "api:test", async write() {}, async writeFile() { await new Promise<void>(resolve => { release = resolve; }); } });
      const upload = archive.put(oldest.dump, f.store.db);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 1 }).prune();
      release(); await upload;
      expect(f.store.db.query("SELECT * FROM usage_archive_uploads WHERE record_id = ?").all(`run-dump:${oldest.dump.runId}`)).toEqual([]);
    } finally { f.close(); }
  });

  test("malformed references and symlinked history parents cannot delete user data", async () => {
    const f = await fixture(), debugLog = spyOn(logger, "debug");
    try {
      const userFile = join(f.root, "user-project", "run-dumps", "run_000.json"); mkdirSync(join(f.root, "user-project", "run-dumps"), { recursive: true }); writeFileSync(userFile, "precious");
      const oldest = f.put(0);
      f.store.db.run("UPDATE run_dump_history SET file_path = ?, run_directory = ? WHERE run_id = ?", [userFile, f.root, oldest.dump.runId]);
      f.put(1);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, rows: 1, localRuns: 1 }).prune();
      expect(readFileSync(userFile, "utf8")).toBe("precious");
      const linked = join(f.root, "alias"); symlinkSync(join(f.root, "project"), linked);
      f.store.db.run("UPDATE run_dump_history SET run_directory = ? WHERE run_id = ?", [join(linked, ".fabdesk/runs/run_000"), oldest.dump.runId]);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, localRuns: 0 }).prune();
      expect(existsSync(oldest.directory)).toBe(true);
    } finally { debugLog.mockRestore(); f.close(); }
  });

  test("SQLite byte limit and newest protection apply with backup off", async () => {
    const f = await fixture();
    try {
      const oldest = f.put(0); const newest = f.put(1);
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, bytes: 1 }).prune();
      expect(f.store.runDumps.get(oldest.dump.runId)).toBeNull();
      expect(existsSync(oldest.file)).toBe(false);
      expect(f.store.runDumps.get(newest.dump.runId)).not.toBeNull();
      // The folder is still independently retained and remains eligible after its SQLite row goes.
      expect(existsSync(oldest.directory)).toBe(true);
      expect(f.store.db.query("SELECT directory_bytes, file_bytes, shared_bytes FROM run_dump_history WHERE run_id = ?").get(oldest.dump.runId))
        .toEqual({ directory_bytes: 50 + readFileSync(join(oldest.directory, "llm-dump.json")).length, file_bytes: 0, shared_bytes: 0 });
      new RunRetention(f.store.db, { ...RUN_DUMP_RETENTION, localRuns: 1 }).prune();
      expect(existsSync(oldest.directory)).toBe(false);
    } finally { f.close(); }
  });
});

test.each([1, 2])("snapshot retries a file changing %i time(s)", async changes => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-copy-retry-"));
  try {
    const file = join(root, "board.txt"); writeFileSync(file, "initial");
    let copies = 0;
    const result = await captureSnapshotFile(file, "board.txt", root, async (source, temporary) => {
      const content = readFileSync(source); writeFileSync(temporary, content);
      if (++copies <= changes) writeFileSync(source, `changed-${copies}`.repeat(copies));
      return createHash("sha256").update(content).digest("hex");
    });
    expect(copies).toBe(2);
    if (changes === 1) {
      expect(result.entry.error).toBeUndefined();
      expect(readFileSync(join(root, result.entry.sha256!), "utf8")).toBe("changed-1");
    } else expect(result.entry).toMatchObject({ path: "board.txt", sha256: null, error: "project file changed during snapshot after retry" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["deleted", "directory"])("file %s mid-copy becomes per-file error after retry", async mutation => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-copy-mutation-"));
  try {
    const file = join(root, "board.txt"); writeFileSync(file, "initial");
    const result = await captureSnapshotFile(file, "board.txt", root, async (source, temporary) => {
      const content = readFileSync(source); writeFileSync(temporary, content);
      rmSync(source); if (mutation === "directory") mkdirSync(source);
      return createHash("sha256").update(content).digest("hex");
    });
    expect(result.entry).toMatchObject({ path: "board.txt", sha256: null, error: "project file changed during snapshot after retry" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

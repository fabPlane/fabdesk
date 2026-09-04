import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, Store, ftsQuery, migrate, openDatabase, schemaVersion } from "../src/db";

describe("sqlite", () => {
  test("migrations are versioned and idempotent", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    for (const t of ["projects", "folders", "threads", "messages", "messages_fts", "runs", "jobs", "route_runs", "settings", "schema_migrations"]) expect(tables).toContain(t);
  });

  test("WAL on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-db-"));
    const db = openDatabase(join(dir, "nested", "fabdesk.db"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    db.close();
  });

  test("threads, branching, messages and FTS search", () => {
    const store = new Store(openDatabase(":memory:"));
    const t = store.threads.create({ agentId: "claude", title: "LED board" });
    store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Design a USB-C powered blinking LED board" });
    store.threads.addMessage({ threadId: t.id, role: "assistant", contentMd: "Sure, I will use a 555 timer." });
    const m3 = store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Use an ESP32 instead" });
    store.threads.addMessage({ threadId: t.id, role: "assistant", contentMd: "Switching to ESP32-C3." });
    expect(store.threads.messages(t.id).length).toBe(4);

    // Branch at message 3 copies the first three messages.
    const b = store.threads.create({ agentId: "codex", parentThreadId: t.id, branchFromMessageId: m3.id });
    expect(b.parentThreadId).toBe(t.id);
    expect(b.title).toBe("LED board (branch)");
    expect(store.threads.messages(b.id).map((m) => m.contentMd)).toEqual(["Design a USB-C powered blinking LED board", "Sure, I will use a 555 timer.", "Use an ESP32 instead"]);

    // FTS: prefix + phrase; punctuation safe.
    expect(store.threads.search("esp32").length).toBe(3);
    expect(store.threads.search("usb-c pow").map((r) => r.message.threadId).sort()).toEqual([b.id, t.id].sort());
    expect(store.threads.search('"weird" (query)')).toEqual([]);
    expect(store.threads.list({ q: "555" }).map((x) => x.id).sort()).toEqual([b.id, t.id].sort());
    expect(store.threads.list({ q: "LED" }).length).toBe(2);
    expect(store.threads.list({ q: "nothing-here" })).toEqual([]);

    // Pin / archive / folder / delete.
    const f = store.folders.create("Boards");
    store.threads.patch(t.id, { pinned: true, folderId: f.id });
    expect(store.threads.list()[0]!.id).toBe(t.id);
    expect(store.threads.list({ folderId: f.id }).length).toBe(1);
    store.threads.patch(b.id, { archived: true });
    expect(store.threads.list({ archived: false }).length).toBe(1);
    expect(store.threads.delete(b.id)).toBe(true);
    expect(store.threads.messages(b.id)).toEqual([]);
    expect(store.threads.search("esp32").length).toBe(2);
  });

  test("runs, jobs, route runs, settings", () => {
    const store = new Store(openDatabase(":memory:"));
    const t = store.threads.create({ agentId: "claude" });
    const run = store.runs.create({ threadId: t.id, agentId: "claude" });
    store.runs.setSession(run.id, "sess-1");
    store.runs.finish(run.id, { status: "completed", exitCode: 0, cost: { usd: 0.01 } });
    expect(store.runs.get(run.id)!.status).toBe("completed");
    expect(store.runs.lastSession(t.id, "claude")).toBe("sess-1");
    expect(store.runs.lastSession(t.id, "codex")).toBeNull();

    store.jobs.insert({ id: "job_1", kind: "tool:circuit_build", projectId: null });
    store.jobs.update("job_1", { status: "running", startedAt: "now" });
    expect(store.jobs.failStale()).toBe(1);
    expect(store.jobs.get("job_1")!.status).toBe("failed");

    store.routeRuns.start({ id: "run_1", projectId: "p1", router: "capacity", framesPath: "/x/frames.jsonl", startedAt: "now" });
    expect(store.routeRuns.latest("p1")!.status).toBe("running");
    store.routeRuns.finish("run_1", { status: "done", result: { runId: "run_1", router: "capacity", traces: [], complete: ["N1"], open: [], timedOut: false, stats: { vias: 0, segments: 1, wallMs: 3, frames: 2 } }, error: null });
    expect(store.routeRuns.get("run_1")!.result!.complete).toEqual(["N1"]);

    expect(store.settings.get().router).toBe("capacity");
    const s = store.settings.patch({ kicadCliPath: "/usr/bin/kicad-cli", keepCoreRunning: true });
    expect(s.kicadCliPath).toBe("/usr/bin/kicad-cli");
    expect(new Store(store.db).settings.get().keepCoreRunning).toBe(true);
    expect(() => store.settings.patch({ router: "bogus" })).toThrow();
  });

  test("thread pin persists across database reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-db-pin-"));
    const path = join(dir, "fabdesk.db");
    const store = new Store(openDatabase(path));
    const older = store.threads.create({ agentId: "claude", title: "Keep me" });
    const newer = store.threads.create({ agentId: "claude", title: "Newer" });
    store.threads.patch(older.id, { pinned: true });
    expect(store.threads.get(older.id)!.pinned).toBe(true);
    expect(store.threads.list().map((t) => t.id)).toEqual([older.id, newer.id]);
    store.db.close();

    const reopened = new Store(openDatabase(path));
    expect(reopened.threads.get(older.id)!.pinned).toBe(true);
    expect(reopened.threads.list().map((t) => t.id)).toEqual([older.id, newer.id]);
    reopened.threads.patch(older.id, { pinned: false });
    expect(reopened.threads.get(older.id)!.pinned).toBe(false);
    reopened.db.close();

    const unpinned = new Store(openDatabase(path));
    expect(unpinned.threads.get(older.id)!.pinned).toBe(false);
    expect(unpinned.threads.list().map((t) => t.id)).toEqual([newer.id, older.id]);
    unpinned.db.close();
  });

  test("ftsQuery quoting", () => {
    expect(ftsQuery("hello world")).toBe('"hello" "world"*');
    expect(ftsQuery('  a "b" ')).toBe('"a" "b"*');
    expect(ftsQuery("")).toBe('""');
  });
});

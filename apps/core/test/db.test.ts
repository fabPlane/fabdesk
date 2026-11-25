import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRunRecord } from "@fabdesk/tools";
import {
  MIGRATIONS,
  RUN_DUMP_RETENTION,
  Store,
  ftsQuery,
  migrate,
  openDatabase,
  schemaVersion,
} from "../src/db";

function routeRecord(id: string, state: RouteRunRecord["state"] = "running"): RouteRunRecord {
  const at = "2026-09-17T00:00:00.000Z";
  const runDir = `.fabdesk/runs/${id}`;
  return {
    id,
    projectId: "p1",
    router: "fab_router",
    runtimeId: "test",
    state,
    status: state,
    framesPath: `${runDir}/frames.jsonl`,
    artifacts: {
      runDir,
      request: `${runDir}/request.json`,
      progress: `${runDir}/progress.json`,
      frames: `${runDir}/frames.jsonl`,
      log: `${runDir}/router.log`,
      result: `${runDir}/result.json`,
      candidate: `${runDir}/candidate.kicad_pcb`,
      diff: `${runDir}/diff.json`,
    },
    request: {
      timeoutMs: 1000,
      deadlineAt: at,
      onlyConnections: null,
      targets: null,
      rules: null,
      settings: null,
      applyPolicy: "manual",
    },
    startingPcbRevision: "a".repeat(64),
    currentPcbRevision: "a".repeat(64),
    canonicalMatchesStart: true,
    progress: {
      phase: state,
      pass: null,
      routed: null,
      total: null,
      remaining: null,
      violations: null,
      elapsedMs: 0,
      measuredAt: at,
      heartbeatAt: at,
      diagnostics: [],
    },
    candidate: {
      available: false,
      identity: null,
      sha256: null,
      bytes: null,
      path: `${runDir}/candidate.kicad_pcb`,
      reopenable: false,
      inspectedAt: null,
      limitation: null,
      diff: null,
    },
    application: {
      policy: "manual",
      state: "not_available",
      expectedPcbRevision: "a".repeat(64),
      resultingPcbRevision: null,
      appliedAt: null,
      reason: null,
    },
    startedAt: at,
    updatedAt: at,
    endedAt: null,
    result: null,
    error: null,
    terminalReason: null,
  };
}

describe("sqlite", () => {
  test("migrations are versioned and idempotent", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    for (const t of [
      "projects",
      "folders",
      "threads",
      "messages",
      "messages_fts",
      "runs",
      "run_dumps",
      "jobs",
      "route_runs",
      "settings",
      "schema_migrations",
      "funnel_events",
    ])
      expect(tables).toContain(t);
  });

  test("WAL on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-db-"));
    const db = openDatabase(join(dir, "nested", "fabdesk.db"));
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );
    db.close();
  });

  test("threads, branching, messages and FTS search", () => {
    const store = new Store(openDatabase(":memory:"));
    const t = store.threads.create({ agentId: "claude", title: "LED board" });
    store.threads.addMessage({
      threadId: t.id,
      role: "user",
      contentMd: "Design a USB-C powered blinking LED board",
    });
    store.threads.addMessage({
      threadId: t.id,
      role: "assistant",
      contentMd: "Sure, I will use a 555 timer.",
    });
    const m3 = store.threads.addMessage({
      threadId: t.id,
      role: "user",
      contentMd: "Use an ESP32 instead",
    });
    store.threads.addMessage({
      threadId: t.id,
      role: "assistant",
      contentMd: "Switching to ESP32-C3.",
    });
    expect(store.threads.messages(t.id).length).toBe(4);

    // Branch at message 3 copies the first three messages.
    const b = store.threads.create({
      agentId: "codex",
      parentThreadId: t.id,
      branchFromMessageId: m3.id,
    });
    expect(b.parentThreadId).toBe(t.id);
    expect(b.title).toBe("LED board (branch)");
    expect(store.threads.messages(b.id).map((m) => m.contentMd)).toEqual([
      "Design a USB-C powered blinking LED board",
      "Sure, I will use a 555 timer.",
      "Use an ESP32 instead",
    ]);

    // FTS: prefix + phrase; punctuation safe.
    expect(store.threads.search("esp32").length).toBe(3);
    expect(
      store.threads
        .search("usb-c pow")
        .map((r) => r.message.threadId)
        .sort(),
    ).toEqual([b.id, t.id].sort());
    expect(store.threads.search('"weird" (query)')).toEqual([]);
    expect(
      store.threads
        .list({ q: "555" })
        .map((x) => x.id)
        .sort(),
    ).toEqual([b.id, t.id].sort());
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
    store.runDumps.put({
      runId: run.id,
      traceId: "trace-1",
      threadId: t.id,
      agentId: "claude",
      projectId: null,
      createdAt: "2026-09-09T00:00:00.000Z",
      dumpJson: '{"schema":"fabdesk.llm-run-dump/v1"}\n',
    });
    expect(store.runDumps.get(run.id)?.dumpJson).toContain("fabdesk.llm-run-dump/v1");
    expect(store.runDumps.list()).toHaveLength(1);

    store.jobs.insert({ id: "job_1", kind: "tool:circuit_build", projectId: null });
    store.jobs.update("job_1", { status: "running", startedAt: "now" });
    expect(store.jobs.failStale()).toBe(1);
    expect(store.jobs.get("job_1")!.status).toBe("failed");

    store.routeRuns.start(routeRecord("run_1"));
    expect(store.routeRuns.latest("p1")!.status).toBe("running");
    store.routeRuns.update("run_1", {
      state: "completed",
      status: "completed",
      result: {
        runId: "run_1",
        router: "fab_router",
        complete: ["N1"],
        open: [],
        timedOut: false,
        stats: { vias: 0, segments: 1, wallMs: 3, frames: 2 },
        changedGeometryCount: 0,
      },
      error: null,
    });
    expect(store.routeRuns.get("run_1")!.result!.complete).toEqual(["N1"]);
    // A route still running at startup was cut off by the restart.
    store.routeRuns.start(routeRecord("run_2"));
    expect(store.routeRuns.failStale()).toBe(1);
    expect(store.routeRuns.get("run_2")).toMatchObject({
      status: "interrupted",
      error: "daemon restarted while routing",
    });
    expect(store.routeRuns.get("run_1")!.status).toBe("completed");

    expect(store.settings.get().router).toBe("fab_router");
    const s = store.settings.patch({ kicadCliPath: "/usr/bin/kicad-cli", keepCoreRunning: true });
    expect(s.kicadCliPath).toBe("/usr/bin/kicad-cli");
    expect(new Store(store.db).settings.get().keepCoreRunning).toBe(true);
    expect(() => store.settings.patch({ router: "bogus" })).toThrow();
  });

  test("run history keeps branch references without scanning unrelated runs", () => {
    const db = openDatabase(":memory:");
    const store = new Store(db);
    const parent = store.threads.create({ agentId: "codex" });
    const run = store.runs.create({ threadId: parent.id, agentId: "codex" });
    const message = store.threads.addMessage({ threadId: parent.id, role: "assistant", runId: run.id, contentMd: "Done" });
    const branch = store.threads.create({ agentId: "codex", parentThreadId: parent.id, branchFromMessageId: message.id });
    expect(store.runs.historyForThread(branch.id).map((r) => r.id)).toEqual([run.id]);
    expect(store.runs.historyForThread(parent.id).map((r) => r.id)).toEqual([run.id]);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM runs WHERE thread_id = ? UNION SELECT * FROM runs WHERE id IN (SELECT run_id FROM messages WHERE thread_id = ? AND run_id IS NOT NULL) ORDER BY started_at DESC, id DESC").all(parent.id, parent.id);
    expect(JSON.stringify(plan)).toContain("runs_thread_started");
    expect(JSON.stringify(plan)).not.toContain("SCAN runs");
    db.close();
  });

  test("upgrade repairs a development database with the draft run index at version 10", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 9)) {
      migration.up?.(db);
      db.run(migration.sql);
      db.run("INSERT INTO schema_migrations VALUES (?, ?)", [migration.version, new Date().toISOString()]);
    }
    db.run("CREATE INDEX runs_thread_started ON runs(thread_id, started_at DESC)");
    db.run("INSERT INTO schema_migrations VALUES (10, ?)", [new Date().toISOString()]);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(run_dumps)").all().map((c) => c.name)).toContain("archive_destinations_json");
    expect(db.query<{ name: string }, []>("PRAGMA table_info(run_dump_history)").all().map((c) => c.name)).toContain("directory_bytes");
    db.close();
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
    reopened.threads.patch(newer.id, { pinned: true });
    expect(reopened.threads.get(older.id)!.pinned).toBe(false);
    expect(reopened.threads.get(newer.id)!.pinned).toBe(true);
    reopened.db.close();

    const swapped = new Store(openDatabase(path));
    expect(swapped.threads.get(older.id)!.pinned).toBe(false);
    expect(swapped.threads.get(newer.id)!.pinned).toBe(true);
    expect(swapped.threads.list().map((t) => t.id)).toEqual([newer.id, older.id]);
    swapped.db.close();
  });

  test("daemon interruption is terminal and preserves durable candidate metadata", () => {
    const store = new Store(openDatabase(":memory:"));
    const running = routeRecord("run_interrupted");
    running.candidate = {
      available: true,
      identity: "run_interrupted:candidate",
      sha256: "b".repeat(64),
      bytes: 1234,
      path: ".fabdesk/runs/run_interrupted/candidate.kicad_pcb",
      reopenable: true,
      inspectedAt: running.startedAt,
      limitation: null,
      diff: { tracks: { before: 0, after: 1, changed: 1 } },
    };
    store.routeRuns.start(running);
    expect(store.routeRuns.failStale()).toBe(1);
    expect(store.routeRuns.get(running.id)).toMatchObject({
      state: "interrupted",
      status: "interrupted",
      terminalReason: expect.stringContaining("candidate and artifacts were preserved"),
      candidate: { available: true, identity: "run_interrupted:candidate", reopenable: true },
    });
  });

  test("run dump retention removes the oldest rows", () => {
    const store = new Store(openDatabase(":memory:"));
    for (let index = 0; index <= RUN_DUMP_RETENTION.rows; index++) {
      const suffix = String(index).padStart(3, "0");
      store.runDumps.put({
        runId: `run_${suffix}`,
        traceId: `trace_${suffix}`,
        threadId: "thread_1",
        agentId: "codex",
        projectId: null,
        createdAt: `2026-09-09T00:00:00.${suffix}Z`,
        dumpJson: "{}",
      });
    }
    expect(store.runDumps.list(RUN_DUMP_RETENTION.rows + 1)).toHaveLength(RUN_DUMP_RETENTION.rows);
    expect(store.runDumps.get("run_000")).toBeNull();
    store.close();
  });

  test("run dump retention keeps pending dumps below the storage cap, including after opt-out", () => {
    const store = new Store(openDatabase(":memory:"));
    const destinations = ["api:test"];
    const put = (index: number) => {
      const suffix = String(index).padStart(3, "0");
      store.runDumps.put(
        {
          runId: `run_${suffix}`,
          traceId: `trace_${suffix}`,
          threadId: "thread_1",
          agentId: "codex",
          projectId: null,
          createdAt: `2026-09-09T00:00:00.${suffix}Z`,
          dumpJson: "{}",
        },
        destinations,
      );
    };
    const count = () => store.runDumps.list(1_000).length;
    for (let index = 0; index < RUN_DUMP_RETENTION.rows + 10; index++) put(index);
    // Nothing has been backed up yet, so retention keeps every dump past the normal limit.
    expect(count()).toBe(RUN_DUMP_RETENTION.rows + 10);
    // Once the oldest five are recorded as uploaded, the next put prunes exactly those.
    for (let index = 0; index < 5; index++)
      store.db.run(
        "INSERT INTO usage_archive_uploads(destination, record_id, sha256, uploaded_at) VALUES (?, ?, ?, ?)",
        ["api:test", `run-dump:run_${String(index).padStart(3, "0")}`, "x", "2026-09-09T00:00:00Z"],
      );
    put(RUN_DUMP_RETENTION.rows + 10);
    expect(count()).toBe(RUN_DUMP_RETENTION.rows + 6);
    expect(store.runDumps.get("run_004")).toBeNull();
    expect(store.runDumps.get("run_005")).not.toBeNull();
    // Pending records survive beyond the old 200-row ceiling.
    for (
      let index = RUN_DUMP_RETENTION.rows + 11;
      index < 220;
      index++
    )
      put(index);
    expect(count()).toBe(215);
    // Another run while sharing is off cannot erase previous pending backups.
    store.runDumps.put({ runId: "after_optout", traceId: "trace", threadId: "thread_1", agentId:"codex",projectId:null,createdAt:"2026-10-01T00:00:00Z",dumpJson:"{}" });
    expect(store.runDumps.get("run_005")).not.toBeNull();
    store.close();
  });

  test("ftsQuery quoting", () => {
    expect(ftsQuery("hello world")).toBe('"hello" "world"*');
    expect(ftsQuery('  a "b" ')).toBe('"a" "b"*');
    expect(ftsQuery("")).toBe('""');
  });
});

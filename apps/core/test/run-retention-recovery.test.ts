import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { ProjectStore } from "../src/projects";
import { RUN_DUMP_RETENTION, RunRetention } from "../src/run-retention";
import { RunTelemetry } from "../src/run-telemetry";

test("project purge reconciles cached directory and shared bytes before enforcing the pending cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-purge-accounting-"));
  const store = Store.open(join(root, "fabdesk.db"));
  const projects = new ProjectStore(store.projects, join(root, "projects"), () => {}, { watch: false });
  try {
    await projects.init();
    const project = await projects.create("Gone");
    const put = (index: number, path: string) => {
      const runId = `run_${index}`, directory = join(path, ".fabdesk", "runs", runId);
      const file = join(root, "run-dumps", `${runId}.json`);
      mkdirSync(directory, { recursive: true }); mkdirSync(join(root, "run-dumps"), { recursive: true });
      writeFileSync(join(directory, "trace.jsonl"), "t".repeat(300_000));
      const content = JSON.stringify({ events: ["x".repeat(400_000)] });
      writeFileSync(join(directory, "llm-dump.json"), content);
      linkSync(join(directory, "llm-dump.json"), file);
      const dump = { runId, traceId: "trace", threadId: "absent", agentId: "test", projectId: null,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(), runDirectory: directory,
        dumpJson: JSON.stringify({ schema: "fabdesk.llm-run-file/v1", path: file, bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex") }) };
      store.runDumps.put(dump, ["offline"]);
      return { file, dump };
    };
    const first = put(0, project.path), second = put(1, project.path);
    await projects.delete(project.id, { purge: true });
    const third = put(2, join(root, "surviving-project"));
    new RunRetention(store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 2_000_000 }).prune();
    expect(store.db.query("SELECT * FROM run_backup_drops").all()).toEqual([]);
    expect([first, second, third].every(run => existsSync(run.file))).toBe(true);
    for (const run of [first, second]) expect(store.db.query(
      "SELECT run_directory, directory_bytes, file_bytes, shared_bytes FROM run_dump_history WHERE run_id = ?",
    ).get(run.dump.runId)).toEqual({ run_directory: null, directory_bytes: 0,
      file_bytes: readFileSync(run.file).length, shared_bytes: 0 });
  } finally { projects.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an abruptly interrupted capture remains indexed and is pruned after 50 completed captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-interrupted-retention-"));
  let store: Store | undefined;
  let telemetry: RunTelemetry | undefined;
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/interrupted-run.ts"), root],
      { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    const interrupted = JSON.parse(output) as { runId: string; threadId: string };
    store = Store.open(join(root, "fabdesk.db"));
    store.runs.failStale();
    telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
    for (let i = 0; i < 50; i++) {
      const run = store.runs.create({ threadId: interrupted.threadId, agentId: "claude" });
      const trace = await telemetry.startAgentRun({ runId: run.id, threadId: interrupted.threadId,
        agentId: "claude", projectId: null, cwd: join(root, "project"), prompt: "completed" });
      store.runs.setLogPath(run.id, trace.logPath);
      await trace.finish("completed");
      store.runs.finish(run.id, { status: "completed" });
    }
    expect(await readdir(join(root, "project/.fabdesk/runs"))).toHaveLength(50);
    expect(existsSync(join(root, "project/.fabdesk/runs", interrupted.runId))).toBe(false);
    expect(store.runs.get(interrupted.runId)?.status).toBe("failed");
  } finally { await telemetry?.shutdown(); store?.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy interrupted captures are recovered only from owned runs.log_path directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-legacy-interrupted-"));
  let store = Store.open(join(root, "fabdesk.db"));
  try {
    const thread = store.threads.create({ agentId: "claude" });
    const run = store.runs.create({ threadId: thread.id, agentId: "claude" });
    const directory = join(root, "project/.fabdesk/runs", run.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "trace.jsonl"), "interrupted trace");
    store.runs.setLogPath(run.id, join(directory, "trace.jsonl"));
    const other = store.runs.create({ threadId: thread.id, agentId: "claude", logPath: join(root, "precious.txt") });
    writeFileSync(join(root, "precious.txt"), "keep");
    store.close(); store = Store.open(join(root, "fabdesk.db"));
    expect(store.db.query("SELECT run_directory, directory_bytes FROM run_dump_history WHERE run_id = ?").get(run.id))
      .toEqual({ run_directory: directory, directory_bytes: 17 });
    expect(store.db.query("SELECT * FROM run_dump_history WHERE run_id = ?").get(other.id)).toBeNull();
    expect(readFileSync(join(root, "precious.txt"), "utf8")).toBe("keep");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("dump creation failure leaves a measured history that normal folder retention can clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-failed-finalization-"));
  const store = Store.open(join(root, "fabdesk.db"));
  const telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
  try {
    const trace = await telemetry.startAgentRun({ runId: "failed", threadId: "absent", agentId: "test",
      projectId: null, cwd: root, prompt: "failure" });
    // Make the final dump's temporary file impossible to open.
    mkdirSync(join(root, ".fabdesk/runs/failed/llm-dump.json.part"));
    await trace.finish("failed");
    expect(store.runDumps.get("failed")).toBeNull();
    expect(store.db.query<{ directory_bytes: number }, []>("SELECT directory_bytes FROM run_dump_history").get()!.directory_bytes)
      .toBeGreaterThan(0);
    const next = await telemetry.startAgentRun({ runId: "next", threadId: "absent", agentId: "test",
      projectId: null, cwd: root, prompt: "next" });
    await next.finish("completed");
    new RunRetention(store.db, { ...RUN_DUMP_RETENTION, localRuns: 1 }).prune();
    expect(existsSync(join(root, ".fabdesk/runs/failed"))).toBe(false);
  } finally { await telemetry.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("capture ownership and destinations survive restart while active growth is never cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-active-capture-"));
  const store = Store.open(join(root, "fabdesk.db"));
  try {
    const directory = join(root, ".fabdesk/runs/active");
    store.runDumps.begin("active", { createdAt: new Date().toISOString(), runDirectory: directory }, ["offline"]);
    // A prune can interleave with the asynchronous directory creation.
    store.runDumps.retention.prune();
    expect(store.db.query("SELECT run_directory, destinations_json, directory_bytes FROM run_dump_history").get())
      .toEqual({ run_directory: directory, destinations_json: '["offline"]', directory_bytes: null });
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "trace.jsonl"), "small");
    store.runDumps.retention.prune();
    expect(store.db.query("SELECT directory_bytes FROM run_dump_history").get()).toEqual({ directory_bytes: null });
    writeFileSync(join(directory, "trace.jsonl"), "larger trace".repeat(100));
    store.runDumps.end("active");
    const reopened = Store.open(join(root, "fabdesk.db"));
    try {
      expect(reopened.db.query("SELECT run_directory, destinations_json, directory_bytes FROM run_dump_history").get())
        .toEqual({ run_directory: directory, destinations_json: '["offline"]', directory_bytes: 1200 });
    } finally { reopened.close(); }
    // Losing consent during finalization cannot release the original backup requirement.
    store.runDumps.put({ runId: "active", traceId: "trace", threadId: "absent", agentId: "test", projectId: null,
      createdAt: new Date().toISOString(), runDirectory: directory, dumpJson: "{}" }, []);
    expect(store.db.query("SELECT destinations_json FROM run_dump_history").get()).toEqual({ destinations_json: '["offline"]' });
    expect(store.db.query("SELECT archive_destinations_json FROM run_dumps").get()).toEqual({ archive_destinations_json: '["offline"]' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending cap includes current active bytes while preserving the active capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-active-bytes-"));
  const store = Store.open(join(root, "fabdesk.db"));
  try {
    store.runDumps.put({ runId: "old", traceId: "trace", threadId: "absent", agentId: "test", projectId: null,
      createdAt: "2023-01-01T00:00:00Z", dumpJson: JSON.stringify({ events: ["x".repeat(1000)] }) }, ["offline"]);
    const directory = join(root, ".fabdesk/runs/active");
    store.runDumps.begin("active", { createdAt: new Date().toISOString(), runDirectory: directory }, ["offline"]);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "trace.jsonl"), "small");
    const retention = new RunRetention(store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 2000 });
    retention.prune();
    expect(store.runDumps.get("old")).not.toBeNull();
    writeFileSync(join(directory, "trace.jsonl"), "x".repeat(1200));
    retention.prune();
    expect(store.runDumps.get("old")).toBeNull();
    expect(existsSync(directory)).toBe(true);
    expect(store.db.query("SELECT directory_bytes FROM run_dump_history WHERE run_id = 'active'").get())
      .toEqual({ directory_bytes: null });
    expect(store.db.query("SELECT run_id FROM run_backup_drops").all()).toEqual([{ run_id: "old" }]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

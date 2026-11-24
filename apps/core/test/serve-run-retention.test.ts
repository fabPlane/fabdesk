import { expect, spyOn, test } from "bun:test";
import { realpath, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreServices } from "@fabdesk/tools";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { serve, type Daemon } from "../src/serve";
import { Store } from "../src/db";
import { RUN_DUMP_RETENTION } from "../src/run-retention";
import { UsageArchive } from "../src/usage-archive";

// Use the canonical OS temp root: retention deliberately refuses symlink ancestors.
test("serve retains 50 run folders with remote backup 0 and attempts no uploads", async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "fabdesk-serve-retention-"));
  await writeFile(join(home, ".fabdesk-dev"), "");
  const overrides = {
    FABDESK_USAGE_ARCHIVE_DIR: undefined,
    FABDESK_USAGE_REMOTE_BACKUP: "0",
    FABDESK_PROJECTS_DIR: join(home, "projects"),
    FABDESK_PRIVACY_SCREEN: "never",
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const upload = spyOn(UsageArchive.prototype, "put");
  const backfill = spyOn(UsageArchive.prototype, "backfill");
  let daemon: Daemon | undefined;
  try {
    daemon = await serve({
      port: 0, dataDir: home, localAuth: true, quiet: true, noHandshake: true, watchProjects: false,
      services: ({ projects }) => mockServices([], { projects }) as unknown as CoreServices,
      adapters: { claude: { id: "claude", run: () => ({
        events: (async function* () { yield { type: "done" as const, exitCode: 0, sessionId: "retention" }; })(),
        abort() {},
      }) } },
    });
    daemon.store.settings.patch({ usageArchiveConsent: true, usageArchiveChoiceComplete: true });
    const project = await daemon.projects.create("Retention");
    const handle = await daemon.projects.handle(project.id);
    const thread = daemon.store.threads.create({ agentId: "claude", projectId: project.id });
    for (let i = 0; i < 52; i++) {
      await daemon.runs.start({ threadId: thread.id, project: handle, agentId: "claude", prompt: "test", attachments: [] });
      expect(await daemon.runs.settleAll(5_000)).toBe(true);
    }
    expect(await readdir(join(project.path, ".fabdesk", "runs"))).toHaveLength(50);
    expect(daemon.store.runDumps.list(100)).toHaveLength(52);
    expect(daemon.store.db.query("SELECT DISTINCT destinations_json FROM run_dump_history").all()).toEqual([{ destinations_json: "[]" }]);
    expect(upload).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
    expect(daemon.store.db.query("SELECT * FROM usage_archive_uploads").all()).toEqual([]);
  } finally {
    await daemon?.close("retention test");
    upload.mockRestore(); backfill.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);


test.each([false, true])("serve continues backfill after a cap drop unless consent is revoked (%s)", async revoke => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "fabdesk-backfill-drop-"));
  await writeFile(join(home, ".fabdesk-dev"), "");
  const overrides = { FABDESK_USAGE_ARCHIVE_DIR: undefined, FABDESK_USAGE_REMOTE_BACKUP: "1",
    FABDESK_PROJECTS_DIR: join(home, "projects"), FABDESK_PRIVACY_SCREEN: "never", FABPLANE_API_ORIGIN: "https://retention.invalid" };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const seed = Store.open(join(home, "fabdesk.db"));
  seed.settings.patch({ usageArchiveConsent: true, usageArchiveChoiceComplete: true });
  const installationId = "550e8400-e29b-41d4-a716-446655440000";
  seed.settings.writeRaw("usage_archive_installation", { installationId, token: `${installationId}.${"a".repeat(64)}` });
  for (let i = 0; i < 3; i++) seed.runDumps.put({ runId: `run_${i}`, traceId: "trace", threadId: "missing-thread",
    agentId: "test", projectId: null, createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    dumpJson: JSON.stringify({ events: [i < 2 ? "x".repeat(600 * 1024) : "newest"] }) }, ["api:https://retention.invalid"]);
  seed.close();
  let started!: () => void, release!: () => void, completed!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    if (!String(input).startsWith("https://retention.invalid/v1/usage-archive")) throw new Error(`unexpected request: ${input}`);
    requests.push(new Headers(init?.headers).get("x-fabdesk-archive-key")!);
    if (requests.length === 1) { started(); await gate; }
    return new Response(null, { status: 201 });
  }) as typeof fetch);
  const original = UsageArchive.prototype.backfill;
  const backfill = spyOn(UsageArchive.prototype, "backfill").mockImplementation(async function(...args) {
    try { return await original.apply(this, args); } finally { completed(); }
  });
  const timeout = spyOn(globalThis, "setTimeout");
  const oldCap = RUN_DUMP_RETENTION.pendingBytes;
  let daemon: Daemon | undefined;
  try {
    daemon = await serve({ port: 0, dataDir: home, localAuth: true, quiet: true, noHandshake: true, watchProjects: false,
      services: () => mockServices() as unknown as CoreServices });
    await start;
    (RUN_DUMP_RETENTION as { pendingBytes: number }).pendingBytes = 800_000;
    daemon.store.runDumps.retention.prune();
    if (revoke) daemon.store.settings.patch({ usageArchiveConsent: false });
    release();
    await done;
    expect(daemon.store.db.query("SELECT run_id FROM run_backup_drops").all()).toEqual([{ run_id: "run_0" }]);
    expect(daemon.store.runDumps.list(10)).toHaveLength(2);
    expect(daemon.store.db.query("SELECT record_id FROM usage_archive_uploads ORDER BY record_id").all())
      .toEqual(revoke ? [] : [{ record_id: "run-dump:run_1" }, { record_id: "run-dump:run_2" }]);
    expect(requests).not.toContain("run-dumps/run_0.json");
    expect(requests.includes("run-dumps/run_1.json")).toBe(!revoke);
    expect(requests.includes("run-dumps/run_2.json")).toBe(!revoke);
    expect(timeout.mock.calls.filter(([, ms]) => ms === 30 * 60_000)).toHaveLength(0);
    expect(daemon.store.db.query("SELECT * FROM settings WHERE key LIKE 'usage_archive_part_%'").all()).toEqual([]);
  } finally {
    release();
    await daemon?.close("backfill drop test");
    (RUN_DUMP_RETENTION as { pendingBytes: number }).pendingBytes = oldCap;
    fetchSpy.mockRestore(); backfill.mockRestore(); timeout.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

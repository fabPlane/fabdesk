import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db";
import { RUN_DUMP_RETENTION, RunRetention } from "../src/run-retention";
import { ArchiveConsentRevokedError, UsageArchive } from "../src/usage-archive";
import { fileDumpReference } from "../src/run-dump-file";

// Canonical temp roots keep retention deletion tests inside a symlink-free owned tree.
test.each([false, true])("source I/O failure after a cap drop continues survivors unless consent is revoked (%s)", async revoke => {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "fabdesk-writer-drop-"));
  const destination = join(root, "backup"), store = Store.open(join(root, "fabdesk.db"));
  const archive = new UsageArchive(destination);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let consent = true;
  let mkdirSpy: ReturnType<typeof spyOn> | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      const runId = `run_${i}`, path = join(root, "run-dumps", `${runId}.json`);
      await fs.mkdir(join(root, "run-dumps"), { recursive: true });
      await fs.writeFile(path, JSON.stringify({ events: ["x".repeat(600_000)], i }));
      store.runDumps.put({ runId, traceId: "trace", threadId: "absent", agentId: "test", projectId: null,
        createdAt: new Date(1_700_000_000_000 + i).toISOString(), dumpJson: await fileDumpReference(path) }, [archive.destination]);
    }
    const original = fs.mkdir;
    let once = true;
    mkdirSpy = spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await original(...args);
      if (once && args[0] === join(destination, "run-dumps")) { once = false; entered(); await gate; }
      return result;
    });
    const pending = archive.backfill(store.db, () => consent).then(result => ({ result }), error => ({ error }));
    await started;
    new RunRetention(store.db, { ...RUN_DUMP_RETENTION, pendingBytes: 1_250_000 }).prune();
    if (revoke) consent = false;
    release();
    const outcome = await pending;
    if (revoke) {
      expect(outcome).toHaveProperty("error", expect.any(ArchiveConsentRevokedError));
      expect(store.db.query("SELECT record_id FROM usage_archive_uploads").all()).toEqual([]);
    } else {
      expect(outcome).toEqual({ result: { conversations: 0, runDumps: 2, tooLarge: 0 } });
      expect(store.db.query("SELECT record_id FROM usage_archive_uploads ORDER BY record_id").all())
        .toEqual([{ record_id: "run-dump:run_1" }, { record_id: "run-dump:run_2" }]);
      expect(JSON.parse(await fs.readFile(join(destination, "run-dumps/run_1.json"), "utf8"))).toHaveProperty("i", 1);
    }
    await expect(fs.stat(join(destination, "run-dumps/run_0.json"))).rejects.toHaveProperty("code", "ENOENT");
  } finally { release(); mkdirSpy?.mockRestore(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("source I/O failure without a durable drop still rejects backfill", async () => {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "fabdesk-writer-missing-"));
  const store = Store.open(join(root, "fabdesk.db"));
  try {
    const source = join(root, "source.json");
    await fs.writeFile(source, "{}");
    store.runDumps.put({ runId: "missing", traceId: "trace", threadId: "absent", agentId: "test",
      projectId: null, createdAt: new Date().toISOString(), dumpJson: await fileDumpReference(source) });
    await fs.rm(source);
    await expect(new UsageArchive(join(root, "backup")).backfill(store.db)).rejects.toHaveProperty("code", "ENOENT");
    expect(store.db.query("SELECT * FROM usage_archive_uploads").all()).toEqual([]);
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

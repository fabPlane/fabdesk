import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { ArchiveConsentRevokedError, UsageArchive } from "../src/usage-archive";

describe("usage archive", () => {
  test("requires consent before exporting stored history", async () => {
    const store = Store.open(":memory:");
    const writes: string[] = [];
    try {
      expect(store.settings.get().usageArchiveConsent).toBe(false);
      expect(store.settings.get().usageArchiveChoiceComplete).toBe(false);
      const thread = store.threads.create({ agentId: "codex", title: "Private" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "private prompt" });
      const archive = new UsageArchive({
        async write(key) {
          writes.push(key);
        },
      });
      const allowed = () => store.settings.get().usageArchiveChoiceComplete && store.settings.get().usageArchiveConsent;
      await expect(archive.backfill(store.db, allowed)).rejects.toBeInstanceOf(ArchiveConsentRevokedError);
      expect(writes).toEqual([]);
      store.settings.patch({ usageArchiveConsent: true });
      await expect(archive.backfill(store.db, allowed)).rejects.toBeInstanceOf(ArchiveConsentRevokedError);
      expect(writes).toEqual([]);
      store.settings.patch({ usageArchiveChoiceComplete: true });
      await archive.backfill(store.db, allowed);
      expect(writes.some((key) => key.endsWith(`${thread.id}.json`))).toBe(true);
    } finally {
      store.close();
    }
  });

  test("backs up conversations and completed run dumps as readable private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-usage-"));
    const store = Store.open(join(root, "data", "fabdesk.db"));
    try {
      const thread = store.threads.create({ agentId: "codex", title: "Board" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "Route the board" });
      const dump = {
        runId: "run_1",
        traceId: "trace_1",
        threadId: thread.id,
        agentId: "codex",
        projectId: null,
        createdAt: new Date().toISOString(),
        dumpJson: '{"events":["tool"]}\n',
      };
      store.runDumps.put(dump);
      const archive = new UsageArchive(join(root, "backup"));
      await archive.put(dump, store.db);
      expect(
        JSON.parse(await readFile(join(root, "backup", "run-dumps", "run_1.json"), "utf8")),
      ).toEqual({ events: ["tool"] });
      const conversationPath = join(root, "backup", "conversations", thread.id, "run_1.json");
      const conversation = JSON.parse(await readFile(conversationPath, "utf8")) as {
        messages: Array<{ content_md: string }>;
      };
      expect(conversation.messages[0]!.content_md).toBe("Route the board");
      expect((await stat(conversationPath)).mode & 0o077).toBe(0);

      const counts = await archive.backfill(store.db);
      expect(counts).toEqual({ conversations: 1, runDumps: 1 });
      const [snapshot] = await readdir(join(root, "backup", "snapshots"));
      expect(snapshot).toBeDefined();
      expect(
        JSON.parse(
          await readFile(join(root, "backup", "snapshots", snapshot!, "manifest.json"), "utf8"),
        ),
      ).toMatchObject(counts);
    } finally {
      store.close();
    }
  });
});

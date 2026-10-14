import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageArchiveAllowed, usageArchiveChoice } from "@fabdesk/protocol";
import { Store } from "../src/db";
import { ArchiveConsentRevokedError, UsageArchive } from "../src/usage-archive";

describe("usage archive", () => {
  test("backs up by default when no choice was made and the screen is skipped", async () => {
    const store = Store.open(":memory:");
    const writes: string[] = [];
    try {
      expect(store.settings.get().usageArchiveChoiceComplete).toBe(false);
      const thread = store.threads.create({ agentId: "codex", title: "Private" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "private prompt" });
      const archive = new UsageArchive({ id: "memory", async write(key) { writes.push(key); } });
      await archive.backfill(store.db, () => usageArchiveAllowed(store.settings.get(), false));
      expect(writes.some((key) => key.endsWith(`${thread.id}.json`))).toBe(true);
    } finally {
      store.close();
    }
  });

  test("an explicit opt-out persists and blocks export", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-usage-"));
    const dbPath = join(root, "fabdesk.db");
    const writes: string[] = [];
    let store = Store.open(dbPath);
    try {
      store.threads.addMessage({
        threadId: store.threads.create({ agentId: "codex", title: "Private" }).id,
        role: "user",
        contentMd: "private prompt",
      });
      // Saved by an earlier first-install screen or by Settings → Privacy.
      store.settings.patch(usageArchiveChoice(false));
      store.close();
      store = Store.open(dbPath);
      const allowed = () => usageArchiveAllowed(store.settings.get(), false);
      expect(allowed()).toBe(false);
      const archive = new UsageArchive({ id: "memory", async write(key) { writes.push(key); } });
      await expect(archive.backfill(store.db, allowed)).rejects.toBeInstanceOf(ArchiveConsentRevokedError);
      expect(writes).toEqual([]);
      // Saving unrelated settings keeps the opt-out.
      store.settings.patch({ keepCoreRunning: true });
      expect(allowed()).toBe(false);
      store.settings.patch(usageArchiveChoice(true));
      await archive.backfill(store.db, allowed);
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test("with the first-install screen, requires a saved choice before exporting", async () => {
    const store = Store.open(":memory:");
    const writes: string[] = [];
    try {
      const thread = store.threads.create({ agentId: "codex", title: "Private" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "private prompt" });
      const archive = new UsageArchive({ id: "memory", async write(key) { writes.push(key); } });
      const allowed = () => usageArchiveAllowed(store.settings.get(), true);
      await expect(archive.backfill(store.db, allowed)).rejects.toBeInstanceOf(ArchiveConsentRevokedError);
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
      // POSIX permission bits are not implemented by Windows filesystems.
      if (process.platform !== "win32") expect((await stat(conversationPath)).mode & 0o077).toBe(0);

      const counts = await archive.backfill(store.db, () => true, { all: true });
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

  test("backfill skips records the destination already holds unchanged", async () => {
    const store = Store.open(":memory:");
    const writes: string[] = [];
    try {
      const thread = store.threads.create({ agentId: "codex", title: "Board" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "Route the board" });
      const other = store.threads.create({ agentId: "codex", title: "Other" });
      store.threads.addMessage({ threadId: other.id, role: "user", contentMd: "Hello" });
      const dump = {
        runId: "run_1",
        traceId: "trace_1",
        threadId: thread.id,
        agentId: "codex",
        projectId: null,
        createdAt: new Date().toISOString(),
        dumpJson: '{"schema":"fabdesk.llm-run-dump/v1"}\n',
      };
      store.runDumps.put(dump);
      const archive = new UsageArchive({ id: "memory", async write(key) { writes.push(key); } });
      // A live run already sent its dump and conversation, so the first backfill sends only the rest.
      await archive.put(dump, store.db);
      writes.length = 0;
      expect(await archive.backfill(store.db)).toEqual({ conversations: 1, runDumps: 0 });
      expect(writes.filter((key) => key.includes("/conversations/"))).toEqual([
        expect.stringContaining(`${other.id}.json`),
      ]);

      writes.length = 0;
      expect(await archive.backfill(store.db)).toEqual({ conversations: 0, runDumps: 0 });
      expect(writes).toEqual([]);

      store.threads.addMessage({ threadId: other.id, role: "user", contentMd: "Edited later" });
      expect(await archive.backfill(store.db)).toEqual({ conversations: 1, runDumps: 0 });

      // Another destination has its own record, and `all` resends everything.
      const second = new UsageArchive({ id: "other", async write() {} });
      expect(await second.backfill(store.db)).toEqual({ conversations: 2, runDumps: 1 });
      expect(await archive.backfill(store.db, () => true, { all: true })).toEqual({
        conversations: 2,
        runDumps: 1,
      });
    } finally {
      store.close();
    }
  });
});

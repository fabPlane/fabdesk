/** Opt-in, append-only export of conversations and agent run dumps for later curation. */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RunDump } from "./db";

const safeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid archive id: ${id}`);
  return id;
};

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export type ArchiveWriter = {
  write(key: string, content: string): Promise<void>;
};

export class ArchiveConsentRevokedError extends Error {
  constructor() {
    super("usage archive consent revoked");
  }
}

function requireConsent(allowed: () => boolean): void {
  if (!allowed()) throw new ArchiveConsentRevokedError();
}

class FileArchiveWriter implements ArchiveWriter {
  constructor(private readonly directory: string) {}
  write(key: string, content: string): Promise<void> {
    return atomicWrite(join(this.directory, key), content);
  }
}

type ThreadRow = Record<string, string | number | null> & { id: string };
type MessageRow = Record<string, string | number | null>;
type RunRow = Record<string, string | number | null>;

export function conversationRecord(db: Database, threadId: string): string | null {
  const thread = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(threadId);
  if (!thread) return null;
  const messages = db
    .query<
      MessageRow,
      [string]
    >("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id")
    .all(threadId);
  const runs = db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at, id")
    .all(threadId);
  return (
    JSON.stringify({ schema: "fabdesk.usage-conversation/v1", thread, messages, runs }) + "\n"
  );
}

export class UsageArchive {
  private readonly writer: ArchiveWriter;
  constructor(destination: string | ArchiveWriter) {
    this.writer =
      typeof destination === "string" ? new FileArchiveWriter(destination) : destination;
  }

  /** A completed run is written before the bounded SQLite copy can prune older dumps. */
  async put(dump: RunDump, db: Database, allowed: () => boolean = () => true): Promise<void> {
    const runId = safeId(dump.runId);
    const threadId = safeId(dump.threadId);
    requireConsent(allowed);
    await this.writer.write(`run-dumps/${runId}.json`, dump.dumpJson);
    const conversation = conversationRecord(db, threadId);
    if (conversation) {
      requireConsent(allowed);
      await this.writer.write(`conversations/${threadId}/${runId}.json`, conversation);
    }
  }

  /** Backfill current SQLite history, including conversations that have no agent run. */
  async backfill(
    db: Database,
    allowed: () => boolean = () => true,
  ): Promise<{ conversations: number; runDumps: number }> {
    const snapshot = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    let conversations = 0;
    for (const row of db
      .query<{ id: string }, []>("SELECT id FROM threads ORDER BY created_at, id")
      .all()) {
      const record = conversationRecord(db, row.id);
      if (!record) continue;
      requireConsent(allowed);
      await this.writer.write(`snapshots/${snapshot}/conversations/${safeId(row.id)}.json`, record);
      conversations++;
    }
    let runDumps = 0;
    let lastCreatedAt = "";
    let lastRunId = "";
    while (true) {
      const batch = db
        .query<{ run_id: string; created_at: string; dump_json: string }, [string, string, string]>(
          `SELECT run_id, created_at, dump_json FROM run_dumps
           WHERE created_at > ? OR (created_at = ? AND run_id > ?)
           ORDER BY created_at, run_id LIMIT 16`,
        )
        .all(lastCreatedAt, lastCreatedAt, lastRunId);
      if (batch.length === 0) break;
      for (const row of batch) {
        requireConsent(allowed);
        await this.writer.write(`run-dumps/${safeId(row.run_id)}.json`, row.dump_json);
        runDumps++;
        lastCreatedAt = row.created_at;
        lastRunId = row.run_id;
      }
    }
    requireConsent(allowed);
    await this.writer.write(
      `snapshots/${snapshot}/manifest.json`,
      JSON.stringify({
        schema: "fabdesk.usage-backup/v1",
        createdAt: new Date().toISOString(),
        conversations,
        runDumps,
      }) + "\n",
    );
    return { conversations, runDumps };
  }
}

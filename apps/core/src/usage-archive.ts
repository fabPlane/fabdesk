/** Opt-in, append-only export of conversations and agent run dumps for later curation. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  /** Stable name for this destination; keys the record of what has already been written there. */
  readonly id: string;
  write(key: string, content: string, allowed?: () => boolean): Promise<void>;
  /** Cancels writes from the current consent period; future writes remain usable. */
  cancelPending?(): void;
  /** Cancels in-flight writes and retry waits; optional. */
  close?(): void;
};

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

export class ArchiveConsentRevokedError extends Error {
  constructor() {
    super("usage archive consent revoked");
  }
}

/** The destination can never accept this record; backfill skips it instead of failing. */
export class ArchiveRecordTooLargeError extends Error {
  constructor(key: string, bytes: number) {
    super(`usage archive record too large: ${key} (${bytes} bytes)`);
  }
}

function requireConsent(allowed: () => boolean): void {
  if (!allowed()) throw new ArchiveConsentRevokedError();
}

class FileArchiveWriter implements ArchiveWriter {
  readonly id: string;
  constructor(private readonly directory: string) {
    this.id = `dir:${resolve(directory)}`;
  }
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

  /** Destination id in `usage_archive_uploads`; run-dump retention keeps records not yet written here. */
  get destination(): string {
    return this.writer.id;
  }

  close(): void {
    this.writer.close?.();
  }

  cancelPending(): void {
    this.writer.cancelPending?.();
  }

  /** False when the destination rejects the record as too large; other failures throw. */
  private async writeRecord(key: string, content: string, allowed: () => boolean): Promise<boolean> {
    try {
      await this.writer.write(key, content, allowed);
      return true;
    } catch (error) {
      if (error instanceof ArchiveRecordTooLargeError) return false;
      throw error;
    }
  }

  private written(db: Database, recordId: string, content: string): boolean {
    const row = db
      .query<{ sha256: string }, [string, string]>(
        "SELECT sha256 FROM usage_archive_uploads WHERE destination = ? AND record_id = ?",
      )
      .get(this.writer.id, recordId);
    return row?.sha256 === sha256(content);
  }

  private markWritten(db: Database, recordId: string, content: string): void {
    db.run(
      `INSERT INTO usage_archive_uploads(destination, record_id, sha256, uploaded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(destination, record_id) DO UPDATE SET sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at`,
      [this.writer.id, recordId, sha256(content), new Date().toISOString()],
    );
  }

  /** A completed run is written before the bounded SQLite copy can prune older dumps. */
  async put(dump: RunDump, db: Database, allowed: () => boolean = () => true): Promise<void> {
    const runId = safeId(dump.runId);
    const threadId = safeId(dump.threadId);
    requireConsent(allowed);
    await this.writer.write(`run-dumps/${runId}.json`, dump.dumpJson, allowed);
    this.markWritten(db, `run-dump:${runId}`, dump.dumpJson);
    const conversation = conversationRecord(db, threadId);
    if (conversation) {
      requireConsent(allowed);
      await this.writer.write(`conversations/${threadId}/${runId}.json`, conversation, allowed);
      this.markWritten(db, `conversation:${threadId}`, conversation);
    }
  }

  /**
   * Backfill current SQLite history, including conversations that have no agent run. Records this
   * destination already holds unchanged are skipped unless `all` is set; counts are records written,
   * plus `tooLarge` records the destination cannot accept (skipped; the backfill carries on).
   */
  async backfill(
    db: Database,
    allowed: () => boolean = () => true,
    { all = false }: { all?: boolean } = {},
  ): Promise<{ conversations: number; runDumps: number; tooLarge: number }> {
    const snapshot = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    let conversations = 0;
    let tooLarge = 0;
    for (const row of db
      .query<{ id: string }, []>("SELECT id FROM threads ORDER BY created_at, id")
      .all()) {
      const record = conversationRecord(db, row.id);
      if (!record || (!all && this.written(db, `conversation:${row.id}`, record))) continue;
      requireConsent(allowed);
      if (!(await this.writeRecord(`snapshots/${snapshot}/conversations/${safeId(row.id)}.json`, record, allowed))) {
        tooLarge++;
        continue;
      }
      this.markWritten(db, `conversation:${row.id}`, record);
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
        lastCreatedAt = row.created_at;
        lastRunId = row.run_id;
        if (!all && this.written(db, `run-dump:${row.run_id}`, row.dump_json)) continue;
        requireConsent(allowed);
        if (!(await this.writeRecord(`run-dumps/${safeId(row.run_id)}.json`, row.dump_json, allowed))) {
          tooLarge++;
          continue;
        }
        this.markWritten(db, `run-dump:${row.run_id}`, row.dump_json);
        runDumps++;
      }
    }
    if (conversations === 0 && runDumps === 0) return { conversations, runDumps, tooLarge };
    requireConsent(allowed);
    await this.writer.write(
      `snapshots/${snapshot}/manifest.json`,
      JSON.stringify({
        schema: "fabdesk.usage-backup/v1",
        createdAt: new Date().toISOString(),
        conversations,
        runDumps,
        tooLarge,
      }) + "\n",
      allowed,
    );
    return { conversations, runDumps, tooLarge };
  }
}

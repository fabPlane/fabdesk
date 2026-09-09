/** SQLite (bun:sqlite, WAL) with versioned migrations and typed repositories. */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Job,
  Message,
  Run,
  Settings,
  Thread,
  type JobStatus,
  type MessagePart,
  type ProjectSummary,
} from "@fabdesk/protocol";
import type { RouteRunRecord } from "@fabdesk/tools";
import type { RouteResult } from "@fabdesk/protocol";

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT NOT NULL,
        model TEXT,
        parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        branch_from_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX threads_updated ON threads(updated_at DESC);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_md TEXT NOT NULL,
        parts_json TEXT NOT NULL DEFAULT '[]',
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX messages_thread ON messages(thread_id, created_at);
      CREATE VIRTUAL TABLE messages_fts USING fts5(content_md, content='messages', content_rowid='rowid');
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES('delete', old.rowid, old.content_md);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES('delete', old.rowid, old.content_md);
        INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
      END;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        agent_session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        cost_json TEXT,
        log_path TEXT
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        progress REAL,
        note TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT
      );
      CREATE TABLE route_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        router TEXT NOT NULL,
        status TEXT NOT NULL,
        frames_path TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX route_runs_project ON route_runs(project_id, started_at DESC);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version));
  let current = Math.max(0, ...applied);
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.run(m.sql);
      db.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", [m.version, new Date().toISOString()]);
    })();
    current = m.version;
  }
  return current;
}

export function schemaVersion(db: Database): number {
  const row = db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Date.now().toString(36)}${Buffer.from(bytes).toString("hex").slice(0, 10)}`;
}

const nowIso = () => new Date().toISOString();

/* ---------- projects ---------- */

type ProjectRow = { id: string; name: string; slug: string; path: string; created_at: string; updated_at: string };

export class ProjectRepo {
  constructor(private readonly db: Database) {}
  private toSummary(r: ProjectRow): ProjectSummary & { slug: string } {
    return { id: r.id, name: r.name, slug: r.slug, path: r.path, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  list(): Array<ProjectSummary & { slug: string }> {
    return this.db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY updated_at DESC").all().map((r) => this.toSummary(r));
  }
  get(id: string): (ProjectSummary & { slug: string }) | null {
    const r = this.db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? this.toSummary(r) : null;
  }
  find(ref: string): (ProjectSummary & { slug: string }) | null {
    const r = this.db.query<ProjectRow, [string, string, string, string]>("SELECT * FROM projects WHERE id = ? OR slug = ? OR path = ? OR name = ? ORDER BY updated_at DESC").get(ref, ref, ref, ref);
    return r ? this.toSummary(r) : null;
  }
  upsert(p: { id: string; name: string; slug: string; path: string; createdAt: string; updatedAt: string }): void {
    this.db.run(
      "INSERT INTO projects(id, name, slug, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug, path = excluded.path, updated_at = excluded.updated_at",
      [p.id, p.name, p.slug, p.path, p.createdAt, p.updatedAt],
    );
  }
  touch(id: string): void {
    this.db.run("UPDATE projects SET updated_at = ? WHERE id = ?", [nowIso(), id]);
  }
  delete(id: string): void {
    this.db.run("DELETE FROM projects WHERE id = ?", [id]);
  }
}

/* ---------- threads & messages ---------- */

type ThreadRow = {
  id: string; project_id: string | null; folder_id: string | null; title: string; pinned: number; archived: number; agent_id: string; model: string | null;
  parent_thread_id: string | null; branch_from_message_id: string | null; created_at: string; updated_at: string;
};
type MessageRow = { id: string; thread_id: string; role: string; content_md: string; parts_json: string; run_id: string | null; created_at: string };

export type ThreadQuery = { q?: string; projectId?: string; archived?: boolean; folderId?: string | null; limit?: number };

export class ThreadRepo {
  constructor(private readonly db: Database) {}

  private toThread(r: ThreadRow): Thread {
    return Thread.parse({
      id: r.id, projectId: r.project_id, folderId: r.folder_id, title: r.title, pinned: r.pinned === 1, archived: r.archived === 1, agentId: r.agent_id, model: r.model,
      parentThreadId: r.parent_thread_id, branchFromMessageId: r.branch_from_message_id, createdAt: r.created_at, updatedAt: r.updated_at,
    });
  }
  private toMessage(r: MessageRow): Message {
    return Message.parse({ id: r.id, threadId: r.thread_id, role: r.role, contentMd: r.content_md, parts: JSON.parse(r.parts_json), runId: r.run_id, createdAt: r.created_at });
  }

  list(q: ThreadQuery = {}): Thread[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) {
      where.push("t.id IN (SELECT m.thread_id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?) OR t.title LIKE ?");
      params.push(ftsQuery(q.q), `%${q.q}%`);
    }
    if (q.projectId) {
      where.push("t.project_id = ?");
      params.push(q.projectId);
    }
    if (q.archived !== undefined) {
      where.push("t.archived = ?");
      params.push(q.archived ? 1 : 0);
    }
    if (q.folderId !== undefined) {
      if (q.folderId === null) where.push("t.folder_id IS NULL");
      else {
        where.push("t.folder_id = ?");
        params.push(q.folderId);
      }
    }
    const sql = `SELECT t.* FROM threads t ${where.length ? "WHERE " + where.map((w) => `(${w})`).join(" AND ") : ""} ORDER BY t.pinned DESC, t.updated_at DESC LIMIT ?`;
    params.push(q.limit ?? 200);
    return this.db.query<ThreadRow, SQLQueryBindings[]>(sql).all(...(params as SQLQueryBindings[])).map((r) => this.toThread(r));
  }

  get(id: string): Thread | null {
    const r = this.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
    return r ? this.toThread(r) : null;
  }

  create(input: { projectId?: string | null; title?: string; agentId: string; model?: string; parentThreadId?: string; branchFromMessageId?: string; folderId?: string | null }): Thread {
    const id = newId("th");
    const ts = nowIso();
    const parent = input.parentThreadId ? this.get(input.parentThreadId) : null;
    const title = input.title ?? (parent ? `${parent.title} (branch)` : "New chat");
    this.db.run(
      "INSERT INTO threads(id, project_id, folder_id, title, pinned, archived, agent_id, model, parent_thread_id, branch_from_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)",
      [id, input.projectId ?? parent?.projectId ?? null, input.folderId ?? parent?.folderId ?? null, title, input.agentId, input.model ?? parent?.model ?? null, input.parentThreadId ?? null, input.branchFromMessageId ?? null, ts, ts],
    );
    // Branching copies the parent's messages up to (and including) the branch point.
    if (parent) {
      const msgs = this.messages(parent.id);
      const cut = input.branchFromMessageId ? msgs.findIndex((m) => m.id === input.branchFromMessageId) : msgs.length - 1;
      for (const m of msgs.slice(0, cut + 1)) this.addMessage({ threadId: id, role: m.role, contentMd: m.contentMd, parts: m.parts, runId: m.runId });
    }
    return this.get(id)!;
  }

  patch(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; folderId?: string | null; agentId?: string; model?: string | null; projectId?: string | null }): Thread | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.pinned !== undefined) add("pinned", patch.pinned ? 1 : 0);
    if (patch.archived !== undefined) add("archived", patch.archived ? 1 : 0);
    if (patch.folderId !== undefined) add("folder_id", patch.folderId);
    if (patch.agentId !== undefined) add("agent_id", patch.agentId);
    if (patch.model !== undefined) add("model", patch.model);
    if (patch.projectId !== undefined) add("project_id", patch.projectId);
    add("updated_at", nowIso());
    params.push(id);
    this.db.run(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`, params as []);
    return this.get(id);
  }

  touch(id: string): void {
    this.db.run("UPDATE threads SET updated_at = ? WHERE id = ?", [nowIso(), id]);
  }

  delete(id: string): boolean {
    const r = this.db.run("DELETE FROM threads WHERE id = ?", [id]);
    return r.changes > 0;
  }

  messages(threadId: string): Message[] {
    return this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId).map((r) => this.toMessage(r));
  }

  getMessage(id: string): Message | null {
    const r = this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(id);
    return r ? this.toMessage(r) : null;
  }

  addMessage(input: { threadId: string; role: Message["role"]; contentMd: string; parts?: MessagePart[]; runId?: string | null; id?: string }): Message {
    const id = input.id ?? newId("msg");
    const ts = nowIso();
    this.db.run("INSERT INTO messages(id, thread_id, role, content_md, parts_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, input.threadId, input.role, input.contentMd, JSON.stringify(input.parts ?? []), input.runId ?? null, ts]);
    this.touch(input.threadId);
    return this.getMessage(id)!;
  }

  updateMessage(id: string, patch: { contentMd?: string; parts?: MessagePart[] }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.contentMd !== undefined) {
      sets.push("content_md = ?");
      params.push(patch.contentMd);
    }
    if (patch.parts !== undefined) {
      sets.push("parts_json = ?");
      params.push(JSON.stringify(patch.parts));
    }
    if (!sets.length) return;
    params.push(id);
    this.db.run(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`, params as []);
  }

  search(q: string, limit = 50): Array<{ message: Message; snippet: string }> {
    const rows = this.db
      .query<MessageRow & { snippet: string }, [string, number]>(
        "SELECT m.*, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(ftsQuery(q), limit);
    return rows.map((r) => ({ message: this.toMessage(r), snippet: r.snippet }));
  }
}

/** Quote user text for FTS5 so punctuation cannot break the query; prefix-match the last token. */
export function ftsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" ");
}

/* ---------- folders ---------- */

export type Folder = { id: string; name: string; parentId: string | null; createdAt: string };

export class FolderRepo {
  constructor(private readonly db: Database) {}
  list(): Folder[] {
    return this.db.query<{ id: string; name: string; parent_id: string | null; created_at: string }, []>("SELECT * FROM folders ORDER BY name").all().map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at }));
  }
  create(name: string, parentId: string | null = null): Folder {
    const id = newId("fld");
    const ts = nowIso();
    this.db.run("INSERT INTO folders(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)", [id, name, parentId, ts]);
    return { id, name, parentId, createdAt: ts };
  }
  rename(id: string, name: string): void {
    this.db.run("UPDATE folders SET name = ? WHERE id = ?", [name, id]);
  }
  delete(id: string): boolean {
    return this.db.run("DELETE FROM folders WHERE id = ?", [id]).changes > 0;
  }
}

/* ---------- runs ---------- */

type RunRow = { id: string; thread_id: string; agent_id: string; agent_session_id: string | null; status: string; started_at: string; ended_at: string | null; exit_code: number | null; cost_json: string | null; log_path: string | null };

export class RunRepo {
  constructor(private readonly db: Database) {}
  private toRun(r: RunRow): Run {
    return Run.parse({ id: r.id, threadId: r.thread_id, agentId: r.agent_id, agentSessionId: r.agent_session_id, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, exitCode: r.exit_code });
  }
  create(input: { threadId: string; agentId: string; logPath?: string }): Run {
    const id = newId("run");
    this.db.run("INSERT INTO runs(id, thread_id, agent_id, status, started_at, log_path) VALUES (?, ?, ?, 'running', ?, ?)", [id, input.threadId, input.agentId, nowIso(), input.logPath ?? null]);
    return this.get(id)!;
  }
  get(id: string): Run | null {
    const r = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return r ? this.toRun(r) : null;
  }
  setSession(id: string, sessionId: string): void {
    this.db.run("UPDATE runs SET agent_session_id = ? WHERE id = ?", [sessionId, id]);
  }
  setLogPath(id: string, logPath: string): void {
    this.db.run("UPDATE runs SET log_path = ? WHERE id = ?", [logPath, id]);
  }
  finish(id: string, patch: { status: Run["status"]; exitCode?: number | null; cost?: unknown }): void {
    this.db.run("UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, cost_json = COALESCE(?, cost_json) WHERE id = ?", [patch.status, nowIso(), patch.exitCode ?? null, patch.cost === undefined ? null : JSON.stringify(patch.cost), id]);
  }
  /**
   * Runs still marked running belong to a previous daemon process (their agent subprocess died with it);
   * without this they stay "running" forever and the thread keeps its badge. Returns the affected thread ids.
   */
  failStale(): string[] {
    const rows = this.db.query<{ thread_id: string }, []>("SELECT DISTINCT thread_id FROM runs WHERE status = 'running'").all();
    this.db.run("UPDATE runs SET status = 'failed', ended_at = ?, exit_code = COALESCE(exit_code, -1) WHERE status = 'running'", [nowIso()]);
    return rows.map((r) => r.thread_id);
  }
  latestForThread(threadId: string): Run | null {
    const r = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1").get(threadId);
    return r ? this.toRun(r) : null;
  }
  /** Most recent agent session id for resume, per thread + agent. */
  lastSession(threadId: string, agentId: string): string | null {
    const r = this.db.query<{ agent_session_id: string | null }, [string, string]>("SELECT agent_session_id FROM runs WHERE thread_id = ? AND agent_id = ? AND agent_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(threadId, agentId);
    return r?.agent_session_id ?? null;
  }
}

/* ---------- jobs ---------- */

type JobRow = { id: string; kind: string; project_id: string | null; status: string; progress: number | null; note: string | null; result_json: string | null; error: string | null; created_at: string; started_at: string | null; ended_at: string | null };

export class JobRepo {
  constructor(private readonly db: Database) {}
  private toJob(r: JobRow): Job {
    return Job.parse({ id: r.id, kind: r.kind, projectId: r.project_id, status: r.status, progress: r.progress, note: r.note, result: r.result_json ? JSON.parse(r.result_json) : null, error: r.error, startedAt: r.started_at, endedAt: r.ended_at });
  }
  insert(j: { id: string; kind: string; projectId: string | null }): void {
    this.db.run("INSERT INTO jobs(id, kind, project_id, status, created_at) VALUES (?, ?, ?, 'queued', ?)", [j.id, j.kind, j.projectId, nowIso()]);
  }
  update(id: string, patch: { status?: JobStatus; progress?: number | null; note?: string | null; result?: unknown; error?: string | null; startedAt?: string; endedAt?: string }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (c: string, v: unknown) => {
      sets.push(`${c} = ?`);
      params.push(v);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.progress !== undefined) add("progress", patch.progress);
    if (patch.note !== undefined) add("note", patch.note);
    if (patch.result !== undefined) add("result_json", JSON.stringify(patch.result ?? null));
    if (patch.error !== undefined) add("error", patch.error);
    if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
    if (patch.endedAt !== undefined) add("ended_at", patch.endedAt);
    if (!sets.length) return;
    params.push(id);
    this.db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, params as []);
  }
  get(id: string): Job | null {
    const r = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
    return r ? this.toJob(r) : null;
  }
  list(limit = 100): Job[] {
    return this.db.query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit).map((r) => this.toJob(r));
  }
  /** Jobs still marked running/queued from a previous process are failed on startup. */
  failStale(): number {
    return this.db.run("UPDATE jobs SET status = 'failed', error = 'daemon restarted', ended_at = ? WHERE status IN ('queued', 'running')", [nowIso()]).changes;
  }
}

/* ---------- route runs ---------- */

type RouteRunRow = { id: string; project_id: string; router: string; status: string; frames_path: string; result_json: string | null; error: string | null; started_at: string; ended_at: string | null };

export class RouteRunRepo {
  constructor(private readonly db: Database) {}
  private toRec(r: RouteRunRow): RouteRunRecord {
    return { id: r.id, projectId: r.project_id, router: r.router, status: r.status as RouteRunRecord["status"], framesPath: r.frames_path, startedAt: r.started_at, endedAt: r.ended_at, result: r.result_json ? (JSON.parse(r.result_json) as RouteResult) : null, error: r.error };
  }
  start(rec: Omit<RouteRunRecord, "endedAt" | "result" | "error" | "status">): void {
    this.db.run("INSERT INTO route_runs(id, project_id, router, status, frames_path, started_at) VALUES (?, ?, ?, 'running', ?, ?)", [rec.id, rec.projectId, rec.router, rec.framesPath, rec.startedAt]);
  }
  finish(id: string, patch: Pick<RouteRunRecord, "status" | "result" | "error">): void {
    this.db.run("UPDATE route_runs SET status = ?, result_json = ?, error = ?, ended_at = ? WHERE id = ?", [patch.status, patch.result ? JSON.stringify(patch.result) : null, patch.error, nowIso(), id]);
  }
  get(id: string): RouteRunRecord | null {
    const r = this.db.query<RouteRunRow, [string]>("SELECT * FROM route_runs WHERE id = ?").get(id);
    return r ? this.toRec(r) : null;
  }
  latest(projectId: string): RouteRunRecord | null {
    const r = this.db.query<RouteRunRow, [string]>("SELECT * FROM route_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(projectId);
    return r ? this.toRec(r) : null;
  }
  list(projectId: string, limit = 50): RouteRunRecord[] {
    return this.db.query<RouteRunRow, [string, number]>("SELECT * FROM route_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, limit).map((r) => this.toRec(r));
  }
}

/* ---------- settings ---------- */

export class SettingsRepo {
  private cache: Settings | null = null;
  constructor(private readonly db: Database) {}
  get(): Settings {
    if (this.cache) return this.cache;
    const rows = this.db.query<{ key: string; value_json: string }, []>("SELECT key, value_json FROM settings").all();
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value_json);
      } catch {
        /* ignore corrupt value */
      }
    }
    const parsed = Settings.safeParse(raw);
    this.cache = parsed.success ? parsed.data : Settings.parse({});
    return this.cache;
  }
  patch(patch: Record<string, unknown>): Settings {
    const next = Settings.parse({ ...this.get(), ...patch });
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(next)) this.db.run("INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", [k, JSON.stringify(v)]);
    })();
    this.cache = next;
    return next;
  }
}

export class Store {
  readonly projects: ProjectRepo;
  readonly threads: ThreadRepo;
  readonly folders: FolderRepo;
  readonly runs: RunRepo;
  readonly jobs: JobRepo;
  readonly routeRuns: RouteRunRepo;
  readonly settings: SettingsRepo;
  constructor(readonly db: Database) {
    this.projects = new ProjectRepo(db);
    this.threads = new ThreadRepo(db);
    this.folders = new FolderRepo(db);
    this.runs = new RunRepo(db);
    this.jobs = new JobRepo(db);
    this.routeRuns = new RouteRunRepo(db);
    this.settings = new SettingsRepo(db);
  }
  static open(path: string): Store {
    return new Store(openDatabase(path));
  }
  close(): void {
    this.db.close();
  }
}

/**
 * Project store: `~/fabdesk/<slug>/` directories with `fabdesk.json` manifests, mirrored in SQLite
 * for listing/lookup. Emits `project.changed` from a debounced recursive fs.watch.
 */
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { ProjectManifest, type CoreEvent, type FileEntry, type ProjectDetail, type ProjectSummary } from "@fabdesk/protocol";
import { PROJECT_FILES, ToolError, writeJson, type ProjectHandle, type ProjectResolver } from "@fabdesk/tools";
import type { ProjectRepo } from "./db";
import { newId } from "./db";
import { logger } from "./log";

export const DEFAULT_NETLIST_JSON = `${JSON.stringify(
  {
    netlist: { components: [], nets: [] },
    board: { widthMm: 40, heightMm: 30 },
  },
  null,
  2,
)}\n`;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "project";
}

/** Where a forgotten (deleted without purge) project's manifest goes so the directory is not re-adopted. */
export const FORGOTTEN_MANIFEST = "fabdesk.json.forgotten";

export class ProjectStore implements ProjectResolver {
  private readonly handles = new Map<string, ProjectHandle>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingChanges = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly repo: ProjectRepo,
    private readonly rootDir: string,
    private readonly emit: (e: CoreEvent) => void,
    private readonly opts: { watch?: boolean; debounceMs?: number } = {},
  ) {}

  /** Scan the projects directory and reconcile with the DB (manifests on disk win). */
  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(this.rootDir, e.name);
      const manifest = await this.readManifest(dir);
      if (!manifest) continue;
      this.repo.upsert({ id: manifest.id, name: manifest.name, slug: e.name, path: dir, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt });
    }
    for (const p of this.repo.list()) {
      if (!(await stat(p.path).catch(() => null))) {
        logger.warn("project directory missing; unregistering", { id: p.id, path: p.path });
        this.repo.delete(p.id);
        continue;
      }
      if (this.opts.watch !== false) this.watchDir(p.id, p.path);
    }
  }

  async list(): Promise<ProjectHandle[]> {
    const out: ProjectHandle[] = [];
    for (const p of this.repo.list()) {
      const h = await this.handle(p.id);
      if (h) out.push(h);
    }
    return out;
  }

  summaries(): ProjectSummary[] {
    return this.repo.list().map(({ slug: _slug, ...s }) => s);
  }

  async resolve(ref: string): Promise<ProjectHandle | null> {
    const row = this.repo.find(ref) ?? (ref.includes(sep) ? this.repo.find(resolve(ref)) : null);
    if (row) return this.handle(row.id);
    // An absolute path to a directory containing fabdesk.json: register on the fly.
    if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) {
      const dir = resolve(ref);
      const manifest = await this.readManifest(dir);
      if (!manifest) return null;
      this.repo.upsert({ id: manifest.id, name: manifest.name, slug: manifest.id, path: dir, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt });
      if (this.opts.watch !== false) this.watchDir(manifest.id, dir);
      return this.handle(manifest.id);
    }
    return null;
  }

  async handle(id: string): Promise<ProjectHandle | null> {
    const cached = this.handles.get(id);
    if (cached) return cached;
    const row = this.repo.get(id);
    if (!row) return null;
    const manifest = await this.readManifest(row.path);
    if (!manifest) return null;
    let current = manifest;
    const store = this;
    const h: ProjectHandle = {
      id: row.id,
      name: row.name,
      dir: row.path,
      manifest: () => current,
      async updateManifest(patch) {
        current = ProjectManifest.parse({ ...current, ...patch, id: row.id, updatedAt: new Date().toISOString() });
        await writeJson(join(row.path, PROJECT_FILES.manifest), current);
        store.repo.upsert({ id: row.id, name: current.name, slug: row.slug, path: row.path, createdAt: current.createdAt, updatedAt: current.updatedAt });
        h.name = current.name;
        return current;
      },
    };
    this.handles.set(id, h);
    return h;
  }

  async create(name: string): Promise<ProjectDetail> {
    await mkdir(this.rootDir, { recursive: true });
    const base = slugify(name);
    let slug = base;
    for (let i = 2; await stat(join(this.rootDir, slug)).catch(() => null); i++) slug = `${base}-${i}`;
    const dir = join(this.rootDir, slug);
    const ts = new Date().toISOString();
    const manifest = ProjectManifest.parse({ schema: 1, id: newId("prj"), name, createdAt: ts, updatedAt: ts, board: { layers: 2 }, router: "capacity" });
    for (const sub of [PROJECT_FILES.sketches, PROJECT_FILES.renders, PROJECT_FILES.reports, PROJECT_FILES.exports, PROJECT_FILES.runs]) await mkdir(join(dir, sub), { recursive: true });
    await writeJson(join(dir, PROJECT_FILES.manifest), manifest);
    await Bun.write(join(dir, PROJECT_FILES.netlistJson), DEFAULT_NETLIST_JSON);
    await Bun.write(join(dir, ".gitignore"), ".fabdesk/\nrenders/\nexports/\n");
    this.repo.upsert({ id: manifest.id, name, slug, path: dir, createdAt: ts, updatedAt: ts });
    if (this.opts.watch !== false) this.watchDir(manifest.id, dir);
    this.emit({ ts: Date.now(), topic: "project.changed", projectId: manifest.id, paths: [PROJECT_FILES.manifest, PROJECT_FILES.netlistJson] });
    return (await this.detail(manifest.id))!;
  }

  /** Clone an allowed git URL into the projects root and register it as a fabPlane project. */
  async importFromGit(opts: { name: string; gitUrl: string; clone?: (url: string, dir: string) => Promise<void> }): Promise<ProjectDetail> {
    await mkdir(this.rootDir, { recursive: true });
    const base = slugify(opts.name);
    let slug = base;
    for (let i = 2; await stat(join(this.rootDir, slug)).catch(() => null); i++) slug = `${base}-${i}`;
    const dir = join(this.rootDir, slug);
    try {
      await (opts.clone ?? defaultGitClone)(opts.gitUrl, dir);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new ToolError(`could not clone ${opts.gitUrl}: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
    }
    const ts = new Date().toISOString();
    const existing = await this.readManifest(dir);
    const manifest = ProjectManifest.parse({
      schema: 1,
      id: newId("prj"),
      name: opts.name,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      board: existing?.board ?? { layers: 2 },
      router: existing?.router ?? "capacity",
    });
    for (const sub of [PROJECT_FILES.sketches, PROJECT_FILES.renders, PROJECT_FILES.reports, PROJECT_FILES.exports, PROJECT_FILES.runs]) {
      await mkdir(join(dir, sub), { recursive: true });
    }
    await writeJson(join(dir, PROJECT_FILES.manifest), manifest);
    this.repo.upsert({ id: manifest.id, name: opts.name, slug, path: dir, createdAt: manifest.createdAt, updatedAt: ts });
    if (this.opts.watch !== false) this.watchDir(manifest.id, dir);
    this.emit({ ts: Date.now(), topic: "project.changed", projectId: manifest.id, paths: [PROJECT_FILES.manifest] });
    return (await this.detail(manifest.id))!;
  }

  async detail(id: string): Promise<ProjectDetail | null> {
    const row = this.repo.get(id);
    if (!row) return null;
    const h = await this.handle(id);
    if (!h) return null;
    const files = await this.listFiles(row.path);
    const { slug: _slug, ...summary } = row;
    return { ...summary, name: h.name, manifest: h.manifest(), files };
  }

  async delete(id: string, opts: { purge?: boolean } = {}): Promise<boolean> {
    const row = this.repo.get(id);
    if (!row) return false;
    this.unwatch(id);
    this.handles.delete(id);
    this.repo.delete(id);
    if (opts.purge) await rm(row.path, { recursive: true, force: true });
    // Forgetting keeps the files but must survive a restart: `init` re-adopts every directory with a
    // manifest, so the manifest is set aside (restore it to bring the project back).
    else await rename(join(row.path, PROJECT_FILES.manifest), join(row.path, FORGOTTEN_MANIFEST)).catch(() => undefined);
    return true;
  }

  async rename(id: string, name: string): Promise<ProjectDetail | null> {
    const h = await this.handle(id);
    if (!h) return null;
    await h.updateManifest({ name });
    return this.detail(id);
  }

  async listFiles(dir: string, max = 2000): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    const walk = async (d: string): Promise<void> => {
      if (out.length >= max) return;
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const abs = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === ".fabdesk") continue;
          await walk(abs);
        } else if (e.isFile()) {
          const st = await stat(abs).catch(() => null);
          if (st) out.push({ path: relative(dir, abs).split(sep).join("/"), size: st.size, mtime: st.mtime.toISOString() });
        }
        if (out.length >= max) return;
      }
    };
    await walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async readManifest(dir: string): Promise<ProjectManifest | null> {
    try {
      const raw = JSON.parse(await readFile(join(dir, PROJECT_FILES.manifest), "utf8"));
      const parsed = ProjectManifest.safeParse(raw);
      if (!parsed.success) {
        logger.warn("invalid fabdesk.json ignored", { dir, issue: parsed.error.issues[0]?.message });
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  private watchDir(id: string, dir: string): void {
    if (this.watchers.has(id)) return;
    try {
      const w = watch(dir, { recursive: true }, (_ev, filename) => {
        const rel = filename ? String(filename).split(sep).join("/") : "";
        if (rel.startsWith(".fabdesk/") || rel.endsWith(".tmp") || rel.startsWith(".git/")) return;
        this.queueChange(id, rel || ".");
      });
      w.on("error", (e) => logger.warn("fs.watch error", { id, error: e.message }));
      this.watchers.set(id, w);
    } catch (e) {
      logger.warn("fs.watch unavailable", { dir, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private queueChange(id: string, path: string): void {
    const ms = this.opts.debounceMs ?? 250;
    const pending = this.pendingChanges.get(id);
    if (pending) {
      pending.paths.add(path);
      return;
    }
    const paths = new Set([path]);
    const timer = setTimeout(() => {
      this.pendingChanges.delete(id);
      this.handles.get(id); // keep handle cache; manifest edits are re-read lazily below
      if (paths.has(PROJECT_FILES.manifest)) this.handles.delete(id);
      this.repo.touch(id);
      try {
        this.emit({ ts: Date.now(), topic: "project.changed", projectId: id, paths: [...paths].slice(0, 100) });
      } catch (e) {
        logger.warn("project.changed emit failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }, ms);
    this.pendingChanges.set(id, { paths, timer });
  }

  private unwatch(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const p = this.pendingChanges.get(id);
    if (p) clearTimeout(p.timer);
    this.pendingChanges.delete(id);
  }

  close(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}

export function requireProject(h: ProjectHandle | null, ref: string): ProjectHandle {
  if (!h) throw new ToolError(`project not found: ${ref}`, "not_found");
  return h;
}

async function defaultGitClone(url: string, dir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth", "1", url, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git clone exited ${code}`));
    });
  });
}

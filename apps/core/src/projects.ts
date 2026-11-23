/**
 * Project store: `~/fabdesk/<slug>/` directories with `fabdesk.json` manifests, mirrored in SQLite
 * for listing/lookup. Emits `project.changed` from a debounced recursive fs.watch.
 */
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import {
  BOARD_MATERIAL_DEFAULT_LAYERS,
  layersForConstruction,
  ProjectManifest,
  type BoardConstructionId,
  type BoardMaterialId,
  type CoreEvent,
  type FileEntry,
  type ProjectDetail,
  type ProjectSummary,
} from "@fabdesk/protocol";
import {
  PROJECT_FILES,
  ToolError,
  jailPath,
  writeJson,
  type ProjectHandle,
  type ProjectResolver,
} from "@fabdesk/tools";
import type { ProjectRepo } from "./db";
import { newId } from "./db";
import { logger } from "./log";
import { OutputGenerationTimes } from "./output-generation-times";

/** A chosen parent directory that does not exist or is not a folder; HTTP answers 400 `invalid_parent_directory`. */
export class InvalidParentDirectory extends ToolError {
  constructor(message = "Project location does not exist") {
    super(message, "invalid_args");
  }
}

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
  private readonly outputGenerationTimes = new OutputGenerationTimes();
  private readonly handles = new Map<string, ProjectHandle>();
  private readonly draftIds = new Set<string>();
  private readonly promoting = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingChanges = new Map<
    string,
    { paths: Set<string>; timer: ReturnType<typeof setTimeout> }
  >();

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
      this.repo.upsert({
        id: manifest.id,
        name: manifest.name,
        slug: e.name,
        path: dir,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      });
    }
    for (const p of this.repo.list()) {
      if (!(await stat(p.path).catch(() => null))) {
        logger.warn("project directory missing; unregistering", { id: p.id, path: p.path });
        this.repo.delete(p.id);
        continue;
      }
      if ((await this.readManifest(p.path))?.ideaDraft) this.draftIds.add(p.id);
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
    return this.repo.list().map(({ slug: _slug, ...s }) => ({ ...s, ...(this.draftIds.has(s.id) ? { isDraft: true } : {}) }));
  }

  /**
   * Where a new project folder goes: the projects root, or a chosen absolute folder (real path).
   * A chosen folder that does not exist, or is not a folder, is `InvalidParentDirectory`.
   */
  private async parentRoot(parentDirectory: string | undefined): Promise<string> {
    if (!parentDirectory) return this.rootDir;
    if (!isAbsolute(parentDirectory)) throw new ToolError("Choose an absolute project location", "invalid_args");
    const root = await realpath(parentDirectory).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "ELOOP" || e.code === "EACCES")
        throw new InvalidParentDirectory();
      throw e;
    });
    if (!(await stat(root)).isDirectory()) throw new InvalidParentDirectory("Project location must be a folder");
    return root;
  }

  async importDestination(name: string, parentDirectory?: string): Promise<{ path: string; exists: boolean }> {
    const root = await this.parentRoot(parentDirectory);
    const path = join(root, slugify(name));
    return { path, exists: !!(await stat(path).catch(() => null)) };
  }

  async resolve(ref: string): Promise<ProjectHandle | null> {
    // Absolute selectors are deliberately ephemeral. In particular, a copied manifest must never
    // repoint the persistent row or ID-keyed handle belonging to the canonical project.
    if (isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref)) return this.ephemeralHandle(ref);
    const row = this.repo.find(ref) ?? (ref.includes(sep) ? this.repo.find(resolve(ref)) : null);
    if (row) return this.handle(row.id);
    return null;
  }

  private async ephemeralHandle(requestedDir: string): Promise<ProjectHandle | null> {
    const resolved = resolve(requestedDir);
    const metadata = await stat(resolved).catch(() => null);
    if (!metadata?.isDirectory()) return null;
    const dir = await realpath(resolved).catch(() => null);
    if (!dir) return null;
    const required = [
      PROJECT_FILES.manifest,
      PROJECT_FILES.boardPro,
      PROJECT_FILES.boardSch,
      PROJECT_FILES.boardPcb,
    ];
    for (const path of required) {
      const jailed = await jailPath(dir, path).catch(() => null);
      const file = jailed ? await stat(jailed).catch(() => null) : null;
      if (!file?.isFile()) return null;
    }
    const manifest = await this.readManifest(dir);
    if (!manifest) return null;
    let current = manifest;
    const h: ProjectHandle = {
      id: manifest.id,
      name: manifest.name,
      dir,
      manifest: () => current,
      async updateManifest(patch) {
        current = ProjectManifest.parse({
          ...current,
          ...patch,
          id: manifest.id,
          updatedAt: new Date().toISOString(),
        });
        await writeJson(await jailPath(dir, PROJECT_FILES.manifest), current);
        h.name = current.name;
        return current;
      },
    };
    return h;
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
        current = ProjectManifest.parse({
          ...current,
          ...patch,
          id: row.id,
          updatedAt: new Date().toISOString(),
        });
        await writeJson(join(row.path, PROJECT_FILES.manifest), current);
        store.repo.upsert({
          id: row.id,
          name: current.name,
          slug: row.slug,
          path: row.path,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        });
        h.name = current.name;
        return current;
      },
    };
    this.handles.set(id, h);
    return h;
  }

  async create(
    name: string,
    parentDirectory?: string,
    extras?: boolean | { material?: BoardMaterialId; construction?: BoardConstructionId; draft?: boolean },
  ): Promise<ProjectDetail> {
    const opts = typeof extras === "boolean" ? { draft: extras } : extras ?? {};
    const draft = opts.draft === true;
    const root = await this.parentRoot(parentDirectory);
    await mkdir(root, { recursive: true });
    const base = draft ? `idea-${newId("draft")}` : slugify(name);
    let slug = base;
    // Reserve a fresh directory atomically; never reuse or overwrite an existing folder.
    for (let i = 2; ; i++) {
      if (this.repo.list().some((project) => project.slug === slug)) { slug = `${base}-${i}`; continue; }
      try { await mkdir(join(root, slug)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        slug = `${base}-${i}`;
      }
    }
    const dir = join(root, slug);
    const ts = new Date().toISOString();
    const material = opts.material;
    const construction = opts.construction;
    const layers =
      construction !== undefined
        ? layersForConstruction(construction)
        : material
          ? BOARD_MATERIAL_DEFAULT_LAYERS[material]
          : 2;
    const manifest = ProjectManifest.parse({
      schema: 1,
      id: newId("prj"),
      name,
      ...(draft ? { ideaDraft: {} } : {}),
      createdAt: ts,
      updatedAt: ts,
      board: {
        layers,
        ...(material ? { material } : {}),
        ...(construction ? { construction } : {}),
      },
    });
    for (const sub of [
      PROJECT_FILES.sketches,
      PROJECT_FILES.renders,
      PROJECT_FILES.reports,
      PROJECT_FILES.exports,
      PROJECT_FILES.runs,
    ])
      await mkdir(join(dir, sub), { recursive: true });
    await writeJson(join(dir, PROJECT_FILES.manifest), manifest);
    await Bun.write(join(dir, ".gitignore"), ".fabdesk/\nrenders/\nexports/\n");
    // Concurrent creations in different parents may reserve the same basename.
    const registeredSlug = this.repo.list().some((project) => project.slug === slug) ? `${slug}-${manifest.id}` : slug;
    this.repo.upsert({ id: manifest.id, name, slug: registeredSlug, path: dir, createdAt: ts, updatedAt: ts });
    if (draft) this.draftIds.add(manifest.id);
    if (this.opts.watch !== false) this.watchDir(manifest.id, dir);
    this.emit({
      ts: Date.now(),
      topic: "project.changed",
      projectId: manifest.id,
      paths: [PROJECT_FILES.manifest],
    });
    return (await this.detail(manifest.id))!;
  }

  /** Promote the same owned workspace; relative attachments and thread ownership do not change. */
  async promoteDraft(id: string, name: string, parentDirectory?: string): Promise<ProjectDetail> {
    if (this.promoting.has(id)) throw new ToolError("Project setup is already in progress.", "precondition");
    this.promoting.add(id);
    let destination: string | null = null;
    try {
      const h = await this.handle(id), row = this.repo.get(id);
      if (!h || !row) throw new ToolError("This idea draft is no longer available.", "not_found");
      if (!h.manifest().ideaDraft) throw new ToolError("This draft already became a project. Reopen it rather than creating a duplicate.", "precondition");
      const root = await this.parentRoot(parentDirectory);
      await mkdir(root, { recursive: true });
      const base = slugify(name);
      let slug = base;
      for (let i = 2; ; i++) {
        if (this.repo.list().some(item => item.id !== id && item.slug === slug)) { slug = `${base}-${i}`; continue; }
        try { await mkdir(join(root, slug)); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; slug = `${base}-${i}`; }
      }
      destination = join(root, slug);
      const old = h.manifest();
      const { ideaDraft: _draft, ...rest } = old;
      const manifest = ProjectManifest.parse({ ...rest, name, promotedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      this.unwatch(id);
      try {
        // Replacing our freshly reserved empty folder never merges into an existing project.
        // Windows refuses to rename onto an existing folder, even an empty one.
        if (process.platform === "win32") await rmdir(destination);
        await rename(row.path, destination);
        try {
          await writeJson(join(destination, PROJECT_FILES.manifest), manifest);
          this.repo.upsert({ ...row, slug, path: destination, name, updatedAt: manifest.updatedAt });
        } catch (error) {
          await writeJson(join(destination, PROJECT_FILES.manifest), old);
          await rename(destination, row.path);
          throw error;
        }
      } catch (error) {
        if (this.opts.watch !== false) this.watchDir(id, row.path);
        throw error;
      }
      this.handles.delete(id);
      this.draftIds.delete(id);
      if (this.opts.watch !== false) this.watchDir(id, destination);
      destination = null;
      this.emit({ ts: Date.now(), topic: "project.changed", projectId: id, paths: [PROJECT_FILES.manifest] });
      return (await this.detail(id))!;
    } finally {
      // Only our empty reservation is removable; never recursively delete draft contents.
      if (destination) await rmdir(destination).catch(() => {});
      this.promoting.delete(id);
    }
  }

  isPromoting(id: string): boolean { return this.promoting.has(id); }

  /** Clone an allowed git URL into the projects root and register it as a fabPlane project. */
  async importFromGit(opts: {
    name: string;
    gitUrl: string;
    clone?: (url: string, dir: string) => Promise<void>;
    parentDirectory?: string;
    signal?: AbortSignal;
    failOnCollision?: boolean;
  }): Promise<ProjectDetail> {
    const root = await this.parentRoot(opts.parentDirectory);
    await mkdir(root, { recursive: true });
    const base = slugify(opts.name);
    let slug = base;
    // Reserve the destination atomically. Only remove directories this call created.
    for (let i = 2; ; i++) {
      try { await mkdir(join(root, slug)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (opts.failOnCollision) throw new ToolError(`A folder named ${slug} already exists here`, "invalid_args");
        slug = `${base}-${i}`;
      }
    }
    const dir = join(root, slug);
    try {
      opts.signal?.throwIfAborted();
      await (opts.clone ?? ((url, dest) => defaultGitClone(url, dest, opts.signal)))(opts.gitUrl, dir);
      opts.signal?.throwIfAborted();
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      if (opts.signal?.aborted) throw new ToolError("GitHub import canceled", "unavailable");
      // Git is assumed present. Surface a missing binary only at clone time.
      const missingGit = gitMissingFromClone(e);
      if (missingGit) {
        logger.warn("git missing at clone time", {
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof Error && "path" in e ? { path: String((e as NodeJS.ErrnoException).path ?? "") } : {}),
        });
        throw new ToolError(missingGit, "unavailable");
      }
      throw new ToolError(
        `could not clone ${opts.gitUrl}: ${e instanceof Error ? e.message : String(e)}`,
        "unavailable",
      );
    }
    let registeredId: string | null = null;
    try {
    const ts = new Date().toISOString();
    const existing = await this.readManifest(dir);
    const manifest = ProjectManifest.parse({
      schema: 1,
      id: newId("prj"),
      name: opts.name,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      board: existing?.board ?? { layers: 2 },
      ...(existing?.router ? { router: existing.router } : {}),
    });
    for (const sub of [
      PROJECT_FILES.sketches,
      PROJECT_FILES.renders,
      PROJECT_FILES.reports,
      PROJECT_FILES.exports,
      PROJECT_FILES.runs,
    ]) {
      await mkdir(join(dir, sub), { recursive: true });
    }
    await writeJson(join(dir, PROJECT_FILES.manifest), manifest);
    opts.signal?.throwIfAborted();
    // Slugs are globally unique, but destination folders are scoped to their
    // parent. Allocate the internal name after cloning without renaming the
    // destination the user confirmed. No await between allocation and upsert.
    const registeredSlug = this.repo.list().some((project) => project.slug === slug) ? `${slug}-${manifest.id}` : slug;
    this.repo.upsert({
      id: manifest.id,
      name: opts.name,
      slug: registeredSlug,
      path: dir,
      createdAt: manifest.createdAt,
      updatedAt: ts,
    });
    registeredId = manifest.id;
    if (this.opts.watch !== false) this.watchDir(manifest.id, dir);
    this.emit({
      ts: Date.now(),
      topic: "project.changed",
      projectId: manifest.id,
      paths: [PROJECT_FILES.manifest],
    });
    return (await this.detail(manifest.id))!;
    } catch (error) {
      if (registeredId) { this.unwatch(registeredId); this.handles.delete(registeredId); this.repo.delete(registeredId); }
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async detail(id: string): Promise<ProjectDetail | null> {
    const row = this.repo.get(id);
    if (!row) return null;
    const h = await this.handle(id);
    if (!h) return null;
    const files = await this.outputGenerationTimes.attach(row.path, id, await this.listFiles(row.path));
    const { slug: _slug, ...summary } = row;
    return { ...summary, ...(h.manifest().ideaDraft ? { isDraft: true } : {}), name: h.name, manifest: h.manifest(), files };
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
    else
      await rename(
        join(row.path, PROJECT_FILES.manifest),
        join(row.path, FORGOTTEN_MANIFEST),
      ).catch(() => undefined);
    // Every client keeps its own project list; without this the row lingered on the other device.
    this.emit({ ts: Date.now(), topic: "project.changed", projectId: id, paths: [] });
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
          if (st)
            out.push({
              path: relative(dir, abs).split(sep).join("/"),
              size: st.size,
              mtime: st.mtime.toISOString(),
            });
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
        logger.warn("invalid fabdesk.json ignored", {
          dir,
          issue: parsed.error.issues[0]?.message,
        });
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
      logger.warn("fs.watch unavailable", {
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
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
        this.emit({
          ts: Date.now(),
          topic: "project.changed",
          projectId: id,
          paths: [...paths].slice(0, 100),
        });
      } catch (e) {
        logger.warn("project.changed emit failed", {
          error: e instanceof Error ? e.message : String(e),
        });
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

/** True when spawn failed because `git` is not on PATH (Bun/Node ENOENT). */
export function gitMissingFromClone(error: unknown): string | null {
  const err = error as NodeJS.ErrnoException;
  const message = error instanceof Error ? error.message : String(error);
  const spawnGit = err?.syscall === "spawn git" || err?.path === "git";
  if (
    (err?.code === "ENOENT" && spawnGit) ||
    /executable not found in \$PATH:\s*"?git"?/i.test(message)
  ) {
    return "Git is not installed or is not on your PATH. Install Git, then try cloning again.";
  }
  return null;
}

async function defaultGitClone(url: string, dir: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Full history without every old file: Board History lists commits at once and fetches a revision when it is opened.
    const child = spawn("git", ["-c", "credential.helper=", "clone", "--filter=blob:none", "--progress", url, dir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
      ...(signal ? { signal } : {}),
    });
    let stderr = "";
    let processError: Error | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Abort emits an error before Git has exited. Let close settle the promise so
    // import cleanup cannot race with the child's remaining filesystem writes.
    child.on("error", (error) => { processError = error; });
    child.on("close", (code) => {
      if (processError) reject(processError);
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git clone exited ${code}`));
    });
  });
}

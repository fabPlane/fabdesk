import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  RouterCatalogId,
  RouterInstallPhase,
  RouterList,
  RouterSnapshot,
} from "@fabdesk/protocol";
import { downloadAndVerify, offlineOrFetchError, verifyFileSha256 } from "./checksum";
import {
  defaultRouterCatalog,
  type RouterArtifact,
  type RouterCatalogEntry,
} from "./catalog";
import { bundledHint, installHintFor } from "./hints";
import { resolveTraceMakerInstallArtifact } from "./tracemaker-release";

const STATE_FILE = "state.json";
const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

type PersistedRouter = {
  state: "installed" | "failed" | "not_installed";
  version?: string;
  error?: string;
  /** Non-fatal context kept next to a successful install (source-only fallback explanation). */
  notice?: string;
  path?: string;
  sha256?: string;
};

type InstallJob = {
  abort: AbortController;
  promise: Promise<RouterSnapshot>;
  received: number;
  total: number;
  phase: RouterInstallPhase;
  done: boolean;
};

type PersistedState = { routers: Partial<Record<RouterCatalogId, PersistedRouter>> };

export type BundledRouter = { version?: string; path?: string };

export type RouterRegistryDeps = {
  home: string;
  fetch?: typeof fetch;
  catalog?: RouterCatalogEntry[];
  bundled?: Partial<Record<RouterCatalogId, BundledRouter>>;
  env?: NodeJS.ProcessEnv;
  spawn?: (cmd: string, args: string[]) => Promise<number>;
};

export interface RouterRegistry {
  list(preferredRouter?: RouterCatalogId): RouterList;
  get(id: RouterCatalogId): RouterSnapshot;
  install(id: RouterCatalogId): Promise<RouterSnapshot>;
  cancel(id: RouterCatalogId): Promise<RouterSnapshot>;
  uninstall(id: RouterCatalogId): Promise<RouterSnapshot>;
  executable(id: RouterCatalogId): string | null;
}

export function routersRoot(home: string): string {
  return join(home, "routers");
}

export function createRouterRegistry(deps: RouterRegistryDeps): RouterRegistry {
  return new FileRouterRegistry(deps);
}

class FileRouterRegistry implements RouterRegistry {
  private readonly root: string;
  private readonly catalog: RouterCatalogEntry[];
  private readonly bundled: Partial<Record<RouterCatalogId, BundledRouter>>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inflight = new Map<RouterCatalogId, InstallJob>();
  private readonly versionProbes = new Map<string, string | null>();
  private persisted: PersistedState = { routers: {} };

  constructor(private readonly deps: RouterRegistryDeps) {
    this.root = routersRoot(deps.home);
    this.catalog = deps.catalog ?? defaultRouterCatalog(deps.env ?? process.env);
    this.bundled = { fab_router: { version: "bundled" }, ...deps.bundled };
    this.env = deps.env ?? process.env;
    this.persisted = this.readState();
  }

  list(preferredRouter?: RouterCatalogId): RouterList {
    const routers = this.catalog.map((entry) => this.snapshot(entry));
    return preferredRouter ? { routers, preferredRouter } : { routers };
  }

  get(id: RouterCatalogId): RouterSnapshot {
    const entry = this.entry(id);
    return this.snapshot(entry);
  }

  executable(id: RouterCatalogId): string | null {
    const snap = this.get(id);
    return snap.ready && snap.path ? snap.path : null;
  }

  async install(id: RouterCatalogId): Promise<RouterSnapshot> {
    const existing = this.inflight.get(id);
    if (existing) return existing.promise;
    const entry = this.entry(id);
    if (entry.install === "bundled" || this.bundled[id]) return this.snapshot(entry);
    const current = this.snapshot(entry);
    if (current.state === "installed" && current.ready) return current;
    const local = this.localOverride(id);
    if (local) {
      this.persisted.routers[id] = { state: "installed", version: entry.version, path: local };
      await this.writeState();
      return this.snapshot(entry);
    }
    const artifact = entry.artifact;
    if (!artifact) {
      this.persisted.routers[id] = {
        state: "failed",
        error: `${entry.displayName} has no downloadable artifact.`,
      };
      await this.writeState();
      return this.snapshot(entry);
    }
    const abort = new AbortController();
    const job: InstallJob = {
      abort,
      promise: Promise.resolve(this.snapshot(entry)),
      received: 0,
      total: artifact.bytes ?? 0,
      phase: "resolving",
      done: false,
    };
    const promise = this.runInstall(entry, artifact, abort, job);
    job.promise = promise;
    this.inflight.set(id, job);
    try {
      return await promise;
    } finally {
      this.inflight.delete(id);
    }
  }

  async cancel(id: RouterCatalogId): Promise<RouterSnapshot> {
    const job = this.inflight.get(id);
    job?.abort.abort();
    if (job) {
      await job.promise.catch(() => undefined);
    }
    const current = this.persisted.routers[id];
    if (current?.state === "failed" && current.error) {
      /* keep the cancel/error */
    } else if (!this.bundled[id] && current?.state !== "installed") {
      this.persisted.routers[id] = { state: "not_installed" };
      await this.writeState();
    }
    await this.cleanPartials(id);
    return this.get(id);
  }

  async uninstall(id: RouterCatalogId): Promise<RouterSnapshot> {
    const entry = this.entry(id);
    if (entry.install === "bundled" || this.bundled[id]) {
      throw new Error(`${entry.displayName} is bundled and cannot be uninstalled.`);
    }
    await this.cancel(id);
    await rm(this.installDir(id), { recursive: true, force: true });
    this.persisted.routers[id] = { state: "not_installed" };
    await this.writeState();
    return this.snapshot(entry);
  }

  private entry(id: RouterCatalogId): RouterCatalogEntry {
    const found = this.catalog.find((row) => row.id === id);
    if (!found) throw new Error(`unknown router: ${id}`);
    return found;
  }

  private snapshot(entry: RouterCatalogEntry): RouterSnapshot {
    const bundled = this.bundled[entry.id];
    const local = this.localOverride(entry.id);
    const job = this.inflight.get(entry.id);
    const saved = this.persisted.routers[entry.id];
    if (bundled || entry.install === "bundled") {
      const path = bundled?.path ?? local;
      return {
        id: entry.id,
        displayName: entry.displayName,
        description: entry.description,
        strengths: entry.strengths,
        license: entry.license,
        version: bundled?.version ?? entry.version,
        homepage: entry.homepage,
        install: "bundled",
        state: "bundled",
        ready: true,
        installHint: bundledHint(entry.id, path ?? undefined),
        versionInstalled: bundled?.version ?? entry.version,
        ...(path ? { path } : {}),
      };
    }
    if (job && !job.done) {
      return {
        ...this.base(entry),
        state: "installing",
        ready: false,
        installHint: `Installing ${entry.displayName}…`,
        progress: { received: job.received, total: job.total, phase: job.phase },
      };
    }
    if (local) {
      const envName = this.overrideEnv(entry.id);
      const probed = this.probeVersion(entry.id, local);
      return {
        ...this.base(entry),
        state: "installed",
        ready: true,
        installHint: `Using ${envName}=${local}. Unset ${envName} to manage ${entry.displayName} from Settings.`,
        versionInstalled: probed ?? entry.version,
        path: local,
        overriddenBy: envName,
      };
    }
    if (saved?.state === "installed" && saved.path && existsSync(saved.path)) {
      const runnable = this.resolveRunnable(entry, saved.path);
      const ready = runnable !== null;
      const envName = this.overrideEnv(entry.id);
      return {
        ...this.base(entry),
        state: "installed",
        ready,
        sourceOnly: !ready,
        installHint: ready
          ? `${entry.displayName} ${saved.version ?? entry.version} is installed.`
          : `${entry.displayName} ${saved.version ?? entry.version} source package is installed, but there is no runnable binary yet. Build it in ${saved.path}, or set ${envName} to a built binary.`,
        ...(saved.version ? { versionInstalled: saved.version } : {}),
        ...(saved.error ? { error: saved.error } : {}),
        ...(saved.notice ? { notice: saved.notice } : {}),
        path: runnable ?? saved.path,
      };
    }
    if (saved?.state === "failed") {
      return {
        ...this.base(entry),
        state: "failed",
        ready: false,
        // The error is shown on its own line by the card; keep the hint to the generic how-to.
        installHint: installHintFor(entry.id),
        ...(saved.error ? { error: saved.error } : {}),
        ...(this.overrideProblem(entry.id) ? { notice: this.overrideProblem(entry.id) as string } : {}),
      };
    }
    return {
      ...this.base(entry),
      state: "not_installed",
      ready: false,
      installHint: installHintFor(entry.id),
      ...(this.overrideProblem(entry.id) ? { notice: this.overrideProblem(entry.id) as string } : {}),
    };
  }

  private base(entry: RouterCatalogEntry) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      description: entry.description,
      strengths: entry.strengths,
      license: entry.license,
      version: entry.version,
      homepage: entry.homepage,
      install: entry.install,
    };
  }

  private overrideEnv(id: RouterCatalogId): string {
    return id === "tracemaker" ? "TRACEMAKER_BIN" : id === "freerouting" ? "FREEROUTING_JAR" : "";
  }

  private localOverride(id: RouterCatalogId): string | null {
    const key = this.overrideEnv(id);
    if (!key) return null;
    const value = this.env[key]?.trim();
    if (!value) return null;
    if (id === "tracemaker") return isRunnableFile(value) ? value : null;
    if (id === "freerouting") return isFile(value) ? value : null;
    return existsSync(value) ? value : null;
  }

  /** Why an env override that is set cannot be used (so the card can say so instead of ignoring it). */
  private overrideProblem(id: RouterCatalogId): string | undefined {
    const key = this.overrideEnv(id);
    const value = key ? this.env[key]?.trim() : undefined;
    if (!key || !value || this.localOverride(id)) return undefined;
    return !existsSync(value)
      ? `${key} is set to ${value}, which does not exist.`
      : `${key} is set to ${value}, which is not a runnable ${id === "freerouting" ? "jar" : "executable file"}.`;
  }

  /**
   * The runnable file for an installed package: `path` itself when it is a runnable file, or a built
   * binary found inside the package directory (a source tarball the user has since built). A directory
   * or a non-executable file never counts, so `route_run` cannot be handed something it cannot spawn.
   */
  private resolveRunnable(entry: RouterCatalogEntry, path: string): string | null {
    if (entry.id === "freerouting") {
      return isFile(path) && /\.jar$/i.test(path) ? path : null;
    }
    if (entry.id === "tracemaker") {
      if (isRunnableFile(path) && /(^|[\\/])tracemaker(\.exe)?$/.test(path)) return path;
      if (isDirectory(path)) return findNamedFile(path, "tracemaker", isRunnableFile);
      return null;
    }
    return existsSync(path) ? path : null;
  }

  private binaryReady(entry: RouterCatalogEntry, path: string): boolean {
    return this.resolveRunnable(entry, path) !== null;
  }

  /** `<bin> --version`, cached per path + mtime, so a router supplied by env shows its real version. */
  private probeVersion(id: RouterCatalogId, path: string): string | null {
    if (id !== "tracemaker") return null;
    let key = path;
    try {
      key = `${path}:${statSync(path).mtimeMs}`;
    } catch {
      return null;
    }
    if (this.versionProbes.has(key)) return this.versionProbes.get(key) ?? null;
    let version: string | null = null;
    try {
      const out = spawnSync(path, ["--version"], { timeout: 1500, encoding: "utf8" });
      const match = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(`${out.stdout ?? ""} ${out.stderr ?? ""}`);
      version = match ? match[0] : null;
    } catch {
      version = null;
    }
    this.versionProbes.set(key, version);
    return version;
  }

  private installDir(id: RouterCatalogId): string {
    return join(this.root, id);
  }

  private async runInstall(
    entry: RouterCatalogEntry,
    artifact: RouterArtifact,
    abort: AbortController,
    job: InstallJob,
  ): Promise<RouterSnapshot> {
    const work = join(this.root, `.install-${entry.id}-${process.pid}`);
    const backup = join(this.root, `.backup-${entry.id}-${process.pid}`);
    const final = this.installDir(entry.id);
    const prior = this.persisted.routers[entry.id];
    let versionOverride: string | undefined;
    let resolveWarning: string | undefined;
    let swapped = false;
    try {
      if (entry.id === "tracemaker") {
        job.phase = "resolving";
        const resolved = await resolveTraceMakerInstallArtifact({
          source: artifact,
          ...(entry.binaryRelease ? { binaryRelease: entry.binaryRelease } : {}),
          env: this.env,
          ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
          signal: abort.signal,
        });
        artifact = resolved.artifact;
        versionOverride = resolved.version;
        resolveWarning = resolved.warning;
        job.total = artifact.bytes ?? job.total;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true, mode: 0o700 });
      const destFile = join(work, artifact.filename);
      job.phase = "downloading";
      const downloaded = await downloadAndVerify({
        url: artifact.url,
        dest: destFile,
        sha256: artifact.sha256,
        signal: abort.signal,
        ...(artifact.bytes !== undefined ? { bytes: artifact.bytes } : {}),
        maxBytes: MAX_ARTIFACT_BYTES,
        ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
        onProgress: (received, total) => {
          job.received = received;
          job.total = total;
        },
      });
      abort.signal.throwIfAborted();
      job.phase = "verifying";
      await verifyFileSha256(destFile, artifact.sha256);
      job.phase = "extracting";
      const extracted = join(work, "extracted");
      await mkdir(extracted, { recursive: true });
      await this.materialize(artifact, destFile, extracted);
      abort.signal.throwIfAborted();
      // Swap the finished tree in only now, keeping the previous install until the new one is recorded,
      // so a failure at any step never leaves a half-installed directory behind.
      await rm(backup, { recursive: true, force: true });
      if (existsSync(final)) await rename(final, backup);
      swapped = true;
      await rename(extracted, final);
      const readyPath = this.findReadyPath(final, artifact) ?? final;
      const binaryReady = this.binaryReady(entry, readyPath);
      if (binaryReady) await chmod(readyPath, 0o755).catch(() => undefined);
      const notice = !binaryReady
        ? `${(resolveWarning ?? `No runnable ${entry.displayName} binary was in the downloaded archive.`).replace(/[.\s]*$/, "")}. Only the source package was downloaded, so ${entry.displayName} is not usable until you build it or set ${this.overrideEnv(entry.id)}.`
        : undefined;
      this.persisted.routers[entry.id] = {
        state: "installed",
        version: versionOverride ?? entry.version,
        path: readyPath,
        sha256: downloaded.sha256,
        ...(notice ? { notice } : {}),
      };
      await this.writeState();
      await rm(backup, { recursive: true, force: true });
      return this.finish(job, entry);
    } catch (error) {
      const aborted = abort.signal.aborted;
      const message = aborted
        ? "Installation cancelled."
        : error instanceof Error
          ? error.message
          : String(error);
      if (swapped) {
        await rm(final, { recursive: true, force: true }).catch(() => undefined);
        if (existsSync(backup)) await rename(backup, final).catch(() => undefined);
      }
      this.persisted.routers[entry.id] =
        prior?.state === "installed" && existsSync(final)
          ? { ...prior, ...(aborted ? {} : { error: message }) }
          : { state: aborted ? "not_installed" : "failed", error: message };
      await this.writeState();
      return this.finish(job, entry);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private finish(job: InstallJob, entry: RouterCatalogEntry): RouterSnapshot {
    job.done = true;
    return this.snapshot(entry);
  }

  private findReadyPath(root: string, artifact: RouterArtifact): string | null {
    const name = artifact.executable ?? (artifact.format === "jar" || artifact.format === "file" ? artifact.filename : null);
    if (artifact.format === "jar" || artifact.format === "file") {
      const direct = join(root, artifact.filename);
      return existsSync(direct) ? direct : null;
    }
    if (!name) return null;
    const exact = join(root, name);
    if (existsSync(exact)) return exact;
    return findNamedFile(root, basename(name));
  }

  private async materialize(artifact: RouterArtifact, archive: string, dest: string): Promise<string> {
    if (artifact.format === "jar" || artifact.format === "file") {
      const target = join(dest, artifact.filename);
      await rename(archive, target);
      if (artifact.format === "file") await chmod(target, 0o755).catch(() => undefined);
      return target;
    }
    const spawn = this.deps.spawn ?? defaultSpawn;
    if (artifact.format === "tar.gz") {
      const code = await spawn("tar", ["-xzf", archive, "-C", dest]);
      if (code !== 0) throw new Error("failed to extract tar.gz artifact");
    } else {
      const code = await spawn("unzip", ["-o", archive, "-d", dest]);
      if (code !== 0) throw new Error("failed to extract zip artifact");
    }
    return this.findReadyPath(dest, artifact) ?? dest;
  }

  private async cleanPartials(id: RouterCatalogId): Promise<void> {
    for (const dir of [`.install-${id}-${process.pid}`, `.backup-${id}-${process.pid}`])
      await rm(join(this.root, dir), { recursive: true, force: true }).catch(() => undefined);
  }

  private readState(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(join(this.root, STATE_FILE), "utf8")) as PersistedState;
      return raw?.routers ? raw : { routers: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        /* corrupt state: start empty */
      }
      return { routers: {} };
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, STATE_FILE), `${JSON.stringify(this.persisted, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file the current user may execute (any exec bit on POSIX; any file on Windows). */
function isRunnableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    return process.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findNamedFile(
  root: string,
  name: string,
  accept: (path: string) => boolean = isFile,
): string | null {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 6) return null;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === name && accept(full)) return full;
      try {
        if (statSync(full).isDirectory()) {
          const hit = walk(full, depth + 1);
          if (hit) return hit;
        }
      } catch {
        /* skip */
      }
    }
    return null;
  };
  return walk(root, 0);
}

async function defaultSpawn(cmd: string, args: string[]): Promise<number> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "pipe" });
  return proc.exited;
}

export { offlineOrFetchError };

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
import { krtRootProblem, krtVersionAt, setupKrt, type KrtSetupDeps, type KrtSetupResult } from "./krt";
import { parseTraceMakerVersion, resolveTraceMakerInstallArtifact } from "./tracemaker-release";
import { withInstallLock, type InstallLockOptions } from "./install-lock";
import { extractZipArchive } from "./zip";

export { extractZipArchive };

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
  /** Progress lines to every caller sharing this install (the first one and any that joined it). */
  listeners: Set<(line: string) => void>;
  /** Replacing a ready install: a TraceMaker source fallback is refused so the working binary is kept. */
  replace: boolean;
};

type PersistedState = { routers: Partial<Record<RouterCatalogId, PersistedRouter>> };

export type BundledRouter = { version?: string; path?: string };

export type RouterRegistrySettings = {
  tracemakerManifestUrl?: string | null;
  /** A KiCadRoutingTools build that wins over FABDESK_KRT_DIR and the installed copy. */
  krtDir?: string | null;
  /** Board tools install a missing engine on first use (default true); false makes them report it instead. */
  autoInstallEngines?: boolean;
};

export type RouterInstallOptions = {
  /** Progress lines while it runs (phases, download share, the engine's own setup steps). */
  onLine?: (line: string) => void;
  /** Download and swap in a fresh copy even when a ready one is installed (TraceMaker's placer upgrade). */
  replace?: boolean;
};

/** TraceMaker's placer, which board_route's floorplan path runs. */
export const TRACEMAKER_PLACER = "tracemaker-place";
/** Points at a tracemaker-place to use instead of the one beside TraceMaker. */
export const TRACEMAKER_PLACE_ENV = "TRACEMAKER_PLACE_BIN";

export type TraceMakerPlacerState = NonNullable<RouterSnapshot["placer"]>;

/** What `ensurePlacer` found or did: the placer to run, or why there is none (phrased for the agent). */
export type PlacerEnsureResult = { path: string | null; why?: string; installed?: boolean };

/** What `ensure` found or did: the path to run, or why there is none (already phrased for the agent). */
export type EngineEnsureResult = { id: RouterCatalogId; path: string | null; why?: string; installed?: boolean };

export type EngineEnsureOptions = RouterInstallOptions & {
  /** An explicit request (the `board_engines` tool, Settings): ignores `autoInstallEngines` and retries a failure. */
  explicit?: boolean;
};

export type RouterRegistryDeps = {
  home: string;
  fetch?: typeof fetch;
  catalog?: RouterCatalogEntry[];
  bundled?: Partial<Record<RouterCatalogId, BundledRouter>>;
  env?: NodeJS.ProcessEnv;
  /** Live settings (re-read on each install). Env FABDESK_TRACEMAKER_MANIFEST_URL still wins. */
  settings?: () => RouterRegistrySettings;
  spawn?: (cmd: string, args: string[]) => Promise<number>;
  /** KRT's post-extract step (venv + packages); injectable so tests need no Python or network. */
  krtSetup?: (root: string, deps: KrtSetupDeps) => Promise<KrtSetupResult>;
  /** atlc's post-extract build (configure + make); injectable so tests need no C compiler. */
  atlcBuild?: (srcDir: string, log: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /** Tests only: timings and the liveness check of the cross-process install lock. */
  installLock?: Pick<InstallLockOptions, "staleMs" | "waitMs" | "pollMs" | "isAlive">;
};

/** The source tree inside atlc's install. */
const ATLC_SRC = "atlc-4.6.1";
const PATH_ATLC = "atlc on PATH";

/**
 * Build atlc from its source tree: `sh configure` then `make -C src atlc` (single-threaded, as Debian builds it;
 * `-fcommon` for GCC 10+, which upstream predates). Needs sh, a C compiler and make.
 */
export async function buildAtlc(srcDir: string, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (process.platform === "win32") throw new Error("atlc builds with sh, a C compiler and make, which Windows lacks; install an atlc build and set ATLC_BIN");
  for (const [what, cmd] of [
    ["configure", ["sh", "./configure", "CFLAGS=-O2 -fcommon"]],
    ["make", ["make", "-C", "src", "atlc"]],
  ] as const) {
    log(`atlc: ${what}`);
    const p = Bun.spawn([...cmd], { cwd: srcDir, stdout: "pipe", stderr: "pipe", signal });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`atlc ${what} failed (exit ${code}; a C compiler and make are needed): ${`${out}\n${err}`.trim().slice(-400)}`);
  }
}

export interface RouterRegistry {
  list(preferredRouter?: RouterCatalogId): RouterList;
  get(id: RouterCatalogId): RouterSnapshot;
  install(id: RouterCatalogId, opts?: RouterInstallOptions): Promise<RouterSnapshot>;
  /**
   * The engine's runnable path, installing it first when it is missing and installable (one shared install for
   * concurrent callers). Never installs over an override that is set but broken (Settings `krtDir`,
   * FABDESK_KRT_DIR, TRACEMAKER_BIN, FREEROUTING_JAR): that is reported instead. Automatic calls honour
   * `autoInstallEngines` and do not retry an install that already failed in this process.
   */
  ensure(id: RouterCatalogId, opts?: EngineEnsureOptions): Promise<EngineEnsureResult>;
  /**
   * TraceMaker's placer (`tracemaker-place`): TRACEMAKER_PLACE_BIN when set (never installed over when broken), else
   * the one beside TraceMaker, which is installed first like `ensure`. A managed install from an archive that predates
   * the placer is replaced once from the current release when that release carries it (same opt-out and no automatic
   * retry as `ensure`).
   */
  ensurePlacer(opts?: EngineEnsureOptions): Promise<PlacerEnsureResult>;
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

/**
 * tracemaker-place for a tracemaker binary: beside it (fabdesk's archives, an upstream install's bin/), or in a CMake
 * build tree's src/place next to src/app; then anywhere under `root` (a source package built in place). Runnable files
 * only.
 */
export function traceMakerPlacerNear(tracemaker: string, root?: string | null): string | null {
  const names = /\.exe$/i.test(tracemaker) || process.platform === "win32" ? [`${TRACEMAKER_PLACER}.exe`, TRACEMAKER_PLACER] : [TRACEMAKER_PLACER];
  const dir = dirname(tracemaker);
  for (const name of names)
    for (const candidate of [join(dir, name), join(dir, "..", "place", name)]) if (isRunnableFile(candidate)) return candidate;
  if (root && isDirectory(root))
    for (const name of names) {
      const hit = findNamedFile(root, name, isRunnableFile);
      if (hit) return hit;
    }
  return null;
}

/** TraceMaker prints `tracemaker 0.9.0` on `version`; `--version` is not a flag. */
export function probeTraceMakerCliVersion(path: string): string | null {
  for (const args of [["version"], ["--version"]] as const) {
    try {
      const out = spawnSync(path, args, { timeout: 1500, encoding: "utf8" });
      const parsed = parseTraceMakerVersion(`${out.stdout ?? ""} ${out.stderr ?? ""}`);
      if (parsed) return parsed;
    } catch {
      // try the next invocation
    }
  }
  return null;
}

class FileRouterRegistry implements RouterRegistry {
  private readonly root: string;
  private readonly catalog: RouterCatalogEntry[];
  private readonly bundled: Partial<Record<RouterCatalogId, BundledRouter>>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inflight = new Map<RouterCatalogId, InstallJob>();
  private readonly versionProbes = new Map<string, string | null>();
  /** Automatic installs that failed in this process: not retried until an explicit install. */
  private readonly autoFailed = new Map<RouterCatalogId, string>();
  /** Why the last placer upgrade (TraceMaker reinstall for tracemaker-place) did not add it; not retried automatically. */
  private placerUpgradeFailed: string | null = null;
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

  async ensure(id: RouterCatalogId, opts: EngineEnsureOptions = {}): Promise<EngineEnsureResult> {
    const entry = this.entry(id);
    const snap = this.snapshot(entry);
    if (snap.ready && snap.path) return { id, path: snap.path };
    if (snap.ready && entry.install === "bundled") return { id, path: null, why: `${entry.displayName} is bundled; it has no separate path` };
    const problem = this.overrideProblem(id);
    if (problem) return { id, path: null, why: `${problem} Fix or clear it; an installed copy is not used while it is set.` };
    if (!opts.explicit) {
      if (this.deps.settings?.().autoInstallEngines === false)
        return { id, path: null, why: `${entry.displayName} is not installed and automatic installs are off (Settings autoInstallEngines). board_engines {"action":"install","engine":"${id}"} installs it.` };
      const failed = this.autoFailed.get(id);
      if (failed) return { id, path: null, why: `${failed} (not retried automatically; board_engines {"action":"install","engine":"${id}"} retries)` };
    }
    this.autoFailed.delete(id);
    opts.onLine?.(`${entry.displayName} is not installed: installing it now (one time${entry.id === "krt" ? ", a few minutes cold" : ""})`);
    const done = await this.install(id, opts.onLine ? { onLine: opts.onLine } : {});
    if (done.ready && done.path) {
      opts.onLine?.(`${entry.displayName} ${done.versionInstalled ?? ""} installed at ${done.path}`.replace(/\s+/g, " "));
      return { id, path: done.path, installed: true };
    }
    let why = `${entry.displayName} did not install: ${done.error ?? done.notice ?? done.installHint}`;
    if (id === "tracemaker" && !/TRACEMAKER_BIN/.test(why))
      why += " If its binary manifest is unreachable (the GitHub release 404s while TensorFleet/fabdesk is private), set FABDESK_TRACEMAKER_MANIFEST_URL or Settings tracemakerManifestUrl to a public manifest, or TRACEMAKER_BIN.";
    if (!/Installation cancelled/.test(why)) this.autoFailed.set(id, why);
    return { id, path: null, why };
  }

  async ensurePlacer(opts: EngineEnsureOptions = {}): Promise<PlacerEnsureResult> {
    const placer = (): TraceMakerPlacerState => this.get("tracemaker").placer ?? { ready: false };
    const first = placer();
    if (first.overriddenBy || this.env[TRACEMAKER_PLACE_ENV]?.trim())
      return first.ready && first.path ? { path: first.path } : { path: null, why: `${first.why ?? `${TRACEMAKER_PLACE_ENV} is not usable.`} Fix or clear it.` };
    const tm = await this.ensure("tracemaker", opts);
    if (!tm.path) return { path: null, why: tm.why ?? "TraceMaker is not installed (the placer ships with it)." };
    const now = placer();
    if (now.ready && now.path) return { path: now.path };
    const snap = this.get("tracemaker");
    const saved = this.persisted.routers.tracemaker;
    // Only a managed binary install (not an override, not a source package built in place) can be replaced.
    if (snap.overriddenBy || saved?.state !== "installed" || !saved.path || !isFile(saved.path)) return { path: null, why: now.why ?? "tracemaker-place was not found" };
    if (!opts.explicit) {
      if (this.deps.settings?.().autoInstallEngines === false)
        return { path: null, why: `${now.why} Automatic installs are off (Settings autoInstallEngines); board_engines {"action":"install","engine":"tracemaker"} reinstalls it.` };
      if (this.placerUpgradeFailed) return { path: null, why: `${this.placerUpgradeFailed} (not retried automatically; board_engines {"action":"install","engine":"tracemaker"} retries)` };
    }
    const entry = this.entry("tracemaker");
    const artifact = entry.artifact;
    const failed = (why: string): PlacerEnsureResult => {
      this.placerUpgradeFailed = why;
      return { path: null, why };
    };
    if (!artifact) return failed(`${now.why} TraceMaker has no downloadable artifact to reinstall from.`);
    // Look before downloading: a release whose archive has no placer would replace TraceMaker with the same thing.
    const resolved = await resolveTraceMakerInstallArtifact(this.traceMakerResolveArgs(entry, artifact)).catch((error: unknown) => ({
      origin: "source" as const,
      warning: error instanceof Error ? error.message : String(error),
      placer: undefined,
    }));
    if (resolved.origin !== "binary") return failed(`tracemaker-place is not beside ${tm.path}, and no TraceMaker binary release is reachable to reinstall from (${(resolved.warning ?? "source-only fallback").replace(/[.\s]*$/, "")}). Set ${TRACEMAKER_PLACE_ENV} to a tracemaker-place.`);
    if (!resolved.placer) return failed(`tracemaker-place is not beside ${tm.path}, and the published TraceMaker release has none yet (its archives predate it; the weekly TraceMaker binaries job adds it). Set ${TRACEMAKER_PLACE_ENV} to a tracemaker-place meanwhile.`);
    opts.onLine?.(`TraceMaker at ${tm.path} has no tracemaker-place (an older archive): reinstalling it from the current release`);
    const done = await this.install("tracemaker", { replace: true, ...(opts.onLine ? { onLine: opts.onLine } : {}) });
    const after = placer();
    if (after.ready && after.path) {
      this.placerUpgradeFailed = null;
      opts.onLine?.(`tracemaker-place installed at ${after.path}`);
      return { path: after.path, installed: true };
    }
    return failed(done.error ? `TraceMaker reinstall (for tracemaker-place) failed: ${done.error}` : `${after.why ?? "tracemaker-place was not found"} (after reinstalling TraceMaker)`);
  }

  async install(id: RouterCatalogId, opts: RouterInstallOptions = {}): Promise<RouterSnapshot> {
    const existing = this.inflight.get(id);
    if (existing) {
      if (opts.onLine) {
        existing.listeners.add(opts.onLine);
        opts.onLine(`joining the ${id} install already running (${existing.phase})`);
      }
      return existing.promise;
    }
    const entry = this.entry(id);
    if (entry.install === "bundled" || this.bundled[id]) return this.snapshot(entry);
    const current = this.snapshot(entry);
    if (current.state === "installed" && current.ready && !opts.replace) return current;
    const local = this.localOverride(id);
    if (local) {
      this.persisted.routers[id] = { state: "installed", version: entry.version, path: local };
      await this.writeState(id);
      return this.snapshot(entry);
    }
    const artifact = entry.artifact;
    if (!artifact) {
      this.persisted.routers[id] = {
        state: "failed",
        error: `${entry.displayName} has no downloadable artifact.`,
      };
      await this.writeState(id);
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
      listeners: new Set(opts.onLine ? [opts.onLine] : []),
      replace: opts.replace === true,
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
      await this.writeState(id);
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
    // under the engine's install lock: never delete a tree another process is installing into
    await withInstallLock(
      join(this.root, `.lock-${id}`),
      async () => {
        await rm(this.installDir(id), { recursive: true, force: true });
        this.persisted.routers[id] = { state: "not_installed" };
        await this.writeState(id);
      },
      { ...this.deps.installLock },
    );
    return this.snapshot(entry);
  }

  private entry(id: RouterCatalogId): RouterCatalogEntry {
    const found = this.catalog.find((row) => row.id === id);
    if (!found) throw new Error(`unknown router: ${id}`);
    return found;
  }

  private snapshot(entry: RouterCatalogEntry): RouterSnapshot {
    const snap = this.engineSnapshot(entry);
    return entry.id === "tracemaker" ? { ...snap, placer: this.placerState(snap) } : snap;
  }

  /** Where tracemaker-place is for this TraceMaker snapshot (TRACEMAKER_PLACE_BIN first), or why it is not there. */
  private placerState(snap: RouterSnapshot): TraceMakerPlacerState {
    const set = this.env[TRACEMAKER_PLACE_ENV]?.trim();
    if (set)
      return isRunnableFile(set)
        ? { ready: true, path: set, overriddenBy: TRACEMAKER_PLACE_ENV }
        : { ready: false, why: `${TRACEMAKER_PLACE_ENV} is set to ${set}, which ${existsSync(set) ? "is not a runnable executable file" : "does not exist"}.` };
    if (!snap.ready || !snap.path) return { ready: false, why: "TraceMaker is not installed (tracemaker-place ships with it)." };
    const saved = this.persisted.routers.tracemaker;
    const managed = !snap.overriddenBy;
    const path = traceMakerPlacerNear(snap.path, managed ? this.installDir("tracemaker") : null);
    if (path) return { ready: true, path };
    if (!managed)
      return { ready: false, why: `tracemaker-place is not beside ${snap.overriddenBy}=${snap.path} (nor in its build tree's src/place). Put it there or set ${TRACEMAKER_PLACE_ENV}.` };
    if (saved?.path && isDirectory(saved.path))
      return { ready: false, why: `TraceMaker was built from source in ${saved.path} without tracemaker-place: build that target too (cmake --build <build dir> --target tracemaker-place), or set ${TRACEMAKER_PLACE_ENV}.` };
    return {
      ready: false,
      why:
        this.placerUpgradeFailed ??
        `The installed TraceMaker ${snap.versionInstalled ?? ""} at ${snap.path} has no tracemaker-place beside it (its archive predates it). board_engines {"action":"install","engine":"tracemaker"} reinstalls it from the current release, or set ${TRACEMAKER_PLACE_ENV}.`.replace(/\s+/g, " "),
    };
  }

  private engineSnapshot(entry: RouterCatalogEntry): RouterSnapshot {
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
      const envName = this.overrideSource(entry.id)?.name ?? this.overrideEnv(entry.id);
      const probed = this.probeVersion(entry.id, local);
      const clear = envName.startsWith("Settings") ? "Clear that setting" : `Unset ${envName}`;
      return {
        ...this.base(entry),
        state: "installed",
        ready: true,
        installHint: envName === PATH_ATLC ? `Using the atlc on PATH at ${local}.` : `Using ${envName}=${local}. ${clear} to manage ${entry.displayName} from Settings.`,
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
          : entry.id === "krt"
            ? `${entry.displayName} ${saved.version ?? entry.version} at ${saved.path} is incomplete (${krtRootProblem(saved.path) ?? "not runnable"}). Reinstall it, or set FABDESK_KRT_DIR to a build.`
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
      ...(entry.kind ? { kind: entry.kind } : {}),
    };
  }

  private overrideEnv(id: RouterCatalogId): string {
    return id === "tracemaker" ? "TRACEMAKER_BIN" : id === "freerouting" ? "FREEROUTING_JAR" : id === "krt" ? "FABDESK_KRT_DIR" : id === "atlc" ? "ATLC_BIN" : "";
  }

  /** The override that is set, if any: Settings `krtDir` (KRT only), then the env var. */
  private overrideSource(id: RouterCatalogId): { name: string; value: string } | null {
    if (id === "krt") {
      const fromSettings = this.deps.settings?.().krtDir?.trim();
      if (fromSettings) return { name: "Settings krtDir", value: fromSettings };
    }
    const key = this.overrideEnv(id);
    const value = key ? this.env[key]?.trim() : undefined;
    if (key && value) return { name: key, value };
    if (id === "atlc") {
      // a system package (Debian/Ubuntu `atlc`) is used as it is
      const onPath = Bun.which("atlc", { PATH: this.env["PATH"] ?? "" });
      if (onPath) return { name: PATH_ATLC, value: onPath };
    }
    return null;
  }

  private localOverride(id: RouterCatalogId): string | null {
    const value = this.overrideSource(id)?.value;
    if (!value) return null;
    if (id === "tracemaker" || id === "atlc") return isRunnableFile(value) ? value : null;
    if (id === "freerouting") return isFile(value) ? value : null;
    if (id === "krt") return krtRootProblem(value) === null ? value : null;
    return existsSync(value) ? value : null;
  }

  /** Why an override that is set cannot be used (so the card can say so instead of ignoring it). */
  private overrideProblem(id: RouterCatalogId): string | undefined {
    const source = this.overrideSource(id);
    if (!source || this.localOverride(id)) return undefined;
    const { name: key, value } = source;
    if (!existsSync(value)) return `${key} is set to ${value}, which does not exist.`;
    if (id === "krt") return `${key} is set to ${value}, which is not a KiCadRoutingTools build (${krtRootProblem(value)}).`;
    return `${key} is set to ${value}, which is not a runnable ${id === "freerouting" ? "jar" : "executable file"}.`;
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
    if (entry.id === "krt") return krtRootProblem(path) === null ? path : null;
    if (entry.id === "atlc") return isRunnableFile(path) ? path : isDirectory(path) ? findNamedFile(path, "atlc", isRunnableFile) : null;
    return existsSync(path) ? path : null;
  }

  private binaryReady(entry: RouterCatalogEntry, path: string): boolean {
    return this.resolveRunnable(entry, path) !== null;
  }

  /** `tracemaker version`, then `--version`. Cached per path + mtime. */
  private probeVersion(id: RouterCatalogId, path: string): string | null {
    if (id === "krt") return krtVersionAt(path);
    if (id !== "tracemaker") return null;
    let key = path;
    try {
      key = `${path}:${statSync(path).mtimeMs}`;
    } catch {
      return null;
    }
    if (this.versionProbes.has(key)) return this.versionProbes.get(key) ?? null;
    const version = probeTraceMakerCliVersion(path);
    this.versionProbes.set(key, version);
    return version;
  }

  private traceMakerResolveArgs(entry: RouterCatalogEntry, source: RouterArtifact): Parameters<typeof resolveTraceMakerInstallArtifact>[0] {
    return {
      source,
      ...(entry.binaryRelease ? { binaryRelease: entry.binaryRelease } : {}),
      env: this.env,
      ...(this.deps.settings ? { settings: this.deps.settings() } : {}),
      ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
    };
  }

  private installDir(id: RouterCatalogId): string {
    return join(this.root, id);
  }

  /**
   * One install at a time per engine across processes (`inflight` only covers this one): wait for another
   * process's install, then use what it installed instead of installing again.
   */
  private async runInstall(
    entry: RouterCatalogEntry,
    artifact: RouterArtifact,
    abort: AbortController,
    job: InstallJob,
  ): Promise<RouterSnapshot> {
    const emit = (line: string) => {
      for (const listener of job.listeners) {
        try {
          listener(line);
        } catch {
          /* a caller that went away */
        }
      }
    };
    try {
      return await withInstallLock(
        join(this.root, `.lock-${entry.id}`),
        async () => {
          this.refreshState(entry.id);
          const saved = this.persisted.routers[entry.id];
          if (!job.replace && saved?.state === "installed" && saved.path && existsSync(saved.path) && this.resolveRunnable(entry, saved.path) !== null) {
            emit(`${entry.displayName}: installed by another fabdesk process`);
            return this.finish(job, entry);
          }
          return this.runInstallLocked(entry, artifact, abort, job);
        },
        {
          ...this.deps.installLock,
          signal: abort.signal,
          onWait: (holder) =>
            emit(`${entry.displayName}: waiting for another fabdesk process${holder ? ` (pid ${holder.pid})` : ""} that is installing it`),
        },
      );
    } catch (error) {
      // Only the wait itself fails here (runInstallLocked records its own errors). The lock holder owns state.json,
      // so this outcome stays in memory.
      this.refreshState(entry.id);
      if (this.persisted.routers[entry.id]?.state !== "installed") {
        const aborted = abort.signal.aborted;
        this.persisted.routers[entry.id] = {
          state: aborted ? "not_installed" : "failed",
          error: aborted ? "Installation cancelled." : error instanceof Error ? error.message : String(error),
        };
      }
      return this.finish(job, entry);
    }
  }

  private async runInstallLocked(
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
    const emit = (line: string) => {
      for (const listener of job.listeners) {
        try {
          listener(line);
        } catch {
          /* a caller that went away */
        }
      }
    };
    const phase = (next: RouterInstallPhase, line: string) => {
      job.phase = next;
      emit(line);
    };
    let shownShare = -1;
    try {
      if (entry.id === "tracemaker") {
        phase("resolving", `${entry.displayName}: resolving the download for this platform`);
        const resolved = await resolveTraceMakerInstallArtifact({ ...this.traceMakerResolveArgs(entry, artifact), signal: abort.signal });
        if (job.replace && resolved.origin !== "binary")
          throw new Error(`no TraceMaker binary release is reachable (${(resolved.warning ?? "source fallback").replace(/[.\s]*$/, "")}); kept the installed copy`);
        artifact = resolved.artifact;
        versionOverride = resolved.version;
        resolveWarning = resolved.warning;
        job.total = artifact.bytes ?? job.total;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true, mode: 0o700 });
      const destFile = join(work, artifact.filename);
      phase("downloading", `${entry.displayName}: downloading ${artifact.filename}${artifact.bytes ? ` (${Math.round(artifact.bytes / 1e6)} MB)` : ""}`);
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
          const share = total > 0 ? Math.floor((received / total) * 4) : -1;
          if (share > shownShare && share < 4) {
            shownShare = share;
            if (share > 0) emit(`${entry.displayName}: ${share * 25}% of ${Math.round(total / 1e6)} MB`);
          }
        },
      });
      abort.signal.throwIfAborted();
      phase("verifying", `${entry.displayName}: verifying sha256`);
      await verifyFileSha256(destFile, artifact.sha256);
      phase("extracting", `${entry.displayName}: extracting`);
      const extracted = join(work, "extracted");
      await mkdir(join(extracted, artifact.subdir ?? ""), { recursive: true });
      await this.materialize(artifact, destFile, join(extracted, artifact.subdir ?? ""));
      abort.signal.throwIfAborted();
      // Swap the finished tree in only now, keeping the previous install until the new one is recorded,
      // so a failure at any step never leaves a half-installed directory behind.
      await rm(backup, { recursive: true, force: true });
      if (existsSync(final)) await rename(final, backup);
      swapped = true;
      await rename(extracted, final);
      let setupNotice: string | undefined;
      if (entry.id === "atlc") {
        phase("setup", `${entry.displayName}: building from source`);
        await (this.deps.atlcBuild ?? buildAtlc)(join(final, ATLC_SRC), emit, abort.signal);
        abort.signal.throwIfAborted();
      }
      if (entry.id === "krt") {
        // The venv is made in place (its paths are absolute), after the swap; a failure restores the backup.
        phase("setup", `${entry.displayName}: setting up Python and the router core`);
        const setup = await (this.deps.krtSetup ?? setupKrt)(final, {
          env: this.env,
          signal: abort.signal,
          log: emit,
          routersRoot: this.root,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        });
        abort.signal.throwIfAborted();
        setupNotice = setup.notice;
      }
      const readyPath = artifact.subdir ? final : (this.findReadyPath(final, artifact) ?? final);
      const binaryReady = this.binaryReady(entry, readyPath);
      if (binaryReady) await chmod(readyPath, 0o755).catch(() => undefined);
      const notice = setupNotice ?? (!binaryReady
        ? `${(resolveWarning ?? `No runnable ${entry.displayName} binary was in the downloaded archive.`).replace(/[.\s]*$/, "")}. Only the source package was downloaded, so ${entry.displayName} is not usable until you build it or set ${this.overrideEnv(entry.id)}.`
        : undefined);
      this.persisted.routers[entry.id] = {
        state: "installed",
        version: versionOverride ?? entry.version,
        path: readyPath,
        sha256: downloaded.sha256,
        ...(notice ? { notice } : {}),
      };
      await this.writeState(entry.id);
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
      await this.writeState(entry.id);
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
    if (artifact.format === "tar.gz" || artifact.format === "tar.bz2") {
      const code = await spawn("tar", [artifact.format === "tar.gz" ? "-xzf" : "-xjf", archive, "-C", dest]);
      if (code !== 0) throw new Error(`failed to extract ${artifact.format} artifact`);
    } else {
      await extractZipArchive(archive, dest, spawn);
    }
    return this.findReadyPath(dest, artifact) ?? dest;
  }

  private async cleanPartials(id: RouterCatalogId): Promise<void> {
    for (const dir of [`.install-${id}-${process.pid}`, `.backup-${id}-${process.pid}`])
      await rm(join(this.root, dir), { recursive: true, force: true }).catch(() => undefined);
  }

  private readState(): PersistedState {
    return this.readStateFile() ?? { routers: {} };
  }

  /** state.json as it is on disk: empty when there is none, null when it could not be read (keep what is known). */
  private readStateFile(): PersistedState | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.root, STATE_FILE), "utf8")) as PersistedState;
      return raw?.routers ? raw : null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { routers: {} } : null;
    }
  }

  /** Take this engine's entry from state.json: another process may have installed or removed it. */
  private refreshState(id: RouterCatalogId): void {
    const disk = this.readStateFile();
    if (!disk) return; // unreadable right now: keep what this process knows
    const saved = disk.routers[id];
    if (saved) this.persisted.routers[id] = saved;
    else delete this.persisted.routers[id];
  }

  /**
   * Record one engine's entry. Other engines' entries come from the file, so a write never reverts what another
   * process recorded for them; the read-modify-replace runs under a short cross-process lock (`.lock-state`), and the
   * file is replaced by rename so a reader never sees half of it. A file that exists but cannot be read is never
   * written over (that would drop entries this process has not seen): the read is retried briefly, then the change
   * stays in memory and goes out with the next write.
   */
  private async writeState(id: RouterCatalogId): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await withInstallLock(
      join(this.root, ".lock-state"),
      async () => {
        const mine = this.persisted.routers[id];
        let base = this.readStateFile();
        for (let attempt = 0; !base && attempt < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          base = this.readStateFile();
        }
        if (!base) return; // unreadable: keep this change in memory rather than overwrite what others recorded
        const merged: PersistedState = { routers: { ...base.routers } };
        if (mine) merged.routers[id] = mine;
        else delete merged.routers[id];
        const file = join(this.root, STATE_FILE);
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
        await renameRetrying(tmp, file);
        this.persisted = { routers: { ...this.persisted.routers, ...merged.routers } };
      },
      { waitMs: 60_000, pollMs: 10 },
    );
  }
}

/** rename, retried briefly on Windows, where another process reading the target makes it fail with EPERM/EACCES/EBUSY. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 20 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

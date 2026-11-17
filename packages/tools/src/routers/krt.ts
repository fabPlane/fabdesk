/**
 * KiCadRoutingTools (KRT) on demand: the pinned release, the layout the board workflow expects
 * (`<root>/src/plugins`, `<root>/venv`), and the Python setup after the zip is extracted.
 *
 * The release zip is a KiCad PCM package (`plugins/`, `resources/`, `metadata.json`); the registry
 * extracts it into `<root>/src`. `plugins/rust_router` bundles one prebuilt `grid_router` per platform
 * under a suffixed name and KRT's CLIs `import grid_router` from that folder, so the matching binary is
 * copied to the canonical name (what KRT's own `__init__._resolve_rust_binary` does inside KiCad). Where the
 * release has no binary (linux-arm64, windows-arm64) it is built from the zip's `rust_router` with the
 * machine's cargo; rustup is not bootstrapped (see docs/routers.md).
 *
 * Python: only the routing packages (numpy, scipy, shapely) are installed, hash-locked from `krt-lock.json`
 * (`--require-hashes` on the uv and the pip path): the scripts the board workflow runs (route, route_diff,
 * route_planes, place_simple, check_floorplan, check_groups, net_forensics, make_unplaced) import nothing
 * else at the code paths it uses. Pillow (raster previews) and ortools (the bus step, ~100 MB) are optional
 * in KRT's own requirements and are left out. The lock's numpy needs CPython ≥ 3.12; a uv-managed 3.12 is
 * the first choice, a system Python ≥ 3.12 the second, and when neither uv nor such a Python exists a pinned
 * uv is downloaded into the fabdesk data dir (`uv.ts`) to provision one, so the machine needs nothing first.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { layout } from "@fabdesk/board-workflow";
import lock from "./krt-lock.json";
import { bootstrapUv, UV_VERSION, type UvBootstrapDeps } from "./uv";

export const KRT_VERSION = "0.23.8";
export const KRT_SHA256 = "0179da836e6d41484701a9b840e2e30e94465cd7dc1c226e0c7bf850fe78453f";
/** Measured 2026-11-12. */
export const KRT_BYTES = 16_067_806;
export const KRT_URL = `https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v${KRT_VERSION}/KiCadRoutingTools-${KRT_VERSION}.zip`;
export const KRT_HOMEPAGE = "https://github.com/drandyhaas/KiCadRoutingTools";
/**
 * The oldest CPython the hash lock installs on (numpy 2.5.4 and scipy 1.18.1 need 3.12). The Rust core itself is
 * built `abi3-py39`.
 */
export const KRT_MIN_PYTHON: readonly [number, number] = [3, 12];
/** What uv provisions (a uv-managed CPython kept inside the install). */
export const KRT_UV_PYTHON = "3.12";
/** The versions every parity run of the board workflow used (KRT 0.23.8 build, Python 3.12); hashes in krt-lock.json. */
export const KRT_PINNED_DEPS: readonly string[] = lock.packages.map((p) => `${p.name}==${p.version}`);
/** The file the lock is written to inside the install, for `-r`. */
export const KRT_LOCK_FILE = "krt-requirements.txt";

/** `krt-lock.json` as a pip / uv requirements file: each pin with every hash. */
export function krtLockText(): string {
  return (
    lock.packages
      .map((p) => {
        const marker = "marker" in p && typeof p.marker === "string" ? ` ; ${p.marker}` : "";
        return [`${p.name}==${p.version}${marker} \\`, ...p.sha256.map((h, i) => `    --hash=sha256:${h}${i < p.sha256.length - 1 ? " \\" : ""}`)].join("\n");
      })
      .join("\n") + "\n"
  );
}

export type KrtRun = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal; cwd?: string },
) => Promise<{ code: number; out: string }>;

export type KrtSetupDeps = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** PATH lookup; null when not found. */
  which?: (name: string) => string | null;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  run?: KrtRun;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /**
   * The fabdesk routers dir: where a pinned uv is downloaded when neither uv nor a Python ≥ 3.12 works. Without
   * it (and without `bootstrapUv`) there is no bootstrap.
   */
  routersRoot?: string;
  /** Download the pinned uv and return its path; injectable for tests. Default: `bootstrapUv(routersRoot)`. */
  bootstrapUv?: () => Promise<string>;
  fetch?: typeof fetch;
};

export type KrtSetupResult = {
  python: string;
  /** How the venv was made: `uv (managed 3.12)`, `uv + /usr/bin/python3`, `/usr/bin/python3 -m venv`, ... */
  via: string;
  /** The packages always come from the hash lock. */
  deps: "locked";
  gridRouter: string;
  /** How grid_router got there: the release's prebuilt binary, or built here with cargo. */
  rust: "prebuilt" | "built";
  /** Non-fatal context for the Settings card. */
  notice?: string;
};

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The bundled Rust binary for this OS/arch and the name KRT imports; null when the release has none. */
export function krtRustBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { source: string; canonical: string } | null {
  const x64 = arch === "x64" || arch === "x86_64" || arch === "amd64";
  if (platform === "linux" && x64) return { source: "grid_router-linux-x86_64.so", canonical: "grid_router.so" };
  if (platform === "darwin" && arch === "arm64") return { source: "grid_router-macos-arm64.so", canonical: "grid_router.so" };
  if (platform === "darwin" && x64) return { source: "grid_router-macos-x86_64.so", canonical: "grid_router.so" };
  if (platform === "win32" && x64) return { source: "grid_router-windows-x86_64.pyd", canonical: "grid_router.pyd" };
  return null;
}

/** Why `root` is not a runnable KRT build (scripts, venv interpreter, Rust core); null when it is. */
export function krtRootProblem(
  root: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const p = pathFor(platform);
  const k = layout.krtPaths(root, platform);
  if (!exists(p.join(k.plugins, "py_router", "route.py"))) return `no src/plugins/py_router/route.py in ${root}`;
  if (!exists(k.python[0]!)) return `no venv interpreter at ${k.python[0]}`;
  const rust = p.join(k.plugins, "rust_router");
  if (!exists(p.join(rust, "grid_router.so")) && !exists(p.join(rust, "grid_router.pyd")))
    return `no grid_router binary in ${rust}`;
  return null;
}

/** `src/plugins/VERSION` of a KRT build, when present. */
export function krtVersionAt(root: string): string | null {
  try {
    const v = readFileSync(posix.join(root, "src", "plugins", "VERSION"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

type Interpreter = { label: string; cmd: string; args: string[] };

/** Where uv lives: PATH, then the installer's usual locations. */
export function findUv(deps: KrtSetupDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? defaultWhich(env);
  const p = pathFor(platform);
  const home = deps.home ?? homedir();
  const exe = platform === "win32" ? "uv.exe" : "uv";
  const fromEnv = env["FABDESK_KRT_UV"]?.trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : null;
  const onPath = which("uv");
  if (onPath) return onPath;
  const candidates = [
    p.join(home, ".local", "bin", exe),
    p.join(home, ".cargo", "bin", exe),
    ...(platform === "darwin" ? ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"] : []),
    ...(platform === "linux" ? ["/usr/local/bin/uv"] : []),
  ];
  return candidates.find((c) => exists(c)) ?? null;
}

/**
 * System interpreters to try, most reliable first. Linux: python3 / python3.X on PATH. macOS: python.org and
 * Homebrew, then KiCad's bundled Python, then `/usr/bin/python3` only when the Command Line Tools are present
 * (otherwise it is a stub that opens an install dialog). Windows: the `py -3` launcher, python on PATH (the
 * Store alias is skipped), then KiCad's bundled `bin\python.exe`.
 */
export function pythonCandidates(deps: KrtSetupDeps = {}): Interpreter[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? defaultWhich(env);
  const listDir = deps.listDir ?? safeReaddir;
  const out: Interpreter[] = [];
  const seen = new Set<string>();
  const add = (path: string | null, args: string[] = []) => {
    if (!path || seen.has(path + args.join(" "))) return;
    seen.add(path + args.join(" "));
    out.push({ label: [path, ...args].join(" "), cmd: path, args });
  };
  if (platform === "win32") {
    add(which("py"), ["-3"]);
    for (const name of ["python", "python3"]) {
      const hit = which(name);
      if (hit && !/[\\/]WindowsApps[\\/]/i.test(hit)) add(hit);
    }
    for (const base of [env["ProgramFiles"], env["ProgramW6432"], "C:\\Program Files"]) {
      if (!base) continue;
      const kicad = win32.join(base, "KiCad");
      for (const ver of listDir(kicad).sort(compareVersionsDesc)) {
        const py = win32.join(kicad, ver, "bin", "python.exe");
        if (exists(py)) add(py);
      }
    }
    return out;
  }
  if (platform === "darwin") {
    for (const path of [
      "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
    ])
      if (exists(path)) add(path);
    const onPath = which("python3");
    if (onPath && onPath !== "/usr/bin/python3") add(onPath);
    const kicad = "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3";
    if (exists(kicad)) add(kicad);
    if (exists("/Library/Developer/CommandLineTools/usr/bin/python3") || exists("/Applications/Xcode.app"))
      add("/usr/bin/python3");
    return out;
  }
  for (const name of ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python"]) add(which(name));
  return out;
}

/** What to do when no Python could be set up, per platform (only reached when the uv bootstrap failed too). */
export function krtPythonHint(platform: NodeJS.Platform = process.platform): string {
  const python =
    platform === "win32"
      ? "Python 3.12+ from python.org (with the py launcher)"
      : platform === "darwin"
        ? "Python 3.12+ (python.org or Homebrew)"
        : "Python 3.12+ with venv (python3-venv on Debian/Ubuntu)";
  return `Check the network (fabdesk downloads uv ${UV_VERSION} and CPython ${KRT_UV_PYTHON} from GitHub), or install uv (https://docs.astral.sh/uv/) or ${python}, or set FABDESK_KRT_PYTHON, then Retry.`;
}

const tail = (s: string, n = 300) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** Where cargo lives: FABDESK_KRT_CARGO, PATH, then rustup's default `~/.cargo/bin`. */
export function findCargo(deps: KrtSetupDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? defaultWhich(env);
  const fromEnv = env["FABDESK_KRT_CARGO"]?.trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : null;
  const onPath = which("cargo");
  if (onPath) return onPath;
  const home = deps.home ?? homedir();
  const candidate = pathFor(platform).join(home, ".cargo", "bin", platform === "win32" ? "cargo.exe" : "cargo");
  return exists(candidate) ? candidate : null;
}

/**
 * `cargo build` arguments for grid_router. With the source's Cargo.lock, `--locked` pins crate resolution the way
 * krt-lock.json pins the Python side (a lock that no longer matches Cargo.toml fails instead of re-resolving). A
 * source without Cargo.lock builds unpinned as before: `--locked` would fail there, since it forbids writing one.
 */
export function cargoBuildArgs(rustDir: string, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string[] {
  const p = pathFor(platform);
  return ["build", "--release", ...(exists(p.join(rustDir, "Cargo.lock")) ? ["--locked"] : []), "--manifest-path", p.join(rustDir, "Cargo.toml")];
}

/** What `cargo build --release` names the cdylib, per OS. */
export function cargoArtifactName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "grid_router.dll" : platform === "darwin" ? "libgrid_router.dylib" : "libgrid_router.so";
}

/** Why grid_router cannot be had on this machine without a Rust toolchain. Kept to one actionable sentence. */
export function krtNoRustMessage(platform: NodeJS.Platform, arch: string): string {
  const linker = platform === "win32" ? "the Visual Studio C++ Build Tools" : "a C compiler (cc)";
  return `KiCadRoutingTools ${KRT_VERSION} ships no grid_router for ${platform}-${arch}; building it needs Rust (cargo, https://rustup.rs) and ${linker}. Install them and Retry, or set FABDESK_KRT_DIR to a build.`;
}

/**
 * Make `<root>` runnable after the zip is extracted into `<root>/src`: canonical `grid_router` (copied, or built with
 * cargo where the release has none), a venv at `<root>/venv` with the hash-locked numpy, scipy and shapely, and an
 * import check. Throws with the reason (and what to do) when it cannot.
 */
export async function setupKrt(root: string, deps: KrtSetupDeps = {}): Promise<KrtSetupResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? (() => undefined);
  const p = pathFor(platform);
  const k = layout.krtPaths(root, platform);
  if (!exists(p.join(k.plugins, "py_router", "route.py")))
    throw new Error(`KiCadRoutingTools archive has no plugins/py_router/route.py (unexpected layout)`);

  // 1. The Rust core under the name KRT imports, or the toolchain to build it (checked before any Python download).
  const rust = krtRustBinary(platform, arch);
  const rustDir = p.join(k.plugins, "rust_router");
  const canonical = platform === "win32" ? "grid_router.pyd" : "grid_router.so";
  const gridRouter = p.join(rustDir, rust?.canonical ?? canonical);
  let cargo: string | null = null;
  if (rust) {
    if (!exists(gridRouter)) {
      const source = p.join(rustDir, rust.source);
      if (!exists(source)) throw new Error(`KiCadRoutingTools archive is missing rust_router/${rust.source}`);
      copyFileSync(source, gridRouter);
    }
  } else if (!exists(gridRouter)) {
    if (!exists(p.join(rustDir, "Cargo.toml"))) throw new Error(`KiCadRoutingTools archive has no rust_router/Cargo.toml to build grid_router from`);
    cargo = findCargo(deps);
    if (!cargo) throw new Error(krtNoRustMessage(platform, arch));
  }

  // 2. A venv with the hash-locked packages. Child processes get no PYTHONHOME/PYTHONPATH from the daemon's environment.
  const childEnv: Record<string, string | undefined> = { PYTHONHOME: undefined, PYTHONPATH: undefined, PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  const venv = p.join(root, "venv");
  const python = k.python[0]!;
  const lockFile = p.join(root, KRT_LOCK_FILE);
  writeFileSync(lockFile, krtLockText());
  const sig = deps.signal ? { signal: deps.signal } : {};
  const tried: string[] = [];
  const freshVenv = () => rm(venv, { recursive: true, force: true });
  // uv's own cache is not used: everything it fetches lands in the install (the managed Python in <root>/python).
  const uvEnv = { ...childEnv, UV_PYTHON_INSTALL_DIR: p.join(root, "python"), UV_NO_CONFIG: "1", UV_NO_CACHE: "1", UV_LINK_MODE: "copy" };
  const installTimeout = { timeoutMs: 20 * 60_000, ...sig };
  const pipInstall = () =>
    run(python, ["-E", "-s", "-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", lockFile], { env: childEnv, ...installTimeout });
  const uvInstall = (uv: string) =>
    run(uv, ["pip", "install", "--python", python, "--require-hashes", "--only-binary", ":all:", "--no-deps", "-r", lockFile], { env: uvEnv, ...installTimeout });

  /** Install the lock into the venv just made; true when it took. */
  const installLock = async (label: string, install: () => Promise<{ code: number; out: string }>): Promise<boolean> => {
    log(`KRT: installing ${KRT_PINNED_DEPS.join(" ")} (hash-locked) via ${label}`);
    // uv and pip print nothing useful until they finish; a heartbeat keeps a slow download from looking hung
    const t0 = Date.now();
    const beat = setInterval(() => log(`KRT: still installing the Python packages (${Math.round((Date.now() - t0) / 1000)} s; ~60 MB of wheels)`), 60_000);
    const r = await install().finally(() => clearInterval(beat));
    if (r.code === 0) return true;
    tried.push(`${label}: the hash lock did not install (${tail(r.out, 160) || `exit ${r.code}`})`);
    await freshVenv();
    return false;
  };

  const uvManaged = async (uv: string, label: string): Promise<string | null> => {
    deps.signal?.throwIfAborted();
    await freshVenv();
    log(`KRT: ${label}: venv on a managed CPython ${KRT_UV_PYTHON} (downloads it once)`);
    const r = await run(uv, ["venv", "--python", KRT_UV_PYTHON, "--python-preference", "only-managed", venv], { env: uvEnv, timeoutMs: 10 * 60_000, ...sig });
    if (r.code !== 0 || !exists(python)) {
      tried.push(`${label} managed ${KRT_UV_PYTHON}: ${tail(r.out, 120) || `exit ${r.code}`}`);
      await freshVenv();
      return null;
    }
    const via = `${label} (managed Python ${KRT_UV_PYTHON})`;
    return (await installLock(via, () => uvInstall(uv))) ? via : null;
  };

  const tryInterpreter = async (it: Interpreter, uv: string | null): Promise<string | null> => {
    deps.signal?.throwIfAborted();
    const probeCode = "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)";
    const probe = await run(it.cmd, [...it.args, "-E", "-s", "-c", probeCode], { env: childEnv, timeoutMs: 20_000, ...sig }).catch(
      (e: Error) => ({ code: -1, out: e.message }),
    );
    const m = /^(\d+)\.(\d+)\s*$/m.exec(probe.out);
    if (probe.code !== 0 || !m) {
      tried.push(`${it.label}: ${tail(probe.out, 80) || `exit ${probe.code}`}`);
      return null;
    }
    const ver: [number, number] = [Number(m[1]), Number(m[2])];
    if (ver[0] < KRT_MIN_PYTHON[0] || (ver[0] === KRT_MIN_PYTHON[0] && ver[1] < KRT_MIN_PYTHON[1])) {
      tried.push(`${it.label}: Python ${ver.join(".")} < ${KRT_MIN_PYTHON.join(".")} (the lock's numpy needs it)`);
      return null;
    }
    log(`KRT: trying ${it.label} (Python ${ver.join(".")})`);
    const executable = probe.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? it.cmd;
    await freshVenv();
    if (uv) {
      // uv makes the venv without ensurepip (absent on Debian without python3-venv) and installs faster.
      const r = await run(uv, ["venv", "--python", executable, "--python-preference", "only-system", venv], { env: uvEnv, timeoutMs: 120_000, ...sig });
      if (r.code === 0 && exists(python)) return (await installLock(`uv + ${it.label}`, () => uvInstall(uv))) ? `uv + ${it.label}` : null;
      tried.push(`uv + ${it.label}: ${tail(r.out, 120) || `exit ${r.code}`}`);
      await freshVenv();
    }
    const r = await run(it.cmd, [...it.args, "-E", "-s", "-m", "venv", venv], { env: childEnv, timeoutMs: 120_000, ...sig });
    if (r.code === 0 && exists(python)) return (await installLock(`${it.label} -m venv`, pipInstall)) ? `${it.label} -m venv` : null;
    tried.push(`${it.label} -m venv: ${tail(r.out, 120) || `exit ${r.code}`}`);
    await freshVenv();
    return null;
  };

  let via: string | null = null;
  const explicit = env["FABDESK_KRT_PYTHON"]?.trim();
  if (explicit) {
    via = await tryInterpreter({ label: explicit, cmd: explicit, args: [] }, findUv(deps));
    if (!via) throw new Error(`FABDESK_KRT_PYTHON could not make the KiCadRoutingTools venv (${tried.join("; ")})`);
  } else {
    // uv found on this machine (managed 3.12, the parity runs' Python), then a system Python ≥ 3.12, then a pinned uv
    // downloaded into the fabdesk data dir: the last step needs nothing installed first.
    const uv = findUv(deps);
    if (uv) via = await uvManaged(uv, "uv");
    for (const it of via ? [] : pythonCandidates(deps)) {
      via = await tryInterpreter(it, uv);
      if (via) break;
    }
    const bootstrap = deps.bootstrapUv ?? (deps.routersRoot ? () => bootstrapUv(deps.routersRoot!, uvBootstrapDeps(deps)) : null);
    if (!via && bootstrap) {
      deps.signal?.throwIfAborted();
      log(`KRT: no uv and no Python ≥ ${KRT_MIN_PYTHON.join(".")} here; fetching uv ${UV_VERSION}`);
      const fetched = await bootstrap().catch((e: Error) => {
        tried.push(`uv ${UV_VERSION} download: ${tail(e.message, 160)}`);
        return null;
      });
      if (fetched) via = await uvManaged(fetched, `uv ${UV_VERSION} (fetched)`);
    }
  }
  if (!via) {
    await freshVenv();
    throw new Error(
      `No Python ≥ ${KRT_MIN_PYTHON.join(".")} could take the KiCadRoutingTools lock${tried.length ? ` (tried: ${tried.join("; ")})` : " (none found)"}. ${krtPythonHint(platform)}`,
    );
  }

  // 3. grid_router from source where the release has no binary (pyo3 abi3: the venv's Python only steers the build).
  if (cargo) {
    deps.signal?.throwIfAborted();
    const target = p.join(root, "build", "cargo-target");
    log(`KRT: building grid_router for ${platform}-${arch} with ${cargo} (a few minutes)`);
    const b = await run(cargo, cargoBuildArgs(rustDir, platform, exists), {
      env: { ...childEnv, CARGO_TARGET_DIR: target, PYO3_PYTHON: python, CARGO_TERM_COLOR: "never" },
      timeoutMs: 45 * 60_000,
      cwd: rustDir,
      ...sig,
    });
    const built = p.join(target, "release", cargoArtifactName(platform));
    if (b.code !== 0 || !exists(built)) throw new Error(`building grid_router with cargo failed: ${tail(b.out)}`);
    copyFileSync(built, gridRouter);
    await rm(target, { recursive: true, force: true });
  }

  // 4. Import check: the interpreter, the packages and the Rust core load together.
  const check = await run(
    python,
    ["-E", "-s", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import numpy, scipy, shapely, grid_router; print('ok', getattr(grid_router, '__version__', '?'), numpy.__version__)", rustDir],
    { env: childEnv, timeoutMs: 60_000, ...sig },
  );
  if (check.code !== 0 || !/\bok\b/.test(check.out)) throw new Error(`KiCadRoutingTools import check failed: ${tail(check.out)}`);
  log(`KRT: ready (${via}; ${tail(check.out, 60)})`);
  return {
    python,
    via,
    deps: "locked",
    gridRouter,
    rust: cargo ? "built" : "prebuilt",
    ...(cargo ? { notice: `grid_router was built here from the ${KRT_VERSION} source with ${cargo} (the release has no ${platform}-${arch} binary).` } : {}),
  };
}

function uvBootstrapDeps(deps: KrtSetupDeps): UvBootstrapDeps {
  return {
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.arch ? { arch: deps.arch } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
}

function compareVersionsDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function defaultWhich(env: NodeJS.ProcessEnv): (name: string) => string | null {
  return (name) => Bun.which(name, { PATH: env["PATH"] ?? env["Path"] ?? "" });
}

/** Run a command, capturing combined output (tail-limited), with a timeout and abort. */
const defaultRun: KrtRun = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) if (value !== undefined) env[key] = value;
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    let out = "";
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-64_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    const abort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) return reject(new Error("Installation cancelled."));
      resolve({ code: code ?? 1, out });
    });
  });

/**
 * KiCadRoutingTools (KRT) on demand: the pinned release, the layout the board workflow expects
 * (`<root>/src/plugins`, `<root>/venv`), and the Python setup after the zip is extracted.
 *
 * The release zip is a KiCad PCM package (`plugins/`, `resources/`, `metadata.json`); the registry
 * extracts it into `<root>/src`. `plugins/rust_router` bundles one prebuilt `grid_router` per platform
 * under a suffixed name and KRT's CLIs `import grid_router` from that folder, so the matching binary is
 * copied to the canonical name (what KRT's own `__init__._resolve_rust_binary` does inside KiCad).
 *
 * Python: KRT's Rust core is built `abi3-py39`, so any CPython ≥ 3.9 runs it. Only the routing packages
 * (numpy, scipy, shapely) are installed: the scripts the board workflow runs (route, route_diff,
 * route_planes, place_simple, check_floorplan, check_groups, net_forensics, make_unplaced) import nothing
 * else at the code paths it uses. Pillow (raster previews) and ortools (the bus step, ~100 MB) are optional
 * in KRT's own requirements and are left out.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { layout } from "@fabdesk/board-workflow";

export const KRT_VERSION = "0.23.8";
export const KRT_SHA256 = "0179da836e6d41484701a9b840e2e30e94465cd7dc1c226e0c7bf850fe78453f";
/** Measured 2026-11-12. */
export const KRT_BYTES = 16_067_806;
export const KRT_URL = `https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v${KRT_VERSION}/KiCadRoutingTools-${KRT_VERSION}.zip`;
export const KRT_HOMEPAGE = "https://github.com/drandyhaas/KiCadRoutingTools";
/** `rust_router/Cargo.toml` pins pyo3 `abi3-py39`. */
export const KRT_MIN_PYTHON: readonly [number, number] = [3, 9];
/** What uv provisions when it is available (a uv-managed CPython kept inside the install). */
export const KRT_UV_PYTHON = "3.12";
/** The versions every parity run of the board workflow used (KRT 0.23.8 build, Python 3.12). */
export const KRT_PINNED_DEPS = ["numpy==2.5.4", "scipy==1.18.1", "shapely==2.2.0"] as const;
/** KRT's own floors (`requirements.txt`), used when this Python has no wheels for the pins. */
export const KRT_FLOOR_DEPS = ["numpy>=1.22.0", "scipy>=1.7.0", "shapely>=2.0"] as const;

export type KrtRun = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal },
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
};

export type KrtSetupResult = {
  python: string;
  /** How the venv was made: `uv (managed 3.12)`, `uv + /usr/bin/python3`, `/usr/bin/python3 -m venv`, ... */
  via: string;
  deps: "pinned" | "floors";
  gridRouter: string;
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

/** What to install when no Python works, per platform. */
export function krtPythonHint(platform: NodeJS.Platform = process.platform): string {
  const python =
    platform === "win32"
      ? "Python 3.9+ from python.org (with the py launcher)"
      : platform === "darwin"
        ? "Python 3.9+ (python.org or Homebrew)"
        : "Python 3.9+ with venv (python3-venv on Debian/Ubuntu)";
  return `Install uv (https://docs.astral.sh/uv/) or ${python}, or set FABDESK_KRT_PYTHON to an interpreter, then Retry.`;
}

const tail = (s: string, n = 300) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/**
 * Make `<root>` runnable after the zip is extracted into `<root>/src`: canonical `grid_router`, a venv at
 * `<root>/venv` with numpy, scipy and shapely, and an import check. Throws with the reason (and what to
 * install) when it cannot.
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

  // 1. The Rust core under the name KRT imports.
  const rust = krtRustBinary(platform, arch);
  if (!rust) throw new Error(`KiCadRoutingTools ${KRT_VERSION} ships no router binary for ${platform}-${arch}`);
  const rustDir = p.join(k.plugins, "rust_router");
  const gridRouter = p.join(rustDir, rust.canonical);
  if (!exists(gridRouter)) {
    const source = p.join(rustDir, rust.source);
    if (!exists(source)) throw new Error(`KiCadRoutingTools archive is missing rust_router/${rust.source}`);
    copyFileSync(source, gridRouter);
  }

  // 2. A venv. Child processes get no PYTHONHOME/PYTHONPATH from the daemon's environment.
  const childEnv: Record<string, string | undefined> = { PYTHONHOME: undefined, PYTHONPATH: undefined, PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  const venv = p.join(root, "venv");
  const python = k.python[0]!;
  const sig = deps.signal ? { signal: deps.signal } : {};
  const tried: string[] = [];
  const freshVenv = () => rm(venv, { recursive: true, force: true });
  const uv = findUv(deps);
  const uvEnv = { ...childEnv, UV_PYTHON_INSTALL_DIR: p.join(root, "python"), UV_NO_CONFIG: "1" };
  type Made = { via: string; install: (pkgs: readonly string[]) => Promise<{ code: number; out: string }> };

  const explicit = env["FABDESK_KRT_PYTHON"]?.trim();
  const viaPip = (label: string): Made => ({
    via: `${label} -m venv`,
    install: (pkgs) =>
      run(python, ["-E", "-s", "-m", "pip", "install", "--only-binary=:all:", ...pkgs], { env: childEnv, timeoutMs: 15 * 60_000, ...sig }),
  });
  const viaUv = (uvPath: string, label: string): Made => ({
    via: label,
    install: (pkgs) =>
      run(uvPath, ["pip", "install", "--python", python, "--only-binary", ":all:", ...pkgs], { env: uvEnv, timeoutMs: 15 * 60_000, ...sig }),
  });
  const tryInterpreter = async (it: Interpreter): Promise<Made | null> => {
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
      tried.push(`${it.label}: Python ${ver.join(".")} < ${KRT_MIN_PYTHON.join(".")}`);
      return null;
    }
    const executable = probe.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? it.cmd;
    await freshVenv();
    if (uv) {
      // uv makes the venv without ensurepip (absent on Debian without python3-venv) and installs faster.
      const r = await run(uv, ["venv", "--python", executable, "--python-preference", "only-system", venv], { env: uvEnv, timeoutMs: 120_000, ...sig });
      if (r.code === 0 && exists(python)) return viaUv(uv, `uv + ${it.label}`);
      tried.push(`uv + ${it.label}: ${tail(r.out, 120) || `exit ${r.code}`}`);
      await freshVenv();
    }
    const r = await run(it.cmd, [...it.args, "-E", "-s", "-m", "venv", venv], { env: childEnv, timeoutMs: 120_000, ...sig });
    if (r.code === 0 && exists(python)) return viaPip(it.label);
    tried.push(`${it.label} -m venv: ${tail(r.out, 120) || `exit ${r.code}`}`);
    return null;
  };

  let chosen: Made | null = null;
  if (explicit) {
    chosen = await tryInterpreter({ label: explicit, cmd: explicit, args: [] });
    if (!chosen) throw new Error(`FABDESK_KRT_PYTHON could not make the KiCadRoutingTools venv (${tried.join("; ")})`);
  } else {
    if (uv) {
      // A uv-managed CPython inside the install: same Python as the parity runs, removed by Uninstall,
      // untouched by OS Python upgrades.
      await freshVenv();
      log(`KRT: uv venv (managed Python ${KRT_UV_PYTHON})`);
      const r = await run(uv, ["venv", "--python", KRT_UV_PYTHON, "--python-preference", "only-managed", venv], { env: uvEnv, timeoutMs: 10 * 60_000, ...sig });
      if (r.code === 0 && exists(python)) chosen = viaUv(uv, `uv (managed Python ${KRT_UV_PYTHON})`);
      else tried.push(`uv managed ${KRT_UV_PYTHON}: ${tail(r.out, 120) || `exit ${r.code}`}`);
    }
    for (const it of chosen ? [] : pythonCandidates(deps)) {
      deps.signal?.throwIfAborted();
      log(`KRT: trying ${it.label}`);
      chosen = await tryInterpreter(it);
      if (chosen) break;
    }
  }
  if (!chosen) {
    await freshVenv();
    throw new Error(
      `No Python ≥ ${KRT_MIN_PYTHON.join(".")} could make the KiCadRoutingTools venv${tried.length ? ` (tried: ${tried.join("; ")})` : " (none found)"}. ${krtPythonHint(platform)}`,
    );
  }

  // 3. The routing packages: the pinned set first, KRT's floors when this Python has no wheels for the pins.
  log(`KRT: installing ${KRT_PINNED_DEPS.join(" ")} via ${chosen.via}`);
  let depsKind: KrtSetupResult["deps"] = "pinned";
  let r = await chosen.install(KRT_PINNED_DEPS);
  if (r.code !== 0) {
    deps.signal?.throwIfAborted();
    log(`KRT: pinned set failed (${tail(r.out, 200)}); trying ${KRT_FLOOR_DEPS.join(" ")}`);
    depsKind = "floors";
    r = await chosen.install(KRT_FLOOR_DEPS);
  }
  if (r.code !== 0) throw new Error(`installing numpy, scipy, shapely failed (${chosen.via}): ${tail(r.out)}`);

  // 4. Import check: the interpreter, the packages and the Rust core load together.
  const check = await run(
    python,
    ["-E", "-s", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import numpy, scipy, shapely, grid_router; print('ok', getattr(grid_router, '__version__', '?'))", rustDir],
    { env: childEnv, timeoutMs: 60_000, ...sig },
  );
  if (check.code !== 0 || !/\bok\b/.test(check.out)) throw new Error(`KiCadRoutingTools import check failed: ${tail(check.out)}`);
  log(`KRT: ready (${chosen.via}; ${tail(check.out, 60)})`);
  return {
    python,
    via: chosen.via,
    deps: depsKind,
    gridRouter,
    ...(depsKind === "floors"
      ? { notice: `This Python has no wheels for ${KRT_PINNED_DEPS.join(", ")}; installed KRT's floors (${KRT_FLOOR_DEPS.join(", ")}) instead, so results may differ slightly from the reference runs.` }
      : {}),
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
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

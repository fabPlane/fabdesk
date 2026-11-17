import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { layout } from "@fabdesk/board-workflow";
import { defaultRouterCatalog, type RouterCatalogEntry } from "../src/routers/catalog";
import lock from "../src/routers/krt-lock.json";
import {
  KRT_LOCK_FILE,
  KRT_PINNED_DEPS,
  KRT_SHA256,
  KRT_URL,
  KRT_VERSION,
  cargoBuildArgs,
  findCargo,
  findUv,
  krtLockText,
  krtRootProblem,
  krtRustBinary,
  pythonCandidates,
  setupKrt,
  type KrtRun,
  type KrtSetupDeps,
} from "../src/routers/krt";
import { installHintFor } from "../src/routers/hints";
import { createRouterRegistry } from "../src/routers/registry";
import { krtDir } from "../src/tools/board-host";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const touch = (path: string, body = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

/** What the release zip extracts to (`plugins/...`, `metadata.json`), minus the 470 other files. */
function fakeRelease(dest: string): void {
  touch(join(dest, "metadata.json"), "{}");
  touch(join(dest, "plugins", "VERSION"), `${KRT_VERSION}\n`);
  touch(join(dest, "plugins", "py_router", "route.py"), "# route\n");
  touch(join(dest, "plugins", "rust_router", "Cargo.toml"), "[package]\nname = \"grid_router\"\n");
  for (const name of ["linux-x86_64.so", "macos-arm64.so", "macos-x86_64.so", "windows-x86_64.pyd"])
    touch(join(dest, "plugins", "rust_router", `grid_router-${name}`), name);
}

/** A built KRT root as the board workflow expects it. */
function fakeRoot(root: string): string {
  fakeRelease(join(root, "src"));
  touch(join(root, "src", "plugins", "rust_router", "grid_router.so"));
  touch(layout.krtPaths(root).python[0]!);
  return root;
}

describe("krtPaths", () => {
  test("POSIX uses venv/bin/python; Windows uses venv\\Scripts\\python.exe", () => {
    expect(layout.krtPaths("/opt/krt", "linux")).toEqual({ root: "/opt/krt", plugins: "/opt/krt/src/plugins", python: ["/opt/krt/venv/bin/python", "-E", "-s"] });
    expect(layout.krtPaths("/opt/krt", "darwin").python[0]).toBe("/opt/krt/venv/bin/python");
    expect(layout.krtPaths("C:\\fab\\routers\\krt", "win32")).toEqual({
      root: "C:\\fab\\routers\\krt",
      plugins: "C:\\fab\\routers\\krt\\src\\plugins",
      python: ["C:\\fab\\routers\\krt\\venv\\Scripts\\python.exe", "-E", "-s"],
    });
  });
});

describe("krtDir resolution", () => {
  test("Settings krtDir, then FABDESK_KRT_DIR, then the installed copy", () => {
    const env = { FABDESK_KRT_DIR: "/env/krt" };
    expect(krtDir(env, "/settings/krt", "/installed/krt")).toBe("/settings/krt");
    expect(krtDir(env, null, "/installed/krt")).toBe("/env/krt");
    expect(krtDir(env, "  ", "/installed/krt")).toBe("/env/krt");
    expect(krtDir({}, null, "/installed/krt")).toBe("/installed/krt");
    expect(krtDir({ FABDESK_KRT_DIR: "" }, undefined, null)).toBeNull();
  });
});

describe("catalog and hints", () => {
  test("KRT is an engine pinned to the 0.23.8 release and its sha256", () => {
    const krt = defaultRouterCatalog({}).find((row) => row.id === "krt")!;
    expect(krt).toMatchObject({ kind: "engine", install: "download", version: "0.23.8", license: "MIT" });
    expect(krt.artifact).toMatchObject({ url: KRT_URL, sha256: KRT_SHA256, format: "zip", subdir: "src" });
    expect(KRT_URL).toBe("https://github.com/drandyhaas/KiCadRoutingTools/releases/download/v0.23.8/KiCadRoutingTools-0.23.8.zip");
    expect(KRT_SHA256).toBe("0179da836e6d41484701a9b840e2e30e94465cd7dc1c226e0c7bf850fe78453f");
    expect(installHintFor("krt")).toMatch(/Settings → Routers → KiCadRoutingTools.*FABDESK_KRT_DIR/);
  });

  test("the bundled Rust core is picked per OS/arch", () => {
    expect(krtRustBinary("linux", "x64")).toEqual({ source: "grid_router-linux-x86_64.so", canonical: "grid_router.so" });
    expect(krtRustBinary("darwin", "arm64")?.source).toBe("grid_router-macos-arm64.so");
    expect(krtRustBinary("darwin", "x64")?.source).toBe("grid_router-macos-x86_64.so");
    expect(krtRustBinary("win32", "x64")).toEqual({ source: "grid_router-windows-x86_64.pyd", canonical: "grid_router.pyd" });
    expect(krtRustBinary("linux", "arm64")).toBeNull();
    expect(krtRustBinary("win32", "arm64")).toBeNull();
  });

  test("krtRootProblem names the missing piece", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-krt-root-"));
    expect(krtRootProblem(root)).toMatch(/route\.py/);
    fakeRelease(join(root, "src"));
    expect(krtRootProblem(root)).toMatch(/venv interpreter/);
    touch(layout.krtPaths(root).python[0]!);
    expect(krtRootProblem(root)).toMatch(/grid_router/);
    touch(join(root, "src", "plugins", "rust_router", "grid_router.so"));
    expect(krtRootProblem(root)).toBeNull();
  });
});

describe("python discovery", () => {
  test("Windows: py launcher, PATH python without the Store alias, then KiCad's bundled python", () => {
    const files = new Set(["D:\\Apps\\KiCad\\9.0\\bin\\python.exe", "D:\\Apps\\KiCad\\10.0\\bin\\python.exe"]);
    const list = pythonCandidates({
      platform: "win32",
      env: { ProgramFiles: "D:\\Apps" },
      which: (name) => ({ py: "C:\\Windows\\py.exe", python: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe" })[name] ?? null,
      exists: (p) => files.has(p),
      listDir: (p) => (p === "D:\\Apps\\KiCad" ? ["9.0", "10.0"] : []),
    });
    expect(list.map((c) => c.label)).toEqual(["C:\\Windows\\py.exe -3", "D:\\Apps\\KiCad\\10.0\\bin\\python.exe", "D:\\Apps\\KiCad\\9.0\\bin\\python.exe"]);
  });

  test("macOS: /usr/bin/python3 only with the Command Line Tools; KiCad's Python is a fallback", () => {
    const kicad = "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3";
    const noClt = pythonCandidates({ platform: "darwin", env: {}, which: () => "/usr/bin/python3", exists: (p) => p === "/opt/homebrew/bin/python3" || p === kicad });
    expect(noClt.map((c) => c.cmd)).toEqual(["/opt/homebrew/bin/python3", kicad]);
    const clt = pythonCandidates({ platform: "darwin", env: {}, which: () => null, exists: (p) => p === "/Library/Developer/CommandLineTools/usr/bin/python3" });
    expect(clt.map((c) => c.cmd)).toEqual(["/usr/bin/python3"]);
  });

  test("uv: FABDESK_KRT_UV, PATH, then ~/.local/bin", () => {
    expect(findUv({ platform: "linux", env: {}, home: "/h", which: () => "/usr/bin/uv", exists: () => false })).toBe("/usr/bin/uv");
    expect(findUv({ platform: "linux", env: {}, home: "/h", which: () => null, exists: (p) => p === "/h/.local/bin/uv" })).toBe("/h/.local/bin/uv");
    expect(findUv({ platform: "linux", env: { FABDESK_KRT_UV: "/x/uv" }, home: "/h", which: () => "/usr/bin/uv", exists: () => false })).toBeNull();
    expect(findUv({ platform: "win32", env: {}, home: "C:\\Users\\u", which: () => null, exists: (p) => p === "C:\\Users\\u\\.local\\bin\\uv.exe" })).toBe("C:\\Users\\u\\.local\\bin\\uv.exe");
  });
});

type Call = { cmd: string; args: string[] };

/** A fake process runner: `venv` creates the interpreter file; the rest is scripted per command. */
function fakeRun(root: string, script: (call: Call) => { code: number; out: string } | undefined): { run: KrtRun; calls: Call[] } {
  const calls: Call[] = [];
  const run: KrtRun = async (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    const scripted = script(call);
    if (scripted) return scripted;
    if (args.includes("venv")) {
      touch(layout.krtPaths(root).python[0]!);
      return { code: 0, out: "" };
    }
    if (args.some((a) => a.includes("sys.version_info[:2]"))) return { code: 0, out: `3.12\n${cmd}\n` };
    if (args.some((a) => a.includes("import numpy, scipy, shapely, grid_router"))) return { code: 0, out: "ok 0.23.8\n" };
    return { code: 0, out: "" };
  };
  return { run, calls };
}

async function extractedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-krt-setup-"));
  fakeRelease(join(root, "src"));
  return root;
}

const base = (over: Partial<KrtSetupDeps>): KrtSetupDeps => ({ platform: "linux", arch: "x64", env: {}, home: "/nohome", which: () => null, ...over });

const LOCK_ARGS = ["--require-hashes", "--only-binary", ":all:", "--no-deps", "-r"];

describe("the hash lock", () => {
  test("every pin carries the hashes of all its wheels; the lock text is a valid requirements file", () => {
    expect(KRT_PINNED_DEPS).toEqual(["numpy==2.5.4", "scipy==1.18.1", "shapely==2.2.0"]);
    expect(lock.requiresPython).toBe(">=3.12");
    for (const p of lock.packages) {
      expect(p.sha256.length).toBeGreaterThan(40); // one per platform wheel, plus the sdist
      for (const h of p.sha256) expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(p.sha256).size).toBe(p.sha256.length);
    }
    const text = krtLockText();
    expect(text).toContain("numpy==2.5.4 \\\n    --hash=sha256:");
    expect(text.match(/--hash=sha256:/g)?.length).toBe(lock.packages.reduce((n, p) => n + p.sha256.length, 0));
    // continuation lines: every line but each block's last ends in a backslash
    for (const block of text.trim().split(/\n(?=\S)/)) {
      const lines = block.split("\n");
      expect(lines.slice(0, -1).every((l) => l.endsWith(" \\"))).toBe(true);
      expect(lines.at(-1)!.endsWith("\\")).toBe(false);
    }
  });
});

describe("setupKrt", () => {
  test("uv: a managed Python 3.12 inside the install, the lock installed with --require-hashes, grid_router copied", async () => {
    const root = await extractedRoot();
    const { run, calls } = fakeRun(root, () => undefined);
    const r = await setupKrt(root, base({ which: (n) => (n === "uv" ? "/bin/uv" : null), run }));
    expect(r).toMatchObject({ via: "uv (managed Python 3.12)", deps: "locked", rust: "prebuilt" });
    expect(r.notice).toBeUndefined();
    expect(calls[0]).toEqual({ cmd: "/bin/uv", args: ["venv", "--python", "3.12", "--python-preference", "only-managed", join(root, "venv")] });
    expect(calls[1]!.args).toEqual(["pip", "install", "--python", join(root, "venv", "bin", "python"), ...LOCK_ARGS, join(root, KRT_LOCK_FILE)]);
    expect(await readFile(join(root, KRT_LOCK_FILE), "utf8")).toBe(krtLockText());
    expect(await readFile(join(root, "src", "plugins", "rust_router", "grid_router.so"), "utf8")).toBe("linux-x86_64.so");
    expect(krtRootProblem(root)).toBeNull();
  });

  test("no uv: the first system Python ≥ 3.12 that makes a venv, pip with --require-hashes; older ones are skipped", async () => {
    const root = await extractedRoot();
    const { run, calls } = fakeRun(root, ({ cmd, args }) => {
      if (cmd === "/usr/bin/python3" && args.some((a) => a.includes("sys.version_info[:2]"))) return { code: 0, out: "3.11\n/usr/bin/python3\n" };
      return undefined;
    });
    const r = await setupKrt(root, base({ which: (n) => ({ python3: "/usr/bin/python3", "python3.12": "/usr/bin/python3.12" })[n] ?? null, run }));
    expect(r).toMatchObject({ via: "/usr/bin/python3.12 -m venv", deps: "locked" });
    const pip = calls.filter((c) => c.args.includes("pip"));
    expect(pip).toHaveLength(1);
    expect(pip[0]!.cmd).toBe(join(root, "venv", "bin", "python"));
    expect(pip[0]!.args).toEqual(["-E", "-s", "-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", join(root, KRT_LOCK_FILE)]);
  });

  test("a bare machine (no uv, no Python ≥ 3.12): a pinned uv is fetched and provisions CPython", async () => {
    const root = await extractedRoot();
    const { run, calls } = fakeRun(root, ({ cmd, args }) => {
      if (cmd === "/usr/bin/python3" && args.some((a) => a.includes("sys.version_info[:2]"))) return { code: 0, out: "3.10\n/usr/bin/python3\n" };
      return undefined;
    });
    let fetched = 0;
    const lines: string[] = [];
    const r = await setupKrt(root, base({ which: (n) => (n === "python3" ? "/usr/bin/python3" : null), run, log: (l) => lines.push(l), bootstrapUv: async () => (fetched++, "/data/routers/uv/0.13.6/uv") }));
    expect(fetched).toBe(1);
    expect(r.via).toBe("uv 0.13.6 (fetched) (managed Python 3.12)");
    expect(calls.filter((c) => c.cmd === "/data/routers/uv/0.13.6/uv").map((c) => c.args[0])).toEqual(["venv", "pip"]);
    expect(lines.some((l) => /fetching uv 0\.13\.6/.test(l))).toBe(true);
  });

  test("a system Python that cannot take the lock is left for the next; the bootstrap is the last resort", async () => {
    const root = await extractedRoot();
    const { run } = fakeRun(root, ({ cmd, args }) => (cmd.endsWith("venv/bin/python") && args.includes("pip") ? { code: 1, out: "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES" } : undefined));
    const r = await setupKrt(root, base({ which: (n) => (n === "python3" ? "/usr/bin/python3" : null), run, bootstrapUv: async () => "/u/uv" }));
    expect(r.via).toBe("uv 0.13.6 (fetched) (managed Python 3.12)");
  });

  test("nothing works (bootstrap offline too): an error naming what was tried and what to do", async () => {
    const root = await extractedRoot();
    const { run } = fakeRun(root, ({ args }) => (args.includes("venv") ? { code: 1, out: "ensurepip is not available" } : undefined));
    const err = await setupKrt(root, base({ which: (n) => (n === "python3" ? "/usr/bin/python3" : null), run, bootstrapUv: async () => { throw new Error("offline: cannot download https://github.com/astral-sh/uv"); } })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No Python ≥ 3\.12 could take the KiCadRoutingTools lock.*ensurepip.*uv 0\.13\.6 download: offline.*Check the network.*python3-venv.*FABDESK_KRT_PYTHON/);
    expect(existsSync(join(root, "venv"))).toBe(false);
  });

  test("FABDESK_KRT_PYTHON is used alone (too old is an error); a release with no binary and no cargo fails first", async () => {
    const root = await extractedRoot();
    const { run, calls } = fakeRun(root, () => undefined);
    const r = await setupKrt(root, base({ env: { FABDESK_KRT_PYTHON: "/opt/py/bin/python3" }, which: (n) => (n === "python3" ? "/usr/bin/python3" : null), run, bootstrapUv: async () => "/never" }));
    expect(r.via).toBe("/opt/py/bin/python3 -m venv");
    expect(new Set(calls.filter((c) => !c.cmd.includes("venv")).map((c) => c.cmd))).toEqual(new Set(["/opt/py/bin/python3"]));
    const old = fakeRun(root, ({ args }) => (args.some((a) => a.includes("sys.version_info[:2]")) ? { code: 0, out: "3.9\n/opt/py\n" } : undefined));
    await expect(setupKrt(await extractedRoot(), base({ env: { FABDESK_KRT_PYTHON: "/opt/py" }, run: old.run }))).rejects.toThrow(/FABDESK_KRT_PYTHON.*3\.9 < 3\.12/);
    const arm = fakeRun(root, () => undefined);
    await expect(setupKrt(await extractedRoot(), base({ arch: "arm64", run: arm.run }))).rejects.toThrow(/ships no grid_router for linux-arm64; building it needs Rust \(cargo/);
    expect(arm.calls).toEqual([]); // nothing downloaded before saying so
  });

  test("ARM with cargo: grid_router is built from the release's rust_router against the venv's Python", async () => {
    const root = await extractedRoot();
    const { run, calls } = fakeRun(root, ({ cmd, args }) => {
      if (cmd !== "/home/u/.cargo/bin/cargo") return undefined;
      touch(join(root, "build", "cargo-target", "release", "libgrid_router.so"), "built-arm64");
      expect(args).toEqual(["build", "--release", "--manifest-path", join(root, "src", "plugins", "rust_router", "Cargo.toml")]);
      return { code: 0, out: "Finished release" };
    });
    const exists = (p: string) => p === "/home/u/.cargo/bin/cargo" || existsSync(p);
    expect(findCargo({ platform: "linux", env: {}, home: "/home/u", which: () => null, exists })).toBe("/home/u/.cargo/bin/cargo");
    const r = await setupKrt(root, base({ arch: "arm64", home: "/home/u", exists, which: (n) => (n === "uv" ? "/bin/uv" : null), run }));
    expect(r).toMatchObject({ rust: "built" });
    expect(r.notice).toMatch(/built here.*linux-arm64/);
    expect(await readFile(join(root, "src", "plugins", "rust_router", "grid_router.so"), "utf8")).toBe("built-arm64");
    const order = calls.map((c) => (c.cmd.includes("cargo") ? "cargo" : c.args[0] === "venv" ? "venv" : c.args.includes("pip") ? "pip" : "check"));
    expect(order).toEqual(["venv", "pip", "cargo", "check"]);
    expect(existsSync(join(root, "build", "cargo-target"))).toBe(false);
  });

  test("ARM with cargo and a Cargo.lock in the source: the build passes --locked", async () => {
    const root = await extractedRoot();
    const rustDir = join(root, "src", "plugins", "rust_router");
    touch(join(rustDir, "Cargo.lock"), "version = 3\n");
    let cargoArgs: string[] = [];
    const { run } = fakeRun(root, ({ cmd, args }) => {
      if (cmd !== "/home/u/.cargo/bin/cargo") return undefined;
      cargoArgs = args;
      touch(join(root, "build", "cargo-target", "release", "libgrid_router.so"), "built-arm64");
      return { code: 0, out: "Finished release" };
    });
    const exists = (p: string) => p === "/home/u/.cargo/bin/cargo" || existsSync(p);
    await setupKrt(root, base({ arch: "arm64", home: "/home/u", exists, which: (n) => (n === "uv" ? "/bin/uv" : null), run }));
    expect(cargoArgs).toEqual(["build", "--release", "--locked", "--manifest-path", join(rustDir, "Cargo.toml")]);
    expect(cargoBuildArgs("/r", "linux", () => false)).toEqual(["build", "--release", "--manifest-path", "/r/Cargo.toml"]);
    expect(cargoBuildArgs("C:\\r", "win32", (p) => p === "C:\\r\\Cargo.lock")).toContain("--locked");
  });

  test("the import check failing fails the setup", async () => {
    const root = await extractedRoot();
    const { run } = fakeRun(root, ({ args }) => (args.some((a) => a.includes("import numpy")) ? { code: 1, out: "ImportError: libstdc++" } : undefined));
    await expect(setupKrt(root, base({ which: (n) => (n === "uv" ? "/bin/uv" : null), run }))).rejects.toThrow(/import check failed.*libstdc\+\+/);
  });
});

describe("registry install of KRT (no network, no Python)", () => {
  const body = Buffer.from("fake-krt-zip");
  const sha = createHash("sha256").update(body).digest("hex");

  async function serve(): Promise<string> {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/KiCadRoutingTools-0.23.8.zip`;
  }
  const krtCatalog = (url: string, sha256 = sha): RouterCatalogEntry[] =>
    defaultRouterCatalog({ FABDESK_KRT_URL: url, FABDESK_KRT_SHA256: sha256 }).filter((row) => row.id === "krt");
  /** `unzip -o ARCHIVE -d DEST`: lay out the release tree in DEST. */
  const unzip = async (cmd: string, args: string[]) => {
    expect(cmd).toBe("unzip");
    fakeRelease(args[args.indexOf("-d") + 1]!);
    return 0;
  };

  test("download, verify, extract into src/, set up in place; then uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-krt-reg-"));
    const seen: string[] = [];
    let registry!: ReturnType<typeof createRouterRegistry>;
    registry = createRouterRegistry({
      home,
      env: {},
      catalog: krtCatalog(await serve()),
      spawn: unzip,
      krtSetup: async (root) => {
        seen.push(root);
        expect(registry.get("krt").progress?.phase).toBe("setup");
        touch(join(root, "src", "plugins", "rust_router", "grid_router.so"));
        touch(layout.krtPaths(root).python[0]!);
        return { python: layout.krtPaths(root).python[0]!, via: "fake", deps: "locked", gridRouter: "", rust: "prebuilt" };
      },
    });
    expect(registry.get("krt")).toMatchObject({ state: "not_installed", kind: "engine", ready: false });
    const snap = await registry.install("krt");
    const root = join(home, "routers", "krt");
    expect(seen).toEqual([root]);
    expect(snap).toMatchObject({ state: "installed", ready: true, path: root, versionInstalled: "0.23.8", kind: "engine" });
    expect(existsSync(join(root, "src", "plugins", "py_router", "route.py"))).toBe(true);
    expect(registry.executable("krt")).toBe(root);
    // A fresh registry reads the saved state.
    expect(createRouterRegistry({ home, env: {}, catalog: krtCatalog("http://127.0.0.1:1/x") }).executable("krt")).toBe(root);
    const gone = await registry.uninstall("krt");
    expect(gone.state).toBe("not_installed");
    expect(existsSync(root)).toBe(false);
  });

  test("a setup failure is reported and leaves nothing installed; a checksum mismatch never extracts", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-krt-reg-"));
    const registry = createRouterRegistry({
      home,
      env: {},
      catalog: krtCatalog(await serve()),
      spawn: unzip,
      krtSetup: async () => {
        throw new Error("No Python ≥ 3.9 could make the KiCadRoutingTools venv (none found). Install uv");
      },
    });
    const failed = await registry.install("krt");
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/No Python/);
    expect(existsSync(join(home, "routers", "krt"))).toBe(false);

    let extracted = false;
    const bad = createRouterRegistry({
      home: await mkdtemp(join(tmpdir(), "fabdesk-krt-reg-")),
      env: {},
      catalog: krtCatalog(await serve(), "c".repeat(64)),
      spawn: async () => ((extracted = true), 0),
    });
    const mismatch = await bad.install("krt");
    expect(mismatch.state).toBe("failed");
    expect(mismatch.error).toMatch(/checksum mismatch/);
    expect(extracted).toBe(false);
  });

  test("overrides: Settings krtDir wins over FABDESK_KRT_DIR; a bad path is named, not used", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-krt-reg-"));
    const fromEnv = fakeRoot(await mkdtemp(join(tmpdir(), "fabdesk-krt-env-")));
    const fromSettings = fakeRoot(await mkdtemp(join(tmpdir(), "fabdesk-krt-set-")));
    let krtSetting: string | null = fromSettings;
    const registry = createRouterRegistry({ home, env: { FABDESK_KRT_DIR: fromEnv }, catalog: krtCatalog("http://127.0.0.1:1/x"), settings: () => ({ krtDir: krtSetting }) });
    expect(registry.get("krt")).toMatchObject({ state: "installed", ready: true, path: fromSettings, overriddenBy: "Settings krtDir", versionInstalled: KRT_VERSION });
    krtSetting = null;
    expect(registry.get("krt")).toMatchObject({ path: fromEnv, overriddenBy: "FABDESK_KRT_DIR" });
    const broken = createRouterRegistry({ home, env: { FABDESK_KRT_DIR: home }, catalog: krtCatalog("http://127.0.0.1:1/x") });
    const snap = broken.get("krt");
    expect(snap.ready).toBe(false);
    expect(snap.notice).toMatch(/FABDESK_KRT_DIR is set to .*not a KiCadRoutingTools build/);
  });
});

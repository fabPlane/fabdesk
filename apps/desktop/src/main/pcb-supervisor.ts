/** Starts the bundled FabPlane PCB bridge before core, and supplies core's bridge/KiCad env. */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolveProjectsDirectory } from "@fabdesk/auth-client";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { spawnSidecar } from "./child-process-env";

export interface PcbBundleManifest {
  format: 1;
  target: string;
  kicadCli: string;
  /** Bundle-relative KiCad stock-data directory (macOS uses KiCad.app/Contents/SharedSupport). */
  stockData?: string;
  bridge: string;
  footprints: string;
  symbols: string;
  /** Optional bundle-relative entry point for the private fab_router module. */
  fabRouter?: string;
  /** Optional for older bundles; missing files degrade routing to fab_router. */
  freerouting?: { jar: string; java: string };
  /** Bundle-relative shared-library directories, in loader search order (Linux). */
  libraryPaths?: string[];
  environment?: Record<string, string>;
}

export interface PcbBackendCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  url: string;
  /** An explicitly configured URL must not be silently replaced after a collision. */
  fixedUrl: boolean;
}

/** Environment the core needs for CLI-based DRC/render/export, not only the bridge process. */
export function corePcbEnvironment(command: PcbBackendCommand): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(command.env).filter(([key]) => key === "FABDESK_KICAD_MODELS" || /^KICAD\d+_3DMODEL_DIR$/.test(key))),
    FABDESK_FP_PCB_BRIDGE_URL: command.url,
    KICAD_CLI: command.env.KICAD_CLI!,
    KICAD_STOCK_DATA_HOME: command.env.KICAD_STOCK_DATA_HOME!,
    KICAD_FOOTPRINT_DIR: command.env.KICAD_FOOTPRINT_DIR!,
    KICAD_SYMBOL_DIR: command.env.KICAD_SYMBOL_DIR!,
    KICAD10_FOOTPRINT_DIR: command.env.KICAD10_FOOTPRINT_DIR ?? command.env.KICAD_FOOTPRINT_DIR!,
    KICAD10_SYMBOL_DIR: command.env.KICAD10_SYMBOL_DIR ?? command.env.KICAD_SYMBOL_DIR!,
    FABDESK_RUNTIME_ID: command.env.FABDESK_RUNTIME_ID!,
    FABDESK_DESKTOP_PID: command.env.FABDESK_DESKTOP_PID!,
    FABDESK_PROJECTS_DIR: command.env.WORKSPACE_ROOT!,
    ...(command.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: command.env.LD_LIBRARY_PATH } : {}),
  };
}

export function resolvePcbBackend(opts: {
  packaged: boolean;
  resourcesPath: string;
  appPath?: string;
  env?: NodeJS.ProcessEnv;
}): PcbBackendCommand | null {
  const env = opts.env ?? process.env;
  const override = env["FABDESK_FP_PCB_BRIDGE_BIN"];
  const source = env["FABDESK_FP_PCB_SOURCE"]?.trim();
  const root = override ? dirname(resolve(override)) : join(opts.resourcesPath, "pcb");
  const manifestPath = env["FABDESK_FP_PCB_BUNDLE"] ?? join(root, "bundle.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PcbBundleManifest;
  if (manifest.format !== 1)
    throw new Error(`unsupported FabPlane PCB bundle format in ${manifestPath}`);
  const bundleRoot = dirname(manifestPath);
  let consolePreload: string | undefined;
  if (process.platform === "win32" && !source && !override) {
    if (opts.packaged && !win32.relative(join(opts.resourcesPath, "pcb", "bundle.json"), manifestPath)) {
      consolePreload = resolve(opts.resourcesPath, "pcb", "fabdesk-hide-pcb-console.cjs");
    } else if (!opts.packaged && opts.appPath && env.FABDESK_DEV_PCB_DISCOVERED_BUNDLE &&
        !win32.relative(env.FABDESK_DEV_PCB_DISCOVERED_BUNDLE, manifestPath) &&
        manifest.target === `windows-${process.arch}` && manifest.bridge === "bin/fp-pcb-bridge.exe") {
      consolePreload = resolve(opts.appPath, "scripts", "fabdesk-hide-pcb-console.cjs");
    }
  }
  const bunOptions = manifest.environment?.BUN_OPTIONS ?? env.BUN_OPTIONS;
  const command = override ? resolve(override) : resolve(bundleRoot, manifest.bridge);
  const kicadCli = resolve(bundleRoot, manifest.kicadCli);
  const kicadStockData = resolve(bundleRoot, manifest.stockData ?? "kicad/share/kicad");
  const footprints = resolve(bundleRoot, manifest.footprints);
  const symbols = resolve(bundleRoot, manifest.symbols);
  const fabRouter = manifest.fabRouter ? resolve(bundleRoot, manifest.fabRouter) : null;
  // Always set explicit paths, including on degraded starts. Never borrow a host jar or Java.
  const freeroutingJar = resolve(
    bundleRoot,
    manifest.freerouting?.jar ?? ".freerouting-unavailable.jar",
  );
  const freeroutingJava = resolve(
    bundleRoot,
    manifest.freerouting?.java ?? ".freerouting-unavailable-java",
  );
  if (!manifest.freerouting || !existsSync(freeroutingJar) || !existsSync(freeroutingJava))
    console.warn("[pcb] bundled Freerouting unavailable; automatic routing will use fab_router");
  const libraryPaths = (manifest.libraryPaths ?? []).map((path) => resolve(bundleRoot, path));
  for (const [label, path] of [
    ["bridge", command],
    ["kicad-cli", kicadCli],
    ["stock data", kicadStockData],
    ["footprints", footprints],
    ["symbols", symbols],
  ] as const)
    if (!existsSync(path)) throw new Error(`FabPlane PCB bundle ${label} is missing: ${path}`);
  for (const path of libraryPaths)
    if (!existsSync(path)) throw new Error(`FabPlane PCB bundle library path is missing: ${path}`);
  if (fabRouter && !existsSync(fabRouter))
    throw new Error(`FabPlane PCB bundle fab_router is missing: ${fabRouter}`);
  const sourceRoot = source ? resolve(source) : null;
  if (sourceRoot && !existsSync(join(sourceRoot, "packages", "bridge", "src", "main.ts")))
    throw new Error(
      `FabPlane PCB source checkout is missing packages/bridge/src/main.ts: ${sourceRoot}`,
    );
  const url = env["FABDESK_FP_PCB_BRIDGE_URL"] ?? "http://127.0.0.1:4020";
  const port = new URL(url).port || "4020";
  const runtimeId = env["FABDESK_RUNTIME_ID"]?.trim() || randomUUID();
  const desktopPid = env["FABDESK_DESKTOP_PID"]?.trim() || String(process.pid);
  const workspace = resolveProjectsDirectory(env);
  const workspaceRoot =
    isAbsolute(workspace) || win32.isAbsolute(workspace) ? workspace : resolve(workspace);
  return {
    command: sourceRoot ? (env["BUN_PATH"] ?? "bun") : command,
    args: sourceRoot ? ["run", "--filter", "@fp-pcb/bridge", "start"] : [],
    cwd: sourceRoot ?? bundleRoot,
    url,
    fixedUrl: Boolean(env["FABDESK_FP_PCB_BRIDGE_URL"]),
    env: {
      ...(manifest.environment ?? {}),
      // Bun accepts spaces when the whole option is quoted. Its position and absolute path
      // keep inherited "--" and "--cwd" from suppressing or redirecting this preload.
      ...(consolePreload ? {
        BUN_OPTIONS: [`"--preload=${consolePreload.replaceAll("\\", "/")}"`, bunOptions].filter(Boolean).join(" "),
      } : {}),
      ...(libraryPaths.length
        ? { LD_LIBRARY_PATH: [...libraryPaths, env["LD_LIBRARY_PATH"]].filter(Boolean).join(":") }
        : {}),
      PORT: port,
      HOST: "127.0.0.1",
      KICAD_CLI: kicadCli,
      KICAD_STOCK_DATA_HOME: kicadStockData,
      KICAD_FOOTPRINT_DIR: footprints,
      KICAD_SYMBOL_DIR: symbols,
      // KiCad's stock global library tables use these versioned variables. Point both the
      // headless API server and kicad-cli at the exact libraries packaged with this runtime,
      // instead of silently resolving a host nightly installation.
      KICAD10_FOOTPRINT_DIR: footprints,
      KICAD10_SYMBOL_DIR: symbols,
      FABDESK_RUNTIME_ID: runtimeId,
      FABDESK_DESKTOP_PID: desktopPid,
      ...(fabRouter ? { FAB_ROUTER_MODULE: fabRouter } : {}),
      FREEROUTING_JAR: freeroutingJar,
      FP_PCB_JAVA: freeroutingJava,
      WORKSPACE_ROOT: workspaceRoot,
    },
  };
}

export class PcbSupervisor {
  private child: ChildProcess | null = null;
  constructor(private readonly command: PcbBackendCommand | null) {}

  async start(): Promise<Record<string, string>> {
    if (!this.command) return {};
    if (!this.command.env.KICAD_CLI)
      throw new Error("FabPlane PCB bridge command has no KICAD_CLI");
    const existing = await health(this.command.url);
    const mismatch = existing ? identityMismatch(existing, this.command) : null;
    if (mismatch) {
      if (this.command.fixedUrl)
        throw new Error(
          `FabPlane PCB bridge identity mismatch at explicit URL ${this.command.url}: ${mismatch}`,
        );
      const occupiedUrl = this.command.url;
      const port = await availableLoopbackPort();
      this.command.url = `http://127.0.0.1:${port}`;
      this.command.env.PORT = String(port);
      console.error(
        `[pcb] bridge at ${occupiedUrl} belongs to another runtime (${mismatch}); starting bundled bridge at ${this.command.url}`,
      );
    }
    if (!(await healthy(this.command.url, this.command))) {
      this.child = spawnSidecar(this.command.command, this.command.args, {
        cwd: this.command.cwd,
        env: { ...process.env, ...this.command.env },
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      const deadline = Date.now() + 60_000;
      while (!(await healthy(this.command.url, this.command))) {
        if (this.child.exitCode !== null)
          throw new Error(`FabPlane PCB bridge exited with code ${this.child.exitCode}`);
        if (Date.now() >= deadline)
          throw new Error(
            `FabPlane PCB bridge did not become healthy at ${this.command.url} within 60 s`,
          );
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    return corePcbEnvironment(this.command);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
      new Promise<void>((done) => child.once("exit", () => done())),
      new Promise<void>((done) => setTimeout(done, 3_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

interface BridgeHealth {
  name?: string;
  runtimeId?: string | null;
  ownerPid?: number | null;
  kicadCli?: string;
  workspaceRoot?: string;
  jsAutorouter?: { module?: string };
}

async function health(url: string): Promise<BridgeHealth | null> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return null;
    const body = (await response.json()) as BridgeHealth;
    return body.name === "@fp-pcb/bridge" ? body : null;
  } catch {
    return null;
  }
}

function identityMismatch(body: BridgeHealth, command: PcbBackendCommand): string | null {
  const expected = command.env;
  if (body.runtimeId !== expected.FABDESK_RUNTIME_ID)
    return `runtime ${body.runtimeId ?? "none"}, expected ${expected.FABDESK_RUNTIME_ID}`;
  if (body.ownerPid !== Number(expected.FABDESK_DESKTOP_PID))
    return `desktop owner ${body.ownerPid ?? "none"}, expected ${expected.FABDESK_DESKTOP_PID}`;
  if (body.kicadCli !== expected.KICAD_CLI)
    return `kicad-cli ${body.kicadCli ?? "none"}, expected ${expected.KICAD_CLI}`;
  if (body.workspaceRoot !== expected.WORKSPACE_ROOT)
    return `workspace ${body.workspaceRoot ?? "none"}, expected ${expected.WORKSPACE_ROOT}`;
  if (expected.JS_AUTOROUTER_MODULE && body.jsAutorouter?.module !== expected.JS_AUTOROUTER_MODULE)
    return `router ${body.jsAutorouter?.module ?? "none"}, expected ${expected.JS_AUTOROUTER_MODULE}`;
  return null;
}

async function healthy(url: string, command: PcbBackendCommand): Promise<boolean> {
  const body = await health(url);
  return body !== null && identityMismatch(body, command) === null;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a loopback port for the FabPlane PCB bridge");
  }
  await new Promise<void>((resolveClosed, reject) =>
    server.close((error) => (error ? reject(error) : resolveClosed())),
  );
  return address.port;
}

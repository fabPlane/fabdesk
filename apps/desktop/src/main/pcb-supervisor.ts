/** Starts the bundled FabPlane PCB bridge before core, and supplies core's bridge/KiCad env. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sidecarEnvironment } from "./child-process-env";

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
  /** Optional bundle-relative entry point for the private js_autorouter module. */
  jsAutorouter?: string;
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
}

/** Environment the core needs for CLI-based DRC/render/export, not only the bridge process. */
export function corePcbEnvironment(command: PcbBackendCommand): Record<string, string> {
  return {
    FABDESK_FP_PCB_BRIDGE_URL: command.url,
    KICAD_CLI: command.env.KICAD_CLI!,
    KICAD_STOCK_DATA_HOME: command.env.KICAD_STOCK_DATA_HOME!,
    KICAD_FOOTPRINT_DIR: command.env.KICAD_FOOTPRINT_DIR!,
    KICAD_SYMBOL_DIR: command.env.KICAD_SYMBOL_DIR!,
    ...(command.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: command.env.LD_LIBRARY_PATH } : {}),
  };
}

export function resolvePcbBackend(opts: {
  packaged: boolean;
  resourcesPath: string;
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
  const command = override ? resolve(override) : resolve(bundleRoot, manifest.bridge);
  const kicadCli = resolve(bundleRoot, manifest.kicadCli);
  const kicadStockData = resolve(bundleRoot, manifest.stockData ?? "kicad/share/kicad");
  const footprints = resolve(bundleRoot, manifest.footprints);
  const symbols = resolve(bundleRoot, manifest.symbols);
  const fabRouter = manifest.fabRouter ? resolve(bundleRoot, manifest.fabRouter) : null;
  const jsAutorouter = manifest.jsAutorouter ? resolve(bundleRoot, manifest.jsAutorouter) : null;
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
  if (jsAutorouter && !existsSync(jsAutorouter))
    throw new Error(`FabPlane PCB bundle js_autorouter is missing: ${jsAutorouter}`);
  const sourceRoot = source ? resolve(source) : null;
  if (sourceRoot && !existsSync(join(sourceRoot, "packages", "bridge", "src", "main.ts")))
    throw new Error(
      `FabPlane PCB source checkout is missing packages/bridge/src/main.ts: ${sourceRoot}`,
    );
  const url = env["FABDESK_FP_PCB_BRIDGE_URL"] ?? "http://127.0.0.1:4020";
  const port = new URL(url).port || "4020";
  return {
    command: sourceRoot ? (env["BUN_PATH"] ?? "bun") : command,
    args: sourceRoot ? ["run", "--filter", "@fp-pcb/bridge", "start"] : [],
    cwd: sourceRoot ?? bundleRoot,
    url,
    env: {
      ...(manifest.environment ?? {}),
      ...(libraryPaths.length
        ? { LD_LIBRARY_PATH: [...libraryPaths, env["LD_LIBRARY_PATH"]].filter(Boolean).join(":") }
        : {}),
      PORT: port,
      HOST: "127.0.0.1",
      KICAD_CLI: kicadCli,
      KICAD_STOCK_DATA_HOME: kicadStockData,
      KICAD_FOOTPRINT_DIR: footprints,
      KICAD_SYMBOL_DIR: symbols,
      ...(fabRouter ? { FAB_ROUTER_MODULE: fabRouter } : {}),
      ...(jsAutorouter ? { JS_AUTOROUTER_MODULE: jsAutorouter } : {}),
      WORKSPACE_ROOT: env["FABDESK_PROJECTS_DIR"] ?? join(homedir(), "fabdesk"),
    },
  };
}

export class PcbSupervisor {
  private child: ChildProcess | null = null;
  constructor(private readonly command: PcbBackendCommand | null) {}

  async start(): Promise<Record<string, string>> {
    if (!this.command) return {};
    if (!(await healthy(this.command.url))) {
      this.child = spawn(this.command.command, this.command.args, {
        cwd: this.command.cwd,
        env: sidecarEnvironment(process.env, this.command.env),
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      const deadline = Date.now() + 60_000;
      while (!(await healthy(this.command.url))) {
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

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === "@fp-pcb/bridge";
  } catch {
    return false;
  }
}

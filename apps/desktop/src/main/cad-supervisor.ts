/**
 * Starts the FabPlane CAD bridge (`@fab-cad/bridge`, fabPlane/fab_cad) before core and supplies
 * core's `FABDESK_FAB_CAD_BRIDGE_URL`. Unlike the PCB backend it is optional: without a bundle or a
 * source checkout nothing starts, and a bridge that fails to start only disables the `cad` toolset.
 *
 * Two ways to get one, like the PCB backend:
 * - a packaged bundle, `resources/cad/bundle.json` (or `FABDESK_FAB_CAD_BUNDLE`): the bridge
 *   executable, the fork's `FreeCADApiServer`, and optionally the built web UI;
 * - a source checkout, `FABDESK_FAB_CAD_SOURCE` (`bun run dev:cad` points it at `vendor/fab_cad`):
 *   the bridge runs from source under Bun, FreeCAD from `FREECAD_API_SERVER` or the mock server.
 *
 * The bridge runs arbitrary FreeCAD Python for whoever reaches its `/ws`, so every launch gets a
 * fresh bearer token: the bridge reads it as `FAB_CAD_BRIDGE_TOKEN`, core as
 * `FABDESK_FAB_CAD_BRIDGE_TOKEN`. A bridge older than the token ignores it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { sidecarEnvironment } from "./child-process-env";

export interface CadBundleManifest {
  format: 1;
  target: string;
  /** Bundle-relative bridge executable. */
  bridge: string;
  /** Bundle-relative `FreeCADApiServer` from the fabPlane FreeCAD fork. */
  freecadApiServer: string;
  /** Bundle-relative directory of the built fab_cad web UI. */
  web?: string;
  /** Bundle-relative shared-library directories, in loader search order (Linux). */
  libraryPaths?: string[];
  environment?: Record<string, string>;
  engine?: "native";
  pythonHome?: string;
  environmentPaths?: Record<string, string>;
}

export interface CadBackendCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  url: string;
  /** An explicitly configured URL must not be silently replaced after a collision. */
  fixedUrl: boolean;
  /** Bearer token for the bridge (also `env.FAB_CAD_BRIDGE_TOKEN`); random per launch. */
  token: string;
}

/** 32 random bytes, base64url: the bridge token for one launch. */
export function mintCadBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function resolveCadBackend(opts: {
  resourcesPath: string;
  packaged?: boolean;
  env?: NodeJS.ProcessEnv;
}): CadBackendCommand | null {
  const env = opts.env ?? process.env;
  const url = env["FABDESK_FAB_CAD_BRIDGE_URL"] ?? "http://127.0.0.1:4030";
  const workspace = env["FABDESK_PROJECTS_DIR"] ?? join(homedir(), "fabdesk");
  const fixedUrl = Boolean(env["FABDESK_FAB_CAD_BRIDGE_URL"]);
  // A bridge the user runs elsewhere (FABDESK_FAB_CAD_BRIDGE_URL) has its own token, which they
  // pass in FABDESK_FAB_CAD_BRIDGE_TOKEN; otherwise this launch mints one.
  const token = (fixedUrl && env["FABDESK_FAB_CAD_BRIDGE_TOKEN"]?.trim()) || mintCadBridgeToken();
  const common = {
    url,
    fixedUrl,
    token,
    base: {
      FAB_CAD_BRIDGE_TOKEN: token,
      PORT: new URL(url).port || "4030",
      HOST: "127.0.0.1",
      WORKSPACE_ROOT:
        isAbsolute(workspace) || win32.isAbsolute(workspace) ? workspace : resolve(workspace),
    },
  };

  const source = env["FABDESK_FAB_CAD_SOURCE"]?.trim();
  if (source && !opts.packaged) {
    const root = resolve(source);
    const main = join(root, "packages", "bridge", "src", "main.ts");
    if (!existsSync(main))
      throw new Error(
        `FabPlane CAD source checkout is missing packages/bridge/src/main.ts: ${root}`,
      );
    const mock = join(root, "packages", "mock-server", "src", "main.ts");
    const bun = env["BUN_PATH"] ?? "bun";
    const web = join(root, "apps", "web", "dist");
    return {
      command: bun,
      args: ["run", main],
      cwd: root,
      url: common.url,
      fixedUrl: common.fixedUrl,
      token: common.token,
      env: {
        ...common.base,
        FREECAD_API_SERVER: env["FREECAD_API_SERVER"]?.trim() || `"${bun}" "${mock}"`,
        ...(existsSync(web) ? { STATIC_DIR: web } : {}),
      },
    };
  }

  const manifestPath =
    env["FABDESK_FAB_CAD_BUNDLE"] ?? join(opts.resourcesPath, "cad", "bundle.json");
  if (!existsSync(manifestPath)) {
    if (opts.packaged) throw new Error(`Packaged FreeCAD engine is missing: ${manifestPath}`);
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CadBundleManifest;
  if (manifest.format !== 1)
    throw new Error(`unsupported FabPlane CAD bundle format in ${manifestPath}`);
  if (opts.packaged && manifest.engine !== "native")
    throw new Error("Packaged CAD requires a native engine manifest; mock fallback is forbidden");
  const bundleRoot = dirname(manifestPath);
  const environmentPaths = Object.fromEntries(
    Object.entries(manifest.environmentPaths ?? {}).map(([name, path]) => {
      const absolute = resolve(bundleRoot, path);
      if (
        relative(bundleRoot, absolute).startsWith("..") ||
        isAbsolute(relative(bundleRoot, absolute)) ||
        !existsSync(absolute)
      )
        throw new Error(`Invalid CAD runtime environment path: ${name}`);
      return [name, absolute];
    }),
  );
  const pythonHome = manifest.pythonHome ? resolve(bundleRoot, manifest.pythonHome) : null;
  if (pythonHome && !existsSync(pythonHome))
    throw new Error(`CAD Python runtime missing: ${pythonHome}`);
  const bridge = resolve(bundleRoot, manifest.bridge);
  const freecad = resolve(bundleRoot, manifest.freecadApiServer);
  const web = manifest.web ? resolve(bundleRoot, manifest.web) : null;
  const libraryPaths = (manifest.libraryPaths ?? []).map((path) => resolve(bundleRoot, path));
  for (const [label, path] of [
    ["bridge", bridge],
    ["FreeCADApiServer", freecad],
    ...(web ? [["web UI", web] as const] : []),
    ...libraryPaths.map((path) => ["library path", path] as const),
  ] as const)
    if (!existsSync(path)) throw new Error(`FabPlane CAD bundle ${label} is missing: ${path}`);
  return {
    command: bridge,
    args: [],
    cwd: bundleRoot,
    url: common.url,
    fixedUrl: common.fixedUrl,
    token: common.token,
    env: {
      ...(manifest.environment ?? {}),
      ...environmentPaths,
      ...(pythonHome
        ? {
            PYTHONHOME: pythonHome,
            PYTHONNOUSERSITE: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            VIRTUAL_ENV: "",
          }
        : {}),
      ...(libraryPaths.length
        ? { LD_LIBRARY_PATH: [...libraryPaths, env["LD_LIBRARY_PATH"]].filter(Boolean).join(":") }
        : {}),
      ...common.base,
      FREECAD_API_SERVER: `"${freecad}"`,
      ...(web ? { STATIC_DIR: web } : {}),
    },
  };
}

interface BridgeHealth {
  name?: string;
  workspaceRoot?: string;
}

/** Why a bridge answering at the URL is not ours to reuse, or null when it is. */
export function cadIdentityMismatch(body: BridgeHealth, command: CadBackendCommand): string | null {
  if (body.name !== "@fab-cad/bridge") return `a ${body.name ?? "different"} server`;
  if (body.workspaceRoot !== command.env.WORKSPACE_ROOT)
    return `workspace ${body.workspaceRoot ?? "none"}, expected ${command.env.WORKSPACE_ROOT}`;
  return null;
}

export class CadSupervisor {
  private child: ChildProcess | null = null;
  constructor(private readonly command: CadBackendCommand | null) {}

  /** Core's environment for the bridge; empty when there is none (the `cad` toolset then says so). */
  async start(): Promise<Record<string, string>> {
    const command = this.command;
    if (!command) return {};
    const existing = await health(command.url, command.token);
    // A bridge already running (a previous launch's, or one the user started) is reused only if
    // it takes this token: an older bridge without auth does, one minted another token does not
    // (and answers `/health` without the workspace, so the token is checked first).
    const mismatch = existing
      ? existing.name === "@fab-cad/bridge" && !(await acceptsToken(command))
        ? "it requires a different bridge token"
        : cadIdentityMismatch(existing, command)
      : null;
    if (existing && mismatch === null) return coreEnv(command);
    if (existing || (await portTaken(command.url))) {
      if (command.fixedUrl)
        throw new Error(
          `FabPlane CAD bridge URL ${command.url} is taken by another server${existing ? ` (${mismatch})` : ""}${mismatch?.includes("token") ? "; set FABDESK_FAB_CAD_BRIDGE_TOKEN to its token" : ""}`,
        );
      const port = await availableLoopbackPort();
      command.url = `http://127.0.0.1:${port}`;
      command.env.PORT = String(port);
    }
    this.child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: sidecarEnvironment(process.env, command.env),
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const body = await health(command.url, command.token);
      if (body && cadIdentityMismatch(body, command) === null) break;
      if (this.child.exitCode !== null)
        throw new Error(`FabPlane CAD bridge exited with code ${this.child.exitCode}`);
      if (Date.now() >= deadline) {
        await this.stop();
        throw new Error(`FabPlane CAD bridge did not become healthy at ${command.url} within 30 s`);
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    return coreEnv(command);
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

/** Core's environment for a running bridge. */
function coreEnv(command: CadBackendCommand): Record<string, string> {
  return { FABDESK_FAB_CAD_BRIDGE_URL: command.url, FABDESK_FAB_CAD_BRIDGE_TOKEN: command.token };
}

/** Whether the bridge at the command's URL answers an authenticated request with its token. */
async function acceptsToken(command: CadBackendCommand): Promise<boolean> {
  try {
    const response = await fetch(`${command.url}/sessions`, {
      headers: { authorization: `Bearer ${command.token}` },
      signal: AbortSignal.timeout(750),
    });
    return response.status !== 401 && response.status !== 403;
  } catch {
    return false;
  }
}

/** The bridge's `/health`; its workspace and FreeCAD fields are only shown to the token. */
async function health(url: string, token: string): Promise<BridgeHealth | null> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    return (await response.json()) as BridgeHealth;
  } catch {
    return null;
  }
}

async function portTaken(url: string): Promise<boolean> {
  const port = Number(new URL(url).port || 80);
  const server = createServer();
  return new Promise((done) => {
    server.once("error", () => done(true));
    server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
  });
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  if (!address || typeof address === "string")
    throw new Error("could not allocate a loopback port for the FabPlane CAD bridge");
  return address.port;
}

/**
 * Starts, attaches to, watches and stops the fabdesk-core daemon.
 *
 * - packaged: `<resources>/core/fabdesk-core[.exe]`; dev: `bun run apps/core/src/main.ts`
 * - reuses a live daemon named by `<userData>/daemon.json` (pid alive + /health OK with its token)
 * - 60 s ready timeout (a first launch on a slow disk or under antivirus scanning can take well over
 *   10 s; the fresh-VM tests caught the old 10 s limit restart-looping), crash restart with exponential
 *   backoff (max 5 restarts per minute)
 * - logs stdout/stderr to `<userData>/logs/core.log`
 */
import type { CoreInfo, CoreStatusInfo } from "../shared/core-info";
import type { DaemonHandshake, ReadyLine } from "@fabdesk/protocol";
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { spawnCorePort } from "./dev-profile";
import { sidecarEnvironment } from "./child-process-env";

const READY_TIMEOUT_MS = 60_000;
const MAX_RESTARTS_PER_MINUTE = 5;
const SHUTDOWN_GRACE_MS = 3_000;

export interface SupervisorOptions {
  localAuth: boolean;
  /** Override the daemon command (`FABDESK_CORE_BIN`). */
  binaryOverride?: string | undefined;
  /** Extra environment for the spawned daemon (e.g. the Sentry DSN/environment; see src/main/sentry.ts). */
  extraEnv?: Record<string, string> | undefined;
  /** Isolated "fabPlane Dev" profile: fixed port; core home is passed via FABDESK_HOME. */
  devProfile?: boolean | undefined;
}

export interface CoreCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function resolveCoreCommand(opts: { packaged: boolean; resourcesPath: string; appPath: string; override?: string | undefined }): CoreCommand {
  if (opts.override) return { command: opts.override, args: [], cwd: process.cwd() };
  if (opts.packaged) {
    const bin = join(opts.resourcesPath, "core", process.platform === "win32" ? "fabdesk-core.exe" : "fabdesk-core");
    return { command: bin, args: [], cwd: opts.resourcesPath };
  }
  const candidates = [resolve(opts.appPath, "..", ".."), process.cwd(), resolve(process.cwd(), "..", "..")];
  const root = candidates.find((c) => existsSync(join(c, "apps", "core", "src", "main.ts"))) ?? candidates[0]!;
  // Dev: Bun restarts the daemon on source changes (`FABDESK_CORE_RELOAD=watch`, default), swaps
  // modules in place (`hot`, experimental with Workers), or neither (`off`). See docs/dev-loop.md.
  const reload = process.env["FABDESK_CORE_RELOAD"] ?? "watch";
  const flags = reload === "hot" ? ["--hot"] : reload === "off" ? [] : ["--watch", "--no-clear-screen"];
  return { command: process.env["BUN_PATH"] ?? "bun", args: [...flags, "run", join(root, "apps", "core", "src", "main.ts")], cwd: root };
}

/** Dev daemons listen on a fixed port so MCP configs and the renderer survive a reload; 0 = random. */
export function devCorePort(env: NodeJS.ProcessEnv = process.env): string {
  return spawnCorePort({ packaged: false, devProfile: true, env });
}

export function parseReadyLine(line: string): ReadyLine | null {
  try {
    const v = JSON.parse(line) as Partial<ReadyLine>;
    if (v && v.ok === true && typeof v.port === "number" && typeof v.pid === "number") {
      return { ok: true, port: v.port, pid: v.pid, version: typeof v.version === "string" ? v.version : "" };
    }
  } catch {
    // not JSON
  }
  return null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthOk(url: string, token: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export class CoreSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private pid: number | null = null;
  private attached = false;
  private stopping = false;
  private restartTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private status: CoreStatusInfo = { state: "starting" };
  private log: WriteStream | null = null;
  private opts: SupervisorOptions;

  constructor(opts: SupervisorOptions) {
    super();
    this.opts = opts;
  }

  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /** Daemon bearer token once the core is ready (spawned or attached); null otherwise. */
  get currentToken(): string | null {
    return this.status.state === "ready" ? this.token : null;
  }

  info(): CoreInfo {
    return { url: this.status.state === "ready" ? this.url : null, token: this.status.state === "ready" ? this.token : null, status: this.status };
  }

  setLocalAuth(enabled: boolean): void {
    this.opts = { ...this.opts, localAuth: enabled };
  }

  private setStatus(next: CoreStatusInfo): void {
    this.status = next;
    this.emit("status", this.info());
  }

  private handshakePath(): string {
    return join(app.getPath("userData"), "daemon.json");
  }

  private logLine(line: string): void {
    if (!this.log) {
      const dir = join(app.getPath("userData"), "logs");
      mkdirSync(dir, { recursive: true });
      this.log = createWriteStream(join(dir, "core.log"), { flags: "a" });
    }
    this.log.write(`${new Date().toISOString()} ${line}\n`);
  }

  logPath(): string {
    return join(app.getPath("userData"), "logs", "core.log");
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (await this.tryAttach()) return;
    await this.spawnDaemon();
  }

  /** Reuses a daemon described by daemon.json when it is alive and answers /health with its token. */
  private async tryAttach(): Promise<boolean> {
    let hs: DaemonHandshake;
    try {
      hs = JSON.parse(readFileSync(this.handshakePath(), "utf8")) as DaemonHandshake;
    } catch {
      return false;
    }
    if (!hs || typeof hs.pid !== "number" || typeof hs.port !== "number" || typeof hs.token !== "string") return false;
    if (!pidAlive(hs.pid)) return false;
    const url = `http://${hs.host ?? "127.0.0.1"}:${hs.port}`;
    if (!(await healthOk(url, hs.token))) return false;
    this.port = hs.port;
    this.token = hs.token;
    this.pid = hs.pid;
    this.attached = true;
    this.logLine(`attached to running daemon pid=${hs.pid} port=${hs.port}`);
    this.setStatus({ state: "ready", port: hs.port, pid: hs.pid, attached: true, localAuth: hs.authMode === "local" });
    this.watchAttached();
    return true;
  }

  private watchAttached(): void {
    const pid = this.pid;
    if (!pid) return;
    const timer = setInterval(() => {
      if (this.stopping || !this.attached) {
        clearInterval(timer);
        return;
      }
      if (!pidAlive(pid)) {
        clearInterval(timer);
        this.attached = false;
        this.logLine(`attached daemon pid=${pid} disappeared`);
        this.scheduleRestart("attached daemon exited");
      }
    }, 2000);
  }

  private async spawnDaemon(): Promise<void> {
    const token = randomBytes(32).toString("hex");
    const cmd = resolveCoreCommand({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      override: this.opts.binaryOverride,
    });
    const args = [
      ...cmd.args,
      "serve",
      "--port",
      spawnCorePort({
        packaged: app.isPackaged,
        ...(this.opts.binaryOverride ? { binaryOverride: true } : {}),
        devProfile: this.opts.devProfile === true,
        env: process.env,
      }),
      "--handshake-file",
      this.handshakePath(),
      "--parent-pid",
      String(process.pid),
      ...(this.opts.localAuth ? ["--local-auth"] : []),
    ];
    this.setStatus({ state: this.status.state === "restarting" ? "restarting" : "starting", ...(this.status.attempt !== undefined ? { attempt: this.status.attempt } : {}), localAuth: this.opts.localAuth });
    this.logLine(`spawn ${cmd.command} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, args, {
        cwd: cmd.cwd,
        env: sidecarEnvironment(process.env, {
          ...(this.opts.extraEnv ?? {}),
          FABDESK_TOKEN: token,
          ELECTRON_RUN_AS_NODE: undefined,
        }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      this.setStatus({ state: "crashed", message: `failed to spawn core: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    this.child = child;
    this.token = token;
    this.attached = false;

    let ready = false;
    const readyTimer = setTimeout(() => {
      if (ready) return;
      this.logLine("ready timeout; killing core");
      child.kill();
      this.setStatus({ state: "crashed", message: `core did not become ready within ${READY_TIMEOUT_MS / 1000} s` });
    }, READY_TIMEOUT_MS);

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        this.logLine(`[out] ${line}`);
        const rl = parseReadyLine(line);
        if (!rl) return;
        // A second ready line means `bun --watch` restarted the daemon in place (same token, same
        // port by default): re-announce so the renderer reconnects instead of treating it as a crash.
        const reloaded = ready;
        ready = true;
        clearTimeout(readyTimer);
        this.port = rl.port;
        this.pid = rl.pid || child.pid || null;
        this.restartTimes = this.restartTimes.filter((t) => Date.now() - t < 60_000);
        this.setStatus({ state: "ready", port: rl.port, pid: this.pid ?? 0, attached: false, localAuth: this.opts.localAuth, ...(reloaded ? { message: "core reloaded" } : {}) });
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => this.logLine(`[err] ${line}`));
    }
    child.on("error", (err) => {
      this.logLine(`spawn error: ${err.message}`);
      clearTimeout(readyTimer);
      if (this.child === child) this.child = null;
      this.setStatus({ state: "crashed", message: err.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      this.logLine(`core exited code=${code} signal=${signal}`);
      if (this.child === child) this.child = null;
      if (this.stopping) {
        this.setStatus({ state: "stopped" });
        return;
      }
      this.scheduleRestart(`core exited (code ${code ?? signal ?? "?"})`);
    });
  }

  private scheduleRestart(reason: string): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
    if (this.restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
      this.setStatus({ state: "crashed", message: `${reason}; gave up after ${MAX_RESTARTS_PER_MINUTE} restarts in a minute` });
      return;
    }
    this.restartTimes.push(now);
    const attempt = this.restartTimes.length;
    const delay = Math.min(8_000, 500 * 2 ** (attempt - 1));
    this.setStatus({ state: "restarting", attempt, message: reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnDaemon();
    }, delay);
  }

  /** Manual restart from the UI (also clears the restart budget). */
  async restart(): Promise<void> {
    this.restartTimes = [];
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.stop({ shutdown: true, force: true });
    await this.start();
  }

  private async keepRunning(): Promise<boolean> {
    if (!this.url || !this.token) return false;
    try {
      const res = await fetch(`${this.url}/settings`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return false;
      const s = (await res.json()) as { keepCoreRunning?: boolean };
      return s.keepCoreRunning === true;
    } catch {
      return false;
    }
  }

  /** `before-quit`: POST /shutdown unless settings.keepCoreRunning, then make sure our own child is gone. */
  async stop(opts: { shutdown: boolean; force?: boolean }): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const keep = opts.force ? false : await this.keepRunning();
    if (opts.shutdown && !keep && this.url && this.token) {
      try {
        await fetch(`${this.url}/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // daemon may already be gone
      }
    }
    const child = this.child;
    if (child && !keep) {
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, SHUTDOWN_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(t);
          done();
        });
        if (child.exitCode !== null) {
          clearTimeout(t);
          done();
        } else if (!opts.shutdown) child.kill();
      });
    }
    this.child = null;
    this.attached = false;
    this.setStatus({ state: "stopped" });
    this.log?.end();
    this.log = null;
  }
}

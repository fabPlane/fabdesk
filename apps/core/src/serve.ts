/** `fabdesk-core serve`: bind, write the handshake, print the ReadyLine, run until told to stop. */
import { chmod, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonHandshake, DoctorReport, ReadyLine } from "@fabdesk/protocol";
import {
  ToolError,
  createRegistry,
  toolsMarkdown,
  type CoreServices,
  type ProjectHandle,
  type ToolRegistry,
} from "@fabdesk/tools";
import type { AgentId } from "@fabdesk/protocol";
import { AgentRunManager, type AgentAdapterLike } from "./agent-runs";
import { TokenSet } from "./auth";
import { createAuth, type AuthFacade } from "./auth-facade";
import { EventBus } from "./bus";
import { resolveConfig, type CoreConfig } from "./config";
import { locateAppBridgeFile } from "./app-bridge";
import { createContextFactory } from "./context";
import { Store } from "./db";
import { createApp } from "./http/app";
import { JobRunner } from "./jobs";
import { logger, errMsg } from "./log";
import { McpSessionManager } from "./mcp-sessions";
import { ProjectStore } from "./projects";
import {
  applyErrorReporting,
  captureCoreException,
  closeSentry,
  runSentryTest,
  sentryUserFromAuth,
  setSentryUser,
} from "./sentry";
import { RunTelemetry } from "./run-telemetry";

export type ServeOptions = {
  port?: number;
  host?: string;
  handshakeFile?: string;
  parentPid?: number;
  localAuth?: boolean;
  dataDir?: string;
  /** Tests: inject services/adapters and skip the ReadyLine. */
  services?: (deps: {
    config: CoreConfig;
    projects: ProjectStore;
    bus: EventBus;
    store: Store;
    auth: AuthFacade;
  }) => Promise<CoreServices> | CoreServices;
  adapters?: Partial<Record<AgentId, AgentAdapterLike>>;
  doctor?: () => Promise<DoctorReport>;
  quiet?: boolean;
  watchProjects?: boolean;
  /** Do not write the handshake file (tests). */
  noHandshake?: boolean;
};

export type Daemon = {
  config: CoreConfig;
  port: number;
  url: string;
  token: string;
  store: Store;
  bus: EventBus;
  jobs: JobRunner;
  projects: ProjectStore;
  registry: ToolRegistry;
  mcp: McpSessionManager;
  tokens: TokenSet;
  runs: AgentRunManager;
  close(reason?: string): Promise<void>;
  closed: Promise<string>;
};

type WsData = { patterns: string[]; unsubscribe: (() => void) | null };

export async function serve(opts: ServeOptions = {}): Promise<Daemon> {
  const config = resolveConfig(opts);
  await mkdir(config.home, { recursive: true });
  const startedAt = Date.now();
  const bus = new EventBus();
  const store = Store.open(config.dbPath);
  await applyErrorReporting(store.settings.get().errorReporting);
  const stale = store.jobs.failStale();
  if (stale) logger.info("failed stale jobs from previous run", { count: stale });
  const staleRuns = store.runs.failStale();
  if (staleRuns.length)
    logger.info("failed stale agent runs from previous run", { threads: staleRuns });
  const tokens = new TokenSet(config.token);
  const telemetry = new RunTelemetry({ version: config.version, runDumps: store.runDumps });
  const jobs = new JobRunner({
    emit: (e) => bus.emit(e),
    store: store.jobs,
    // Expected tool failures (bad args, missing kicad-cli, ...) are user-facing, not bugs.
    onFailure: (job, e) => {
      if (e instanceof ToolError && e.code !== "internal") return;
      captureCoreException(e, { "job.kind": job.kind, "job.class": job.jobClass });
    },
  });
  const projects = new ProjectStore(store.projects, config.projectsDir, (e) => bus.emit(e), {
    watch: opts.watchProjects ?? true,
  });
  await projects.init();
  const auth = await createAuth({
    mode: config.authMode,
    channel: config.channel,
    home: config.home,
    apiOrigin: config.apiOrigin,
    emit: (e) => bus.emit(e),
  });
  if (auth.mode === "local") logger.warn("running in LOCAL auth mode");
  // Sentry user = principal id + handle (never email) while signed in; cleared on logout.
  setSentryUser(sentryUserFromAuth(auth.state()));
  const unsubscribeAuth = bus.subscribe(["auth.state"], (events) => {
    for (const ev of events)
      if (ev.event.topic === "auth.state") setSentryUser(sentryUserFromAuth(ev.event.state));
  });

  const services: CoreServices =
    opts.services !== undefined
      ? await opts.services({ config, projects, bus, store, auth })
      : await (
          await import("./services")
        ).createServices({
          version: config.version,
          runtimeId: config.runtimeId,
          channel: config.channel,
          settings: () => store.settings.get(),
          projects,
          bus,
          routeRuns: store.routeRuns,
          principal: () => auth.principal(),
          home: config.home,
          token: config.token,
          appBridgeFile: locateAppBridgeFile(config.handshakePath),
          telemetry,
        });

  const registry = createRegistry();
  const ctxFactory = createContextFactory({ services, projects, tokens, telemetry });
  const mcp = new McpSessionManager({ registry, ctxFactory, version: config.version });

  const adapters = opts.adapters ?? (await loadAdapters());
  let mcpUrl = "";
  const runs = new AgentRunManager({
    store,
    emit: (e) => bus.emit(e),
    tokens,
    get mcpUrl() {
      return mcpUrl;
    },
    adapters,
    settings: () => store.settings.get(),
    workspaceDir: join(config.home, "workspace"),
    telemetry,
    agentEnvironment: async ({ cwd, project }) => {
      const [cli, design] = await Promise.all([services.kicad.resolveCli().catch(() => null), services.design.status()]);
      return {
        FABDESK_PROJECT_DIR: cwd,
        ...(mcpUrl ? { FABDESK_CORE_URL: new URL(mcpUrl).origin } : {}),
        ...(project ? {
          FABDESK_KICAD_PROJECT: join(project.dir, "board.kicad_pro"),
          FABDESK_KICAD_SCHEMATIC: join(project.dir, "board.kicad_sch"),
          FABDESK_KICAD_BOARD: join(project.dir, "board.kicad_pcb"),
        } : {}),
        ...(cli ? { KICAD_CLI: cli.path } : {}),
        ...(design.url ? { FABDESK_FP_PCB_BRIDGE_URL: design.url } : {}),
      };
    },
    prepareProject: async (project: ProjectHandle) => {
      const agents = await import("@fabdesk/agents");
      const sketches = (await projects.listFiles(join(project.dir, "sketches")))
        .filter((f) => /\.(png|jpe?g)$/i.test(f.path))
        .map((f) => join(project.dir, "sketches", f.path));
      const board = project.manifest().board;
      await agents.writeAgentDocs(project.dir, {
        projectName: project.name,
        toolsMarkdown: toolsMarkdown(registry),
        sketches,
        board: {
          layers: board.layers,
          ...(board.widthMm !== undefined ? { widthMm: board.widthMm } : {}),
          ...(board.heightMm !== undefined ? { heightMm: board.heightMm } : {}),
          ...(board.template !== undefined ? { template: board.template } : {}),
        },
        mcpServerName: agents.MCP_SERVER_NAME,
      });
    },
  });

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((r) => (resolveClosed = r));
  let closing = false;

  const doctor =
    opts.doctor ??
    (async () => (await import("./doctor")).runDoctor({ config, settings: store.settings.get() }));
  const app = createApp({
    config,
    store,
    bus,
    jobs,
    projects,
    tokens,
    registry,
    ctxFactory,
    services,
    mcp,
    auth,
    runs,
    doctor,
    agents: async () => (await import("@fabdesk/agents")).detectAgents(store.settings.get()),
    shutdown: (reason) => void daemon.close(reason),
    startedAt,
  });

  const server = Bun.serve<WsData, Record<never, never>>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = req.headers.get("origin");
        if (!originAllowedLocal(origin)) return new Response("forbidden origin", { status: 403 });
        const token =
          url.searchParams.get("token") ??
          req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          null;
        if (!tokens.verify(token)) return new Response("unauthorized", { status: 401 });
        const patterns = (url.searchParams.get("topics") ?? "*")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          srv.upgrade(req, {
            data: { patterns: patterns.length ? patterns : ["*"], unsubscribe: null },
          })
        )
          return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        ws.data.unsubscribe = bus.subscribe(ws.data.patterns, (events) => {
          for (const ev of events) ws.send(JSON.stringify({ id: ev.id, event: ev.event }));
        });
      },
      message(ws, message) {
        try {
          const msg = JSON.parse(String(message)) as { subscribe?: string[]; lastEventId?: number };
          if (Array.isArray(msg.subscribe)) {
            ws.data.unsubscribe?.();
            ws.data.patterns = msg.subscribe.length ? msg.subscribe : ["*"];
            if (typeof msg.lastEventId === "number")
              for (const ev of bus.replay(msg.lastEventId, ws.data.patterns))
                ws.send(JSON.stringify({ id: ev.id, event: ev.event }));
            ws.data.unsubscribe = bus.subscribe(ws.data.patterns, (events) => {
              for (const ev of events) ws.send(JSON.stringify({ id: ev.id, event: ev.event }));
            });
          }
        } catch {
          ws.send(JSON.stringify({ error: "bad message" }));
        }
      },
      close(ws) {
        ws.data.unsubscribe?.();
        ws.data.unsubscribe = null;
      },
    },
  });

  const port = server.port ?? config.port;
  const url = `http://${config.host}:${port}`;
  mcpUrl = `${url}/mcp`;
  mcp.allowedHosts = [
    `${config.host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ];

  if (!opts.noHandshake)
    await writeHandshake(config.handshakePath, {
      version: config.version,
      pid: process.pid,
      port,
      host: config.host,
      token: config.token,
      startedAt: new Date(startedAt).toISOString(),
      channel: config.channel,
      authMode: auth.mode,
      ...(config.runtimeId ? { runtimeId: config.runtimeId } : {}),
    });
  const ready: ReadyLine = {
    ok: true,
    port,
    pid: process.pid,
    version: config.version,
    ...(config.runtimeId ? { runtimeId: config.runtimeId } : {}),
  };
  if (!opts.quiet) process.stdout.write(JSON.stringify(ready) + "\n");
  void runSentryTest();
  logger.info("fabdesk-core listening", {
    url,
    channel: config.channel,
    authMode: auth.mode,
    home: config.home,
    projects: config.projectsDir,
  });

  // Parent watchdog: exit 30 s after the parent disappears unless an MCP session is active or keepCoreRunning.
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let parentGoneSince: number | null = null;
  if (config.parentPid) {
    watchdog = setInterval(() => {
      const alive = pidAlive(config.parentPid!);
      if (alive) {
        parentGoneSince = null;
        return;
      }
      parentGoneSince ??= Date.now();
      // A session counts as "active" only with traffic in the last 10 minutes (stale sessions must not pin the daemon).
      const keep =
        store.settings.get().keepCoreRunning ||
        mcp.activeCount({ withinMs: 10 * 60_000 }) > 0 ||
        runs.activeCount() > 0;
      if (!keep && Date.now() - parentGoneSince > 30_000)
        void daemon.close("parent process exited");
    }, 5000);
  }

  const daemon: Daemon = {
    config,
    port,
    url,
    token: config.token,
    store,
    bus,
    jobs,
    projects,
    registry,
    mcp,
    tokens,
    runs,
    closed,
    async close(reason = "close") {
      if (closing) return;
      closing = true;
      logger.info("shutting down", { reason });
      try {
        bus.emit({ ts: Date.now(), topic: "core.shutdown", reason });
      } catch {
        /* ignore */
      }
      if (watchdog) clearInterval(watchdog);
      unsubscribeAuth();
      runs.abortAll();
      jobs.cancelAll();
      if (!(await runs.settleAll())) logger.warn("agent runs did not stop before shutdown timeout");
      await mcp.closeAll();
      projects.close();
      (services as { dispose?: () => void }).dispose?.();
      await new Promise((r) => setTimeout(r, 30));
      server.stop(true);
      if (!opts.noHandshake) await removeHandshake(config.handshakePath);
      await telemetry.shutdown();
      store.close();
      await closeSentry();
      resolveClosed(reason);
    },
  };
  return daemon;
}

async function loadAdapters(): Promise<Partial<Record<AgentId, AgentAdapterLike>>> {
  try {
    const m = await import("@fabdesk/agents");
    return m.adapters as unknown as Partial<Record<AgentId, AgentAdapterLike>>;
  } catch (e) {
    logger.warn("agents package unavailable; agent runs disabled", { error: errMsg(e) });
    return {};
  }
}

function originAllowedLocal(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.protocol === "file:" ||
      u.protocol === "app:"
    );
  } catch {
    return origin === "null" || origin.startsWith("file://");
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeHandshake(path: string, hs: DaemonHandshake): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(hs, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

export async function removeHandshake(path: string): Promise<void> {
  try {
    const current = JSON.parse(await Bun.file(path).text()) as { pid?: number };
    if (current.pid === process.pid) await unlink(path);
  } catch {
    /* not ours or already gone */
  }
}

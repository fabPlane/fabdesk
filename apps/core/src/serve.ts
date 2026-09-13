/** `fabdesk-core serve`: bind, write the handshake, print the ReadyLine, run until told to stop. */
import { chmod, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonHandshake, DoctorReport, ReadyLine, Settings } from "@fabdesk/protocol";
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
import { DeviceStore } from "./devices";
import { RemoteListener, type RemoteListenerOptions } from "./remote";
import {
  RelayDefaultResolver,
  RelayLink,
  VIA_HEADER,
  type EventSession,
  type RelayEndpoint,
} from "./relay";
import { createAuth, type AuthFacade } from "./auth-facade";
import { CloudSettingsSync } from "./cloud-settings";
import { EventBus } from "./bus";
import { resolveConfig, type CoreConfig } from "./config";
import { locateAppBridgeFile } from "./app-bridge";
import { createContextFactory } from "./context";
import { Store } from "./db";
import type { Hono } from "hono";
import { createApp, type Env } from "./http/app";
import { JobRunner } from "./jobs";
import { logger, errMsg } from "./log";
import { McpSessionManager } from "./mcp-sessions";
import { machineName } from "./net";
import { Notifier } from "./notifier";
import { ProjectStore } from "./projects";
import {
  applyErrorReporting,
  captureCoreException,
  closeSentry,
  runSentryTest,
  sentryUserFromAuth,
  setSentryUser,
} from "./sentry";

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
  /** Tests: capture the Notifier's outbound `POST /v1/private/push` instead of reaching fabplane.com. */
  notifierFetch?: typeof fetch;
  /** Tests: how soon after queueing the Notifier asks fabplane.com for the verdict. */
  notifierVerdictDelayMs?: number;
  /** Tests: shorten the 30-minute supervised-mode approval timeout. */
  approvalTimeoutMs?: number;
  /** Tests: the bearer the relay link presents, when the AuthFacade has none (local auth mode). */
  relayToken?: () => string | null;
  /** Tests: the env the default relay is derived from (`FABPLANE_RELAY_URL`); `process.env` otherwise. */
  relayEnv?: NodeJS.ProcessEnv;
  /** Tests: capture the relay discovery probe (`GET <api>/v1/config`). */
  relayDiscoveryFetch?: typeof fetch;
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
  notifier: Notifier;
  relay: RelayLink;
  close(reason?: string): Promise<void>;
  closed: Promise<string>;
};

/** `deviceId` is set when the socket was opened with a device token, so the Notifier can skip a phone that is listening. */
/** Origins allowed to call the remote listener from a browser page (hosted web pairing). */
const HOSTED_ORIGINS = [
  "https://fabplane.com",
  "https://www.fabplane.com",
  "https://app.fabplane.com",
];

type WsData = { patterns: string[]; deviceId: string | null; session: EventSession | null };

/**
 * The remote listener with the relay link riding along: `PATCH /settings` re-applies the
 * listener, and the relay follows the same `remote` setting.
 */
class RemoteListenerWithRelay extends RemoteListener {
  constructor(
    opts: RemoteListenerOptions,
    private readonly relay: RelayLink,
  ) {
    super(opts);
  }
  override apply(remote: Settings["remote"]) {
    const state = super.apply(remote);
    this.relay.apply(remote);
    return state;
  }
}

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
  const devices = new DeviceStore(store.db);
  tokens.setDeviceLookup((token) => {
    const device = devices.verify(token);
    return device ? { kind: "device", deviceId: device.id } : null;
  });
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
  const cloudSettings = new CloudSettingsSync({
    apiOrigin: config.apiOrigin,
    token: () => auth.token(),
    settings: store.settings,
  });
  if (auth.state().status === "signed_in") void cloudSettings.pull();
  const unsubscribeCloud = bus.subscribe(["auth.state"], (events) => {
    for (const ev of events) {
      if (ev.event.topic === "auth.state" && ev.event.state.status === "signed_in") {
        void cloudSettings.pull();
      }
    }
  });

  const services: CoreServices =
    opts.services !== undefined
      ? await opts.services({ config, projects, bus, store, auth })
      : await (
          await import("./services")
        ).createServices({
          version: config.version,
          channel: config.channel,
          settings: () => store.settings.get(),
          projects,
          bus,
          routeRuns: store.routeRuns,
          principal: () => auth.principal(),
          home: config.home,
          token: config.token,
          appBridgeFile: locateAppBridgeFile(config.handshakePath),
        });

  const registry = createRegistry();
  const ctxFactory = createContextFactory({ services, projects, tokens });
  const mcp = new McpSessionManager({
    registry,
    ctxFactory,
    version: config.version,
    permissionPrompt: {
      enabledFor: (token) => runs.isSupervisedRunToken(token),
      handle: (token, req) => runs.permissionPrompt(token, req),
    },
  });

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
    // Only fabdesk's own tools have annotations the classifier trusts; another server's tool is a write.
    annotationsFor: (tool, server) =>
      server === null || server === "fabdesk" ? registry.get(tool)?.annotations : undefined,
    resolveProject: (id) => projects.handle(id),
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
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
  // Nothing to configure: the relay is derived from the API origin (or discovered from the API
  // later, at which point the link is re-applied); `remote.relayUrl` overrides, `remote.relay: "off"` disables.
  const relayDefaults = new RelayDefaultResolver({
    apiOrigin: config.apiOrigin,
    ...(opts.relayEnv ? { env: opts.relayEnv } : {}),
    ...(opts.relayDiscoveryFetch ? { fetchImpl: opts.relayDiscoveryFetch } : {}),
    // A probe can land after shutdown; it must not bring the link back up.
    onChange: () => {
      if (!closing) relay.apply(store.settings.get().remote);
    },
  });
  const relay = new RelayLink({
    coreId: store.settings.coreId(),
    token: opts.relayToken ?? (() => auth.token()),
    defaultRelay: () => relayDefaults.current(),
    emit: (e) => bus.emit(e),
  });
  const remote = new RemoteListenerWithRelay({ emit: (e) => bus.emit(e) }, relay);
  // Signing in (or out) after start is what turns the relay on (or off); the setting alone is not enough.
  const unsubscribeAuthRelay = bus.subscribe(["auth.state"], () =>
    relay.apply(store.settings.get().remote),
  );

  // Devices with an open event socket (refcounted: a phone may hold one per listener while it
  // switches addresses). The Notifier does not push to a phone that is already listening.
  const liveDevices = new Map<string, number>();
  const notifier = new Notifier({
    bus,
    store,
    devices,
    auth,
    apiOrigin: config.apiOrigin,
    coreId: store.settings.coreId(),
    coreName: machineName(),
    isOnline: (id) => (liveDevices.get(id) ?? 0) > 0,
    ...(opts.notifierFetch ? { fetchImpl: opts.notifierFetch } : {}),
    ...(opts.notifierVerdictDelayMs !== undefined
      ? { verdictDelayMs: opts.notifierVerdictDelayMs }
      : {}),
  });
  notifier.start();

  const appDeps = {
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
    devices,
    remote,
    relay,
    /** Endpoints beyond the listener's own addresses — the relay, when configured and signed in. */
    extraEndpoints: (): RelayEndpoint[] => {
      const e = relay.endpoint();
      return e ? [e] : [];
    },
    doctor,
    agents: async () => (await import("@fabdesk/agents")).detectAgents(store.settings.get()),
    shutdown: (reason: string) => void daemon.close(reason),
    startedAt,
    onSettingsChanged: () => {
      void cloudSettings.push();
    },
  };
  const app = createApp({ ...appDeps, listener: "local" });
  // A browser at fabplane.com pairs against the remote listener directly (docs/mobile.md, hosted
  // web pairing), so its origin has to pass the guard there; the loopback listener stays strict.
  const remoteApp = createApp({ ...appDeps, listener: "remote", extraOrigins: HOSTED_ORIGINS });

  /**
   * One request handler shape for both listeners: upgrade `/ws`, otherwise hand off to that
   * listener's Hono app. The origin check differs — a browser reaching the remote listener is not
   * a case we serve, so a remote socket may carry no Origin, or only the listener's own (React
   * Native's WebSocket sends `Origin: http://<host>:<port>` for the URL it dials; nothing on this
   * listener serves a page, so no browser can legitimately present that origin).
   */
  const makeFetch =
    (target: Hono<Env>, scope: "local" | "remote") =>
    (req: Request, srv: Bun.Server): Response | Promise<Response> | undefined => {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = req.headers.get("origin");
        const allowed =
          scope === "local" ? originAllowedLocal(origin) : originAllowedRemote(origin, url.host);
        if (!allowed) return new Response("forbidden origin", { status: 403 });
        // A socket on a listener is direct whatever header a phone sends.
        const headers = new Headers(req.headers);
        headers.delete(VIA_HEADER);
        const data = authorizeEventSocket(url, headers);
        if (!data) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { data })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      // Only the relay link may say a request came over the relay; a listener request is direct.
      if (req.headers.has(VIA_HEADER)) {
        const headers = new Headers(req.headers);
        headers.delete(VIA_HEADER);
        return target.fetch(new Request(req, { headers }));
      }
      return target.fetch(req);
    };

  /**
   * The credential and topics of a `/ws` request; null when the token is unknown. Shared with
   * the relay, which marks its sockets with `VIA_HEADER` so the device row records the path.
   */
  const authorizeEventSocket = (url: URL, headers: Headers): WsData | null => {
    const token =
      url.searchParams.get("token") ??
      headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    const info = tokens.lookup(token);
    if (!info) return null;
    if (info.kind === "device" && info.deviceId)
      devices.touch(info.deviceId, {
        via: headers.get(VIA_HEADER) === "relay" ? "relay" : "direct",
      });
    const patterns = (url.searchParams.get("topics") ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      patterns: patterns.length ? patterns : ["*"],
      deviceId: info.kind === "device" ? (info.deviceId ?? null) : null,
      session: null,
    };
  };

  /**
   * One subscriber on the bus per event socket, whether the socket is the listener's own or one
   * the relay proxies: `{subscribe, lastEventId}` re-subscribes and replays, each event goes out
   * as an `{id, event}` envelope.
   */
  const openEventSession = (data: WsData, send: (s: string) => void): EventSession => {
    const deliver = (events: { id: number; event: unknown }[]) => {
      for (const ev of events) send(JSON.stringify({ id: ev.id, event: ev.event }));
    };
    if (data.deviceId) liveDevices.set(data.deviceId, (liveDevices.get(data.deviceId) ?? 0) + 1);
    let unsubscribe: (() => void) | null = bus.subscribe(data.patterns, deliver);
    let open = true;
    return {
      message(raw) {
        if (!open) return;
        try {
          const msg = JSON.parse(raw) as { subscribe?: string[]; lastEventId?: number };
          if (Array.isArray(msg.subscribe)) {
            unsubscribe?.();
            data.patterns = msg.subscribe.length ? msg.subscribe : ["*"];
            if (typeof msg.lastEventId === "number")
              deliver(bus.replay(msg.lastEventId, data.patterns));
            unsubscribe = bus.subscribe(data.patterns, deliver);
          }
        } catch {
          send(JSON.stringify({ error: "bad message" }));
        }
      },
      close() {
        if (!open) return;
        open = false;
        unsubscribe?.();
        unsubscribe = null;
        if (data.deviceId) {
          const n = (liveDevices.get(data.deviceId) ?? 1) - 1;
          if (n > 0) liveDevices.set(data.deviceId, n);
          else liveDevices.delete(data.deviceId);
        }
      },
    };
  };

  const websocket: Bun.WebSocketHandler<WsData> = {
    open(ws) {
      ws.data.session = openEventSession(ws.data, (s) => ws.send(s));
    },
    message(ws, message) {
      ws.data.session?.message(String(message));
    },
    close(ws) {
      ws.data.session?.close();
      ws.data.session = null;
    },
  };

  const server = Bun.serve<WsData, Record<never, never>>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,
    fetch: makeFetch(app, "local"),
    websocket,
  });

  remote.attach({ fetch: makeFetch(remoteApp, "remote"), websocket });
  relay.attach({
    fetch: (req) => remoteApp.fetch(req),
    openEvents: (url, headers, send) => {
      const data = authorizeEventSocket(url, headers);
      return data ? openEventSession(data, send) : null;
    },
  });
  remote.apply(store.settings.get().remote);

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
    });
  const ready: ReadyLine = { ok: true, port, pid: process.pid, version: config.version };
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
    notifier,
    relay,
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
      unsubscribeAuthRelay();
      unsubscribeCloud();
      relay.stop();
      notifier.stop();
      runs.abortAll();
      jobs.cancelAll();
      await mcp.closeAll();
      projects.close();
      (services as { dispose?: () => void }).dispose?.();
      await new Promise((r) => setTimeout(r, 30));
      remote.stop();
      server.stop(true);
      if (!opts.noHandshake) await removeHandshake(config.handshakePath);
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

/** No Origin (a native client), or the listener's own — never a page on some other host. */
export function originAllowedRemote(origin: string | null, listenerHost: string): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === listenerHost;
  } catch {
    return false;
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

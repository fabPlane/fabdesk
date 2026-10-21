/** `fabdesk-core serve`: bind, write the handshake, print the ReadyLine, run until told to stop. */
import { AGENT_OWNER_DIR, recoverAgentProcesses, stopAgentProcess } from "@fabdesk/agents";
import { chmod, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonHandshake, DoctorReport, ReadyLine, Settings } from "@fabdesk/protocol";
import { usageArchiveAllowed } from "@fabdesk/protocol";
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
import { resolvePrivacyStatus } from "./privacy-gate";
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
import { createCloudService, storedCredentialToken } from "./cloud";
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
import { RunTelemetry } from "./run-telemetry";
import { buildInfo } from "./build-info";
import { ArchiveConsentRevokedError, UsageArchive } from "./usage-archive";
import { UsageApiArchiveWriter } from "./usage-api";

/** Delay before retrying a failed usage-archive backfill (rate or daily limits, an outage). */
const BACKFILL_RETRY_MS = 30 * 60_000;

export type ExperimentalAgentInterface = "substrate" | "programmable";

export function configuredAgentInterface(
  env: NodeJS.ProcessEnv = process.env,
): ExperimentalAgentInterface | undefined {
  const value = env["FABDESK_AGENT_INTERFACE"];
  return value === "substrate" || value === "programmable" ? value : undefined;
}

/** The control clears direct authoring IPC; Condition A receives the attested bridge URL. */
export function agentBridgeEnvironment(
  mode: ExperimentalAgentInterface | undefined,
  bridgeUrl: string | undefined,
): Record<string, string> {
  if (mode === "substrate") return { FABDESK_FP_PCB_BRIDGE_URL: "" };
  return bridgeUrl ? { FABDESK_FP_PCB_BRIDGE_URL: bridgeUrl } : {};
}

/** Both experiment arms keep the promoted MCP inventory empty. */
export function agentMcpProfile(
  mode: ExperimentalAgentInterface | undefined,
): "substrate" | undefined {
  return mode ? "substrate" : undefined;
}

export type ServeOptions = {
  /** Tests: simulate an orphan that cannot be stopped. */
  recoveryStop?: (pid: number) => void | Promise<void>;
  recoveryWaitMs?: number;
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
  /** Tests: shorten how long `POST /threads/:id/abort` waits for the run to end. */
  abortSettleTimeoutMs?: number;
  /** Tests: the bearer the relay link presents, when the AuthFacade has none (local auth mode). */
  relayToken?: () => string | null;
  /** Tests: the env the default relay is derived from (`FABPLANE_RELAY_URL`); `process.env` otherwise. */
  relayEnv?: NodeJS.ProcessEnv;
  /** Tests: capture the relay discovery probe (`GET <api>/v1/config`). */
  relayDiscoveryFetch?: typeof fetch;
  /** Tests: inject a speech service with a fake provider. */
  speech?: import("./speech").SpeechService;
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
  const ownerDir = join(config.home, "agent-processes");
  const orphanAgents = await recoverAgentProcesses(
    ownerDir,
    opts.recoveryStop ?? stopAgentProcess,
    { ...(opts.recoveryWaitMs !== undefined ? { waitMs: opts.recoveryWaitMs } : {}) },
  );
  if (orphanAgents.recovered)
    logger.warn("stopped orphan agent writers after core crash", { count: orphanAgents.recovered });
  const store = Store.open(config.dbPath);
  await applyErrorReporting(store.settings.get().errorReporting);
  // Direct serve has no single-instance lock. Never mutate another live core's runs;
  // legacy ownership records cannot map individual records to run IDs.
  const stale = orphanAgents.liveOwners.length ? 0 : store.jobs.failStale();
  if (stale) logger.info("failed stale jobs from previous run", { count: stale });
  const staleRuns = orphanAgents.liveOwners.length ? [] : store.runs.failStale();
  if (staleRuns.length) {
    logger.info("failed stale agent runs from previous run", { threads: staleRuns });
    for (const threadId of staleRuns) {
      const run = store.runs.latestForThread(threadId);
      store.threads.addMessage({
        threadId,
        role: "assistant",
        contentMd:
          "The core restarted during this run. This run failed. " +
          (orphanAgents.failures.length
            ? `Agent recovery needs attention: ${orphanAgents.failures.join("; ")}. A surviving writer may prevent resume.`
            : "The thread can be resumed."),
        ...(run ? { runId: run.id } : {}),
      });
    }
  }
  const staleRoutes = orphanAgents.liveOwners.length ? 0 : store.routeRuns.failStale();
  if (staleRoutes) logger.info("failed stale route runs from previous run", { count: staleRoutes });
  const tokens = new TokenSet(config.token);
  const archiveDir = process.env["FABDESK_USAGE_ARCHIVE_DIR"]?.trim();
  const remoteArchiveEnabled = process.env["FABDESK_USAGE_REMOTE_BACKUP"] === "1";
  const archiveEnabled = Boolean(archiveDir) || remoteArchiveEnabled;
  const archives: UsageArchive[] = [];
  if (archiveDir) archives.push(new UsageArchive(archiveDir));
  let archiveBearer: () => string | null = () => null;
  if (remoteArchiveEnabled)
    archives.push(
      new UsageArchive(
        new UsageApiArchiveWriter(config.apiOrigin, () => archiveBearer(), store.settings),
      ),
    );
  const archiveDestinations = archives.map((archive) => archive.destination);
  let archiveClosing = false;
  let backfillTask: Promise<void> | null = null;
  let backfillRetry: ReturnType<typeof setTimeout> | null = null;
  const cancelBackfillRetry = () => {
    if (backfillRetry) clearTimeout(backfillRetry);
    backfillRetry = null;
  };
  const privacy = resolvePrivacyStatus({ settings: store.settings });
  logger.info("first-install privacy screen", {
    mode: privacy.mode,
    show: privacy.firstInstallScreen,
    signal: privacy.region.signal,
  });
  const hasArchiveConsent = () =>
    usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen);
  const startArchiveBackfill = (): Promise<void> => {
    if (backfillTask) return backfillTask;
    if (!archiveEnabled || !hasArchiveConsent() || archiveClosing) return Promise.resolve();
    cancelBackfillRetry();
    const task = (async () => {
      try {
        for (const archive of archives) {
          const counts = await archive.backfill(
            store.db,
            () => hasArchiveConsent() && !archiveClosing,
          );
          logger.info("usage archive backfilled", counts);
        }
      } catch (error) {
        if (error instanceof ArchiveConsentRevokedError || archiveClosing) return;
        // Usually a rate or daily limit; dumps not yet backed up remain local until accepted.
        logger.warn("usage archive backfill failed; retrying later", {
          error: errMsg(error),
          retryInMs: BACKFILL_RETRY_MS,
        });
        backfillRetry = setTimeout(() => {
          backfillRetry = null;
          void startArchiveBackfill();
        }, BACKFILL_RETRY_MS);
        backfillRetry.unref?.();
      }
    })();
    backfillTask = task;
    void task.finally(() => {
      backfillTask = null;
    });
    return task;
  };
  const archiveTasks = new Set<Promise<void>>();
  let lastArchiveConsent = hasArchiveConsent();
  const telemetry = new RunTelemetry({
    version: config.version,
    build: buildInfo(),
    dumpDirectory: join(config.home, "run-dumps"),
    runDumps: archiveEnabled
      ? {
          begin: (runId, capture) => store.runDumps.begin(runId, capture, hasArchiveConsent() ? archiveDestinations : []),
          end: (runId) => store.runDumps.end(runId),
          put(dump) {
            const consent = hasArchiveConsent();
            // Save locally first so a slow or retrying upload never delays the local copy. While
            // backup is consented, retention keeps pending dumps until every destination accepts
            // the complete record. Large dumps are small SQLite references to immutable files.
            store.runDumps.put(dump, consent ? archiveDestinations : []);
            if (!consent || archiveClosing) return;
            const task = (async () => {
              // The local dump is durable before agent.done; network delivery runs independently.
              for (const archive of archives) {
                try {
                  await archive.put(dump, store.db, hasArchiveConsent);
                } catch (error) {
                  if (error instanceof ArchiveConsentRevokedError) continue;
                  logger.warn("usage archive failed; retained run dump locally", {
                    runId: dump.runId,
                    error: errMsg(error),
                  });
                  if (!backfillRetry && !archiveClosing) {
                    backfillRetry = setTimeout(() => {
                      backfillRetry = null;
                      void startArchiveBackfill();
                    }, BACKFILL_RETRY_MS);
                    backfillRetry.unref?.();
                  }
                }
              }
            })().finally(() => archiveTasks.delete(task));
            archiveTasks.add(task);
          },
        }
      : store.runDumps,
  });
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
  archiveBearer = () => auth.token();
  // In the background: a large history over a slow link must not hold the daemon's startup.
  if (hasArchiveConsent()) void startArchiveBackfill();
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

  // fabplane.com carts and inventory (`shopping` tools, `/cloud` routes); tests may inject their own.
  const storedToken =
    auth.mode === "local"
      ? storedCredentialToken({ home: config.home, apiOrigin: config.apiOrigin })
      : () => null;
  services.cloud ??= createCloudService({
    apiOrigin: config.apiOrigin,
    token: () => auth.token() ?? storedToken(),
    settings: () => store.settings.get(),
  });
  if (!services.routers) {
    const { createRouterRegistry, FREEROUTING_VERSION } = await import("@fabdesk/tools");
    const { existsSync } = await import("node:fs");
    services.routers = createRouterRegistry({
      home: config.home,
      settings: () => store.settings.get(),
      bundled: {
        fab_router: { version: "bundled" },
        ...(process.env["FREEROUTING_JAR"] && existsSync(process.env["FREEROUTING_JAR"])
          ? { freerouting: { version: FREEROUTING_VERSION, path: process.env["FREEROUTING_JAR"] } }
          : {}),
      },
    });
  }

  const registry = createRegistry({ channel: config.channel });
  const ctxFactory = createContextFactory({ services, projects, tokens, telemetry });
  const mcp = new McpSessionManager({
    registry,
    ctxFactory,
    version: config.version,
    userInput: {
      enabledFor: (token) => runs.isActiveRunToken(token),
      handle: (token, req, signal) => runs.requestUserInput(token, req, signal),
    },
    permissionPrompt: {
      enabledFor: (token) => runs.isSupervisedRunToken(token),
      handle: (token, req) => runs.permissionPrompt(token, req),
    },
  });

  const adapters = opts.adapters ?? (await loadAdapters());
  const agentInterface = configuredAgentInterface();
  let mcpUrl = "";
  const runs = new AgentRunManager({
    store,
    emit: (e) => bus.emit(e),
    tokens,
    get mcpUrl() {
      return mcpUrl;
    },
    ...(agentMcpProfile(agentInterface) ? { mcpProfile: agentMcpProfile(agentInterface)! } : {}),
    adapters,
    settings: () => store.settings.get(),
    workspaceDir: join(config.home, "workspace"),
    telemetry,
    agentEnvironment: async ({ cwd, project }) => {
      const [cli, design] = await Promise.all([
        services.kicad.resolveCli().catch(() => null),
        services.design.status(),
      ]);
      return {
        [AGENT_OWNER_DIR]: ownerDir,
        FABDESK_PROJECT_DIR: cwd,
        ...(mcpUrl ? { FABDESK_CORE_URL: new URL(mcpUrl).origin } : {}),
        ...(project
          ? {
              FABDESK_KICAD_PROJECT: join(project.dir, "board.kicad_pro"),
              FABDESK_KICAD_SCHEMATIC: join(project.dir, "board.kicad_sch"),
              FABDESK_KICAD_BOARD: join(project.dir, "board.kicad_pcb"),
            }
          : {}),
        ...(cli ? { KICAD_CLI: cli.path } : {}),
        ...agentBridgeEnvironment(agentInterface, design.url),
      };
    },
    // Only fabdesk's own tools have annotations the classifier trusts; another server's tool is a write.
    annotationsFor: (tool, server) =>
      server === null || server === "fabdesk" ? registry.get(tool)?.annotations : undefined,
    resolveProject: (id) => projects.handle(id),
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.abortSettleTimeoutMs !== undefined
      ? { abortSettleTimeoutMs: opts.abortSettleTimeoutMs }
      : {}),
    prepareProject: async (project: ProjectHandle) => {
      const agents = await import("@fabdesk/agents");
      const sketches = (await projects.listFiles(join(project.dir, "sketches")))
        .filter((f) => /\.(png|jpe?g)$/i.test(f.path))
        .map((f) => join(project.dir, "sketches", f.path));
      const board = project.manifest().board;
      const cli = await services.kicad.resolveCli().catch(() => null);
      await agents.writeAgentDocs(project.dir, {
        projectName: project.name,
        toolsMarkdown: toolsMarkdown(registry),
        ...(cli ? { kicadCli: cli.path } : {}),
        shellExecutables: Object.fromEntries(
          ["python3", "rg", "bun"].flatMap((name) => {
            const path = Bun.which(name);
            return path ? [[name, path]] : [];
          }),
        ),
        sketches,
        board: {
          layers: board.layers,
          ...(board.widthMm !== undefined ? { widthMm: board.widthMm } : {}),
          ...(board.heightMm !== undefined ? { heightMm: board.heightMm } : {}),
          ...(board.template !== undefined ? { template: board.template } : {}),
        },
        mcpServerName: agents.MCP_SERVER_NAME,
        ...(agentInterface ? { interfaceMode: agentInterface } : {}),
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
    privacy: () => privacy,
    onSettingsChanged: () => {
      void cloudSettings.push();
      const consent = hasArchiveConsent();
      if (consent && !lastArchiveConsent) {
        // Let a cancelled backfill settle before starting the new consent period's backfill.
        void (backfillTask ?? Promise.resolve()).then(() => startArchiveBackfill());
      }
      if (!consent && lastArchiveConsent) {
        cancelBackfillRetry();
        for (const archive of archives) archive.cancelPending();
      }
      lastArchiveConsent = consent;
    },
    ...(opts.speech ? { speech: opts.speech } : {}),
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
      if (!(await runs.settleAll())) logger.warn("agent runs did not stop before shutdown timeout");
      await mcp.closeAll();
      projects.close();
      // Releasing the design sessions stops their KiCad processes on the bridge; give it a moment.
      await Promise.race([
        Promise.resolve((services as { dispose?: () => Promise<void> | void }).dispose?.()).catch(
          () => undefined,
        ),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
      await new Promise((r) => setTimeout(r, 30));
      remote.stop();
      server.stop(true);
      if (!opts.noHandshake) await removeHandshake(config.handshakePath);
      // Stop uploads first so a retry wait cannot hold shutdown; unsent dumps stay for the next backfill.
      archiveClosing = true;
      cancelBackfillRetry();
      for (const archive of archives) archive.close();
      await telemetry.shutdown();
      await backfillTask;
      await Promise.allSettled([...archiveTasks]);
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
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
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

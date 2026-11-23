/**
 * `fabdesk-core mcp`: stdio MCP server. Proxies to a live daemon (from daemon.json) so the GUI sees
 * the activity; otherwise `--standalone` runs the registry in-process.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { DaemonHandshake } from "@fabdesk/protocol";
import {
  attachToRegistry,
  clientSupportsApps,
  createRegistry,
  FABDESK_SERVER_ICONS,
  MCP_CLIENT_META,
  type McpClientHint,
  type ProjectHandle,
} from "@fabdesk/tools";
import { locateAppBridgeFile } from "./app-bridge";
import { TokenSet } from "./auth";
import { createAuth } from "./auth-facade";
import { createCloudService, storedCredentialToken } from "./cloud";
import { EventBus } from "./bus";
import { resolveConfig } from "./config";
import { createContextFactory } from "./context";
import { Store } from "./db";
import { logger, errMsg } from "./log";
import {
  applyStartToolsets,
  boardWorkflowInstructions,
  DURABLE_WAIT_MAX_MS,
  durableWaitForClient,
  INSTRUCTIONS,
  projectStartToolsets,
  registerBoardWorkflowDocs,
  startOptionsFor,
} from "./mcp-sessions";
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from "./mcp-limits";
import { ProjectStore } from "./projects";
import { pidAlive } from "./serve";

export type McpStdioOptions = {
  standalone?: boolean;
  project?: string;
  dataDir?: string;
  /** Always list the MCP Apps views (Codex / ChatGPT plugin). Default: only for clients that advertise MCP Apps. */
  apps?: boolean;
  /**
   * The host's per-call tool timeout in seconds, when it was raised (Codex `tool_timeout_sec`). Board jobs then wait just
   * under it before returning a job id; unknown, they wait 50 s for hosts other than Claude Code (`durableWaitForClient`).
   */
  toolTimeoutSec?: number;
};

export async function readHandshake(path: string): Promise<DaemonHandshake | null> {
  try {
    const parsed = DaemonHandshake.safeParse(JSON.parse(await Bun.file(path).text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function findLiveDaemon(path: string): Promise<DaemonHandshake | null> {
  const hs = await readHandshake(path);
  if (!hs || !pidAlive(hs.pid)) return null;
  try {
    const res = await fetch(`http://${hs.host}:${hs.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const health = (await res.json()) as { runtimeId?: string | null };
    if (hs.runtimeId && health.runtimeId !== hs.runtimeId) return null;
    const auth = await fetch(`http://${hs.host}:${hs.port}/settings`, {
      headers: { authorization: `Bearer ${hs.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return auth.status === 200 ? hs : null;
  } catch {
    return null;
  }
}

/** A project directory given explicitly, or the cwd when it holds fabdesk.json. */
function detectProjectDir(explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  const cwd = process.cwd();
  return existsSync(join(cwd, "fabdesk.json")) ? cwd : null;
}

export async function runMcpStdio(opts: McpStdioOptions = {}): Promise<void> {
  const config = resolveConfig({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  const projectDir = detectProjectDir(opts.project);
  if (!opts.standalone) {
    const hs = await findLiveDaemon(config.handshakePath);
    if (hs) {
      logger.info("proxying stdio MCP to the running daemon", { port: hs.port, pid: hs.pid });
      await proxyToDaemon(hs, projectDir, opts.apps === true, opts.toolTimeoutSec);
      return;
    }
    logger.info("no live daemon; running standalone MCP server");
  }
  await standalone(opts, projectDir);
}

/** Generic JSON-RPC proxy: every request/notification is forwarded verbatim in both directions. */
async function proxyToDaemon(
  hs: DaemonHandshake,
  projectDir: string | null,
  apps: boolean,
  toolTimeoutSec?: number,
): Promise<void> {
  type Upstream = { client: Client; transport: StreamableHTTPClientTransport };
  let server: Server | null = null;
  const open = async (withApps: boolean): Promise<Upstream> => {
    const client = new Client(
      { name: "fabdesk-core-stdio", version: hs.version },
      { capabilities: {} },
    );
    // The daemon sees this proxy's capabilities, not the host's, so MCP Apps are requested explicitly.
    const url = new URL(`http://${hs.host}:${hs.port}/mcp`);
    if (withApps) url.searchParams.set("apps", "on");
    // The daemon starts the session as a desktop run on this project would (the board toolset for a placed board).
    if (projectDir) url.searchParams.set("project", projectDir);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${hs.token}` } },
    });
    await client.connect(transport as unknown as Transport);
    client.fallbackNotificationHandler = async (n) => {
      await server
        ?.notification({ method: n.method, ...(n.params ? { params: n.params } : {}) } as never)
        .catch(() => {});
    };
    client.onclose = () => {
      logger.info("daemon connection closed; exiting");
      void (server?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    };
    return { client, transport };
  };
  let upstream = await open(apps);
  // A host that advertises MCP Apps (known only after its initialize) gets a session with the views.
  let ready: Promise<void> = Promise.resolve();
  const remoteCaps = upstream.client.getServerCapabilities() ?? {};
  server = new Server(
    { name: "fabdesk", title: "fabPlane", version: hs.version, icons: FABDESK_SERVER_ICONS },
    { capabilities: remoteCaps, instructions: upstream.client.getInstructions() ?? INSTRUCTIONS },
  );
  const downstream = server;
  downstream.oninitialized = () => {
    if (apps || !clientSupportsApps(downstream.getClientCapabilities())) return;
    ready = (async () => {
      const previous = upstream;
      upstream = await open(true);
      previous.client.onclose = () => {};
      await previous.transport.terminateSession().catch(() => {});
      await previous.client.close().catch(() => {});
    })().catch((e) => logger.warn("MCP Apps session failed; keeping the plain one", { error: errMsg(e) }));
  };
  forwardRequests(downstream, async () => {
    await ready;
    return upstream.client;
  }, {
    projectDir,
    ...(toolTimeoutSec ? { toolTimeoutSec } : {}),
  });
  downstream.fallbackNotificationHandler = async (n) => {
    await ready;
    await upstream.client
      .notification({ method: n.method, ...(n.params ? { params: n.params } : {}) } as never)
      .catch(() => {});
  };
  const stdio = new StdioServerTransport();
  await downstream.connect(stdio);
  await new Promise<void>((resolveDone) => {
    stdio.onclose = () => resolveDone();
    // The SDK transport does not report stdin EOF, which is how hosts disconnect.
    process.stdin.once("end", () => resolveDone());
  });
  await ready;
  // Free the daemon-side session so the parent watchdog does not see a phantom MCP client.
  upstream.client.onclose = () => {};
  await upstream.transport.terminateSession().catch(() => {});
  await upstream.client.close().catch(() => {});
}

/** Margin over the daemon's durable wait for the reply (the job id or result) to reach the proxy. */
const PROXY_REPLY_MARGIN_MS = 2 * 60_000;

/**
 * How long the proxy waits for the daemon's reply to one request, between progress notifications (each one resets it).
 * A tools/call waits as long as the daemon's durable wait for this host (`durableWaitForClient`, the same hint the daemon
 * gets; 25 min for Claude Code) plus a margin, and at least the host's declared timeout; anything else keeps the SDK's 60 s.
 * The SDK default alone would cut every board call at 60 s with -32001 before the daemon returned the job id.
 */
export function proxyRequestTimeoutMs(method: string, hint: McpClientHint | undefined): number {
  if (method !== "tools/call") return DEFAULT_REQUEST_TIMEOUT_MSEC;
  const wait = durableWaitForClient(hint) ?? DURABLE_WAIT_MAX_MS;
  return Math.max(DEFAULT_REQUEST_TIMEOUT_MSEC, wait + PROXY_REPLY_MARGIN_MS, (hint?.toolTimeoutSec ?? 0) * 1000);
}

export type ForwardOptions = {
  projectDir: string | null;
  toolTimeoutSec?: number;
  /** Override of `proxyRequestTimeoutMs` (tests). */
  timeoutMs?: (method: string, hint: McpClientHint | undefined) => number;
};

/**
 * Relays every host request the downstream server does not handle itself to the upstream (daemon) client: the detected
 * project and the host's name are added to tool calls, progress comes back under the host's own progressToken (the SDK
 * replaces it upstream with its message id, so tokens never clash), the host's cancellation aborts the upstream request,
 * and the timeout is the session's durable wait plus a margin, reset by each progress notification.
 */
export function forwardRequests(downstream: Server, upstream: () => Promise<Client>, opts: ForwardOptions): void {
  const Any = z.looseObject({});
  downstream.fallbackRequestHandler = async (request, extra) => {
    const client = await upstream();
    const params = { ...((request.params as Record<string, unknown> | undefined) ?? {}) };
    const meta = { ...((params["_meta"] as Record<string, unknown> | undefined) ?? {}) };
    const hostToken = meta["progressToken"] as string | number | undefined;
    delete meta["progressToken"];
    let hint: McpClientHint | undefined;
    if (request.method === "tools/call") {
      // Inject the detected project when a tool call omits it.
      if (opts.projectDir) {
        const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {};
        if (args["project"] === undefined) params["arguments"] = { ...args, project: opts.projectDir };
      }
      // The daemon sees this proxy, not the host: name the host so board jobs wait within its tool timeout.
      const host = downstream.getClientVersion();
      hint = {
        ...(host?.name ? { name: host.name } : {}),
        ...(host?.version ? { version: host.version } : {}),
        ...(opts.toolTimeoutSec ? { toolTimeoutSec: opts.toolTimeoutSec } : {}),
      };
      meta[MCP_CLIENT_META] = hint;
    }
    if (Object.keys(meta).length) params["_meta"] = meta;
    else delete params["_meta"];
    return client.request({ method: request.method, params }, Any as never, {
      timeout: (opts.timeoutMs ?? proxyRequestTimeoutMs)(request.method, hint),
      resetTimeoutOnProgress: true,
      signal: extra.signal,
      // Always registered, so the daemon heartbeats and the timeout resets; relayed only when the host asked for progress.
      onprogress: (progress) => {
        if (hostToken === undefined) return;
        void extra
          .sendNotification({ method: "notifications/progress", params: { ...progress, progressToken: hostToken } })
          .catch(() => {});
      },
    }) as never;
  };
}

async function standalone(opts: McpStdioOptions, projectDir: string | null): Promise<void> {
  const config = resolveConfig({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  await mkdir(config.home, { recursive: true });
  const bus = new EventBus();
  const store = Store.open(config.dbPath);
  const auth = await createAuth({
    mode: config.authMode,
    channel: config.channel,
    home: config.home,
    apiOrigin: config.apiOrigin,
    emit: () => {},
  });
  const projects = new ProjectStore(store.projects, config.projectsDir, (e) => bus.emit(e), {
    watch: false,
  });
  await projects.init();
  // Standalone: persist route frames under FABDESK_HOME/cinema too so the GUI can replay them later.
  bus.subscribe(["route.*"], (events) => {
    for (const ev of events) {
      const e = ev.event;
      const runId =
        e.topic === "route.meta"
          ? e.meta.runId
          : e.topic === "route.static"
            ? e.static.runId
            : e.topic === "route.frame"
              ? e.frame.runId
              : e.topic === "route.done"
                ? e.result.runId
                : null;
      if (!runId) continue;
      const line =
        JSON.stringify(
          e.topic === "route.done"
            ? { kind: "result", runId, result: e.result }
            : e.topic === "route.meta"
              ? e.meta
              : e.topic === "route.static"
                ? e.static
                : e.topic === "route.frame"
                  ? e.frame
                  : e,
        ) + "\n";
      const path = join(config.home, "cinema", `${runId}.jsonl`);
      void mkdir(join(config.home, "cinema"), { recursive: true })
        .then(() =>
          Bun.file(path)
            .exists()
            .then(async (ex) => {
              const prev = ex ? await Bun.file(path).text() : "";
              await Bun.write(path, prev + line);
            }),
        )
        .catch(() => {});
    }
  });
  const { createServices } = await import("./services");
  const services = await createServices({
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
  });
  const storedToken =
    auth.mode === "local"
      ? storedCredentialToken({ home: config.home, apiOrigin: config.apiOrigin })
      : () => null;
  services.cloud = createCloudService({
    apiOrigin: config.apiOrigin,
    token: () => auth.token() ?? storedToken(),
    settings: () => store.settings.get(),
  });
  const registry = createRegistry({ channel: config.channel });
  let defaultProject: ProjectHandle | null = null;
  if (projectDir) {
    defaultProject = await projects.resolve(projectDir);
    if (!defaultProject)
      logger.warn("project directory has no fabdesk.json; tools need an explicit `project`", {
        projectDir,
      });
  }
  const ctxFactory = createContextFactory({
    services,
    projects,
    tokens: new TokenSet(config.token),
    defaultProject: async () => defaultProject,
  });
  // The start set and instructions a daemon session on this project gets (mcp-sessions).
  const start = new URLSearchParams();
  applyStartToolsets(start, await projectStartToolsets(registry, defaultProject));
  const boardDocs = registry.get("board_check") !== undefined;
  const server = new McpServer(
    { name: "fabdesk", title: "fabPlane", version: config.version, icons: FABDESK_SERVER_ICONS },
    {
      instructions:
        INSTRUCTIONS + (boardDocs ? boardWorkflowInstructions({ listed: start.get("start") === "board" }) : ""),
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
    },
  );
  attachToRegistry(server, registry, ctxFactory, {
    ...startOptionsFor(start, registry),
    apps: opts.apps ? "on" : "auto",
    durableWaitMs: (client) =>
      durableWaitForClient(client, { ...(opts.toolTimeoutSec ? { toolTimeoutSec: opts.toolTimeoutSec } : {}) }),
  });
  if (boardDocs) registerBoardWorkflowDocs(server);
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  await new Promise<void>((resolveDone) => {
    stdio.onclose = () => resolveDone();
  });
  try {
    services.dispose();
    store.close();
  } catch (e) {
    logger.warn("cleanup failed", { error: errMsg(e) });
  }
}

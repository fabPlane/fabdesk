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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { DaemonHandshake } from "@fabdesk/protocol";
import { attachToRegistry, createRegistry, type ProjectHandle } from "@fabdesk/tools";
import { locateAppBridgeFile } from "./app-bridge";
import { TokenSet } from "./auth";
import { createAuth } from "./auth-facade";
import { createCloudService, storedCredentialToken } from "./cloud";
import { EventBus } from "./bus";
import { resolveConfig } from "./config";
import { createContextFactory } from "./context";
import { Store } from "./db";
import { logger, errMsg } from "./log";
import { INSTRUCTIONS } from "./mcp-sessions";
import { ProjectStore } from "./projects";
import { pidAlive } from "./serve";

export type McpStdioOptions = { standalone?: boolean; project?: string; dataDir?: string };

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
      await proxyToDaemon(hs, projectDir);
      return;
    }
    logger.info("no live daemon; running standalone MCP server");
  }
  await standalone(opts, projectDir);
}

/** Generic JSON-RPC proxy: every request/notification is forwarded verbatim in both directions. */
async function proxyToDaemon(hs: DaemonHandshake, projectDir: string | null): Promise<void> {
  const client = new Client(
    { name: "fabdesk-core-stdio", version: hs.version },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://${hs.host}:${hs.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${hs.token}` } },
  });
  await client.connect(transport as unknown as Transport);
  const remoteCaps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name: "fabdesk", version: hs.version },
    { capabilities: remoteCaps, instructions: client.getInstructions() ?? INSTRUCTIONS },
  );
  const Any = z.looseObject({});
  server.fallbackRequestHandler = async (request) => {
    const params = { ...((request.params as Record<string, unknown> | undefined) ?? {}) };
    // Inject the detected project when a tool call omits it.
    if (request.method === "tools/call" && projectDir) {
      const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {};
      if (args["project"] === undefined) params["arguments"] = { ...args, project: projectDir };
    }
    return client.request({ method: request.method, params }, Any as never);
  };
  server.fallbackNotificationHandler = async (n) => {
    await client
      .notification({ method: n.method, ...(n.params ? { params: n.params } : {}) } as never)
      .catch(() => {});
  };
  client.fallbackNotificationHandler = async (n) => {
    await server
      .notification({ method: n.method, ...(n.params ? { params: n.params } : {}) } as never)
      .catch(() => {});
  };
  client.onclose = () => {
    logger.info("daemon connection closed; exiting");
    void server.close().finally(() => process.exit(0));
  };
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  await new Promise<void>((resolveDone) => {
    stdio.onclose = () => resolveDone();
  });
  // Free the daemon-side session so the parent watchdog does not see a phantom MCP client.
  await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
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
    auth.mode === "local" ? storedCredentialToken({ home: config.home, apiOrigin: config.apiOrigin }) : () => null;
  services.cloud = createCloudService({
    apiOrigin: config.apiOrigin,
    token: () => auth.token() ?? storedToken(),
    settings: () => store.settings.get(),
  });
  const registry = createRegistry();
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
  const server = new McpServer(
    { name: "fabdesk", version: config.version },
    { instructions: INSTRUCTIONS },
  );
  attachToRegistry(server, registry, ctxFactory);
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

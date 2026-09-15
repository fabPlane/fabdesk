/**
 * Streamable-HTTP MCP sessions: one McpServer + transport per `mcp-session-id`, so `load_toolset`
 * state is per connected agent. DNS-rebinding protection is on (host allowlist bound to our port).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { attachToRegistry, TOOLSETS, type ContextFactory, type ToolRegistry } from "@fabdesk/tools";
import { logger, errMsg } from "./log";

type Session = {
  id: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  token: string | null;
};

export const NATIVE_AGENT_TOOLS = [
  "pcb_environment", "project_status", "circuit_search_parts", "circuit_describe_part", "schematic_inspect", "schematic_edit",
  "pcb_update_from_schematic", "pcb_inspect", "pcb_place", "pcb_edit_copper", "pcb_edit_graphics",
  "route_run", "verify_erc", "verify_drc", "schematic_review", "render_view", "release_build",
] as const;

export const NATIVE_CAPABILITY_EXCLUDE = [
  "circuit_build", "circuit_read_errors", "load_toolset",
] as const;

export type McpSessionOptions = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  version: string;
  /** Hosts accepted in the `Host` header (DNS rebinding protection). Set after bind. */
  allowedHosts?: string[];
  idleMs?: number;
};

export class McpSessionManager {
  private readonly sessions = new Map<string, Session>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  allowedHosts: string[];

  constructor(private readonly opts: McpSessionOptions) {
    this.allowedHosts = opts.allowedHosts ?? [];
    const idle = opts.idleMs ?? 60 * 60_000;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - idle;
      for (const s of this.sessions.values()) if (s.lastSeen < cutoff) void this.close(s.id);
    }, 60_000);
    if (typeof this.sweeper === "object" && "unref" in this.sweeper) this.sweeper.unref();
  }

  /** Sessions total, or only those with traffic in the last `withinMs`. */
  activeCount(opts: { withinMs?: number } = {}): number {
    if (opts.withinMs === undefined) return this.sessions.size;
    const cutoff = Date.now() - opts.withinMs;
    let n = 0;
    for (const s of this.sessions.values()) if (s.lastSeen >= cutoff) n++;
    return n;
  }

  list(): Array<{ id: string; createdAt: string; lastSeen: string }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeen: new Date(s.lastSeen).toISOString(),
    }));
  }

  async handle(req: Request, opts: { token?: string | null } = {}): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (!s)
        return json(404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
      s.lastSeen = Date.now();
      return s.transport.handleRequest(
        req,
        opts.token ? { authInfo: { token: opts.token, clientId: "fabdesk", scopes: [] } } : {},
      );
    }
    if (req.method !== "POST")
      return json(400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id header required" },
        id: null,
      });
    // New session: the transport validates that the body is an initialize request.
    const server = new McpServer(
      { name: "fabdesk", version: this.opts.version },
      { instructions: INSTRUCTIONS },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableDnsRebindingProtection: this.allowedHosts.length > 0,
      ...(this.allowedHosts.length > 0 ? { allowedHosts: this.allowedHosts } : {}),
      onsessioninitialized: (id) => {
        this.sessions.set(id, {
          id,
          server,
          transport,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          token: opts.token ?? null,
        });
        logger.info("mcp session opened", { id });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        logger.info("mcp session closed", { id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    // Codex snapshots MCP tools when a turn starts and currently ignores tools/list_changed.
    // Let clients that cannot refresh opt into the complete inventory at initialization.
    const query = new URL(req.url).searchParams;
    const initialToolsets = query.get("toolsets") === "all" ? [...TOOLSETS] : undefined;
    const initialTools = query.get("profile") === "native" ? [...NATIVE_AGENT_TOOLS] : undefined;
    attachToRegistry(server, this.opts.registry, this.opts.ctxFactory, {
      ...(initialToolsets ? { initialToolsets } : {}),
      ...(initialTools ? { initialTools } : {}),
      ...(query.get("profile") === "native" ? { capabilityExclude: [...NATIVE_CAPABILITY_EXCLUDE] } : {}),
    });
    await server.connect(transport);
    return transport.handleRequest(
      req,
      opts.token ? { authInfo: { token: opts.token, clientId: "fabdesk", scopes: [] } } : {},
    );
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.transport
      .close()
      .catch((e) => logger.warn("mcp transport close failed", { error: errMsg(e) }));
    await s.server.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const INSTRUCTIONS = "Project-scoped tools use the selected project unless `project` is supplied.";

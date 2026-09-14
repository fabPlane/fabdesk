/**
 * Streamable-HTTP MCP sessions: one McpServer + transport per `mcp-session-id`, so `load_toolset`
 * state is per connected agent. DNS-rebinding protection is on (host allowlist bound to our port).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod/v4";
import { attachToRegistry, TOOLSETS, type ContextFactory, type ToolRegistry } from "@fabdesk/tools";
import { PERMISSION_PROMPT_TOOL } from "@fabdesk/agents";
import type { PermissionPromptResult } from "./agent-runs";
import { logger, errMsg } from "./log";

type Session = {
  id: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  token: string | null;
};

export type McpSessionOptions = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  version: string;
  /** Hosts accepted in the `Host` header (DNS rebinding protection). Set after bind. */
  allowedHosts?: string[];
  idleMs?: number;
  /**
   * Serves the `permission_prompt` tool Claude Code's `--permission-prompt-tool` calls in
   * supervised mode. Blocks until the daemon has a decision; absent, the tool is not registered.
   */
  permissionPrompt?: {
    /** Only sessions opened with a supervised run's token see the tool; the model must not find it in full mode. */
    enabledFor(token: string | null): boolean;
    handle(
      token: string | null,
      req: { toolName: string; input: unknown; toolUseId?: string },
    ): Promise<PermissionPromptResult>;
  };
};

/** Claude Code sends `{ tool_name, input, tool_use_id }`; the schema is what makes it "an MCP tool" to the CLI. */
const PERMISSION_PROMPT_INPUT = {
  tool_name: z.string(),
  input: z.unknown(),
  tool_use_id: z.string().optional(),
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
    const initialToolsets =
      new URL(req.url).searchParams.get("toolsets") === "all" ? [...TOOLSETS] : undefined;
    attachToRegistry(server, this.opts.registry, this.opts.ctxFactory, {
      ...(initialToolsets ? { initialToolsets } : {}),
    });
    const prompt = this.opts.permissionPrompt;
    if (prompt && prompt.enabledFor(opts.token ?? null))
      this.registerPermissionPrompt(server, (token, req) => prompt.handle(token, req));
    await server.connect(transport);
    return transport.handleRequest(
      req,
      opts.token ? { authInfo: { token: opts.token, clientId: "fabdesk", scopes: [] } } : {},
    );
  }

  /**
   * The reply has to be exactly one text block whose text is the JSON permission result; anything
   * else the CLI treats as a deny. The run token in the call's bearer is what ties the prompt to a
   * run, so the tool is registered per session but stateless.
   */
  private registerPermissionPrompt(
    server: McpServer,
    handler: NonNullable<McpSessionOptions["permissionPrompt"]>["handle"],
  ): void {
    server.registerTool(
      PERMISSION_PROMPT_TOOL,
      {
        title: "Permission prompt",
        description:
          "Internal: Claude Code asks the fabdesk daemon whether a tool call may run in supervised mode. Not for the model to call.",
        inputSchema: PERMISSION_PROMPT_INPUT as unknown as ZodRawShapeCompat,
        annotations: { title: "Permission prompt", readOnlyHint: true },
      },
      async (args: Record<string, unknown>, extra) => {
        let result: PermissionPromptResult;
        try {
          result = await handler(extra.authInfo?.token ?? null, {
            toolName: String(args["tool_name"] ?? ""),
            input: args["input"],
            ...(typeof args["tool_use_id"] === "string" ? { toolUseId: args["tool_use_id"] } : {}),
          });
        } catch (e) {
          logger.warn("permission prompt failed", { error: errMsg(e) });
          result = { behavior: "deny", message: `permission prompt failed: ${errMsg(e)}` };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
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

export const INSTRUCTIONS =
  "fabdesk designs PCBs from a netlist source (circuit.netlist.json) built into a KiCad project with a schematic and board. Start with project_status. Only the core toolset is loaded; call load_toolset to enable project/circuit/route/kicad/verify/render/export/sim tools. Typical flow: project_write_file circuit.netlist.json → circuit_build → circuit_read_errors → route_run → verify_drc with schematicParity=true → load verify and run verify_erc plus verify_gate with requireErc=true → render_board → load render and run render_schematic_svg plus render_pcb_svg. render_board creates PNG board images only; it does not populate the Schematic or PCB SVG tabs.";

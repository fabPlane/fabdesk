/**
 * Streamable-HTTP MCP sessions: one McpServer + transport per `mcp-session-id`, so `load_toolset`
 * state is per connected agent. DNS-rebinding protection is on (host allowlist bound to our port).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod/v4";
import {
  attachToRegistry,
  FABDESK_SERVER_ICONS,
  TOOLSETS,
  type ContextFactory,
  type McpAppsMode,
  type ToolRegistry,
} from "@fabdesk/tools";
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
/**
 * The complete inventory for clients that snapshot tools at turn start (Codex's `native` profile).
 * Both schematic authoring paths are listed, `schematic_edit` and `circuit_build`, so the agent
 * chooses between them rather than the profile choosing for it.
 */
export const NATIVE_AGENT_TOOLS = [
  "pcb_environment",
  "project_status",
  "circuit_search_parts",
  "circuit_describe_part",
  "circuit_build",
  "circuit_read_errors",
  "schematic_inspect",
  "schematic_edit",
  "pcb_update_from_schematic",
  "pcb_inspect",
  "pcb_place",
  "pcb_edit_copper",
  "pcb_edit_graphics",
  "route_run",
  "verify_erc",
  "verify_drc",
  "schematic_review",
  "render_view",
  "release_build",
] as const;

export const NATIVE_CAPABILITY_EXCLUDE = ["load_toolset"] as const;

/**
 * Toolsets every other client starts with besides `core`. `core` holds `circuit_build`; these hold
 * `schematic_edit` and the tools both paths share, so neither path waits behind `load_toolset`.
 */
export const DEFAULT_AGENT_TOOLSETS = ["circuit", "verify", "render"] as const;

export type McpSessionOptions = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  version: string;
  /** Hosts accepted in the `Host` header (DNS rebinding protection). Set after bind. */
  allowedHosts?: string[];
  idleMs?: number;
  userInput?: {
    enabledFor(token: string | null): boolean;
    handle(
      token: string | null,
      req: { question: string; options?: string[] },
      signal: AbortSignal,
    ): Promise<{ status: "answered" | "unanswered"; answer: string | null }>;
  };
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
    const userInput = this.opts.userInput;
    const canAsk = userInput?.enabledFor(opts.token ?? null) === true;
    const server = new McpServer(
      {
        name: "fabdesk",
        title: "fabPlane",
        version: this.opts.version,
        icons: FABDESK_SERVER_ICONS,
      },
      { instructions: INSTRUCTIONS + (canAsk ? USER_INPUT_INSTRUCTIONS : "") },
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
    const initialToolsets =
      query.get("toolsets") === "all" ? [...TOOLSETS] : [...DEFAULT_AGENT_TOOLSETS];
    const profile = query.get("profile");
    const initialTools =
      profile === "planning" ? ["request_project_creation"] : profile === "native" ? [...NATIVE_AGENT_TOOLS] : profile === "substrate" ? [] : undefined;
    // MCP Apps views: `auto` lists them for clients that advertise io.modelcontextprotocol/ui;
    // `?apps=on` forces them (stdio proxy started with --apps). The agent profiles never get them.
    const appsParam = query.get("apps");
    const apps: McpAppsMode =
      profile === "native" || profile === "substrate" || profile === "planning"
        ? "off"
        : appsParam === "on" || appsParam === "off"
          ? appsParam
          : "auto";
    attachToRegistry(server, this.opts.registry, this.opts.ctxFactory, {
      apps,
      ...(initialToolsets ? { initialToolsets } : {}),
      ...(initialTools ? { initialTools } : {}),
      ...(profile === "native" ? { capabilityExclude: [...NATIVE_CAPABILITY_EXCLUDE] } : {}),
      ...(profile === "substrate" ? { capabilities: false, toolsOnly: true } : {}),
      ...(profile === "planning" ? { capabilities: false, toolsOnly: true } : {}),
    });
    const prompt = this.opts.permissionPrompt;
    if (userInput && canAsk) {
      const sessionToken = opts.token ?? null;
      server.registerTool(
        "request_user_input",
        {
          title: "Ask a question",
          description:
            "Ask the user a question in the chat with clickable choices and a custom-answer field. Waits for their submitted answer. Use this instead of asking questions as plain text or guessing the user's choice. Ask one question at a time. If unanswered, stop dependent work and ask the user to resume; never treat it as consent or select a default.",
          inputSchema: {
            question: z.string().trim().min(1).max(2000),
            options: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
          } as unknown as ZodRawShapeCompat,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
            idempotentHint: false,
          },
        },
        async (args: Record<string, unknown>, extra) => {
          if (
            !sessionToken ||
            extra.authInfo?.token !== sessionToken ||
            !userInput.enabledFor(sessionToken)
          )
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "This question requires the original active chat run. Do not assume an answer.",
                },
              ],
            };
          const progressToken = extra._meta?.progressToken;
          let progress = 0;
          const heartbeat =
            progressToken === undefined
              ? null
              : setInterval(() => {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: ++progress,
                        message: "Waiting for the user's answer",
                      },
                    })
                    .catch(() => {});
                }, 15_000);
          try {
            const result = await userInput.handle(
              sessionToken,
              {
                question: String(args["question"]),
                ...(Array.isArray(args["options"]) ? { options: args["options"] as string[] } : {}),
              },
              extra.signal,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ...result,
                    ...(result.status === "unanswered"
                      ? {
                          instruction:
                            "No answer was received. Stop work that depends on this choice. Do not guess or treat this as consent.",
                        }
                      : {}),
                  }),
                },
              ],
            };
          } finally {
            if (heartbeat !== null) clearInterval(heartbeat);
          }
        },
      );
    }
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
        annotations: {
          title: "Permission prompt",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: false,
        },
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
  "Project-scoped tools use the selected project unless `project` is supplied.";

export const USER_INPUT_INSTRUCTIONS =
  " When you need the user's preference or clarification, use request_user_input to display an interactive question, rather than asking in prose. Supply concise options when useful; the UI always allows a custom answer. Wait for the submitted answer before doing work that depends on it. An unanswered or cancelled question is not permission to choose for the user.";

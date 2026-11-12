/**
 * Streamable-HTTP MCP sessions: one McpServer + transport per `mcp-session-id`, so `load_toolset`
 * state is per connected agent. DNS-rebinding protection is on (host allowlist bound to our port).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  attachToRegistry,
  FABDESK_SERVER_ICONS,
  projectHasPlacedBoard,
  TOOLSETS,
  type ToolsetId,
  type ContextFactory,
  type McpAppsMode,
  type McpClientHint,
  type ToolRegistry,
} from "@fabdesk/tools";
import { BOARD_WORKFLOW_MD, PERMISSION_PROMPT_TOOL } from "@fabdesk/agents";
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

/**
 * `toolsets=all`, or a comma list added to the defaults (`toolsets=board`): a run on a project that already
 * has a board starts with the board toolset instead of discovering it through `load_toolset`.
 */
export function initialToolsetsFor(param: string | null): ToolsetId[] {
  if (param === "all") return [...TOOLSETS];
  const extra = (param ?? "").split(",").filter((id): id is ToolsetId => (TOOLSETS as readonly string[]).includes(id));
  return TOOLSETS.filter((id) => (DEFAULT_AGENT_TOOLSETS as readonly string[]).includes(id) || extra.includes(id));
}

/**
 * The native profile (Codex) lists a fixed set at turn start and cannot load more; a toolset the project asks for
 * (`toolsets=board`, an existing placed board) is added to it, or that agent could never reach it.
 */
export function nativeToolsFor(toolsetsParam: string | null, registry: Pick<ToolRegistry, "byToolset">): string[] {
  const asked = initialToolsetsFor(toolsetsParam).filter((id) => !(DEFAULT_AGENT_TOOLSETS as readonly string[]).includes(id));
  return [...new Set([...NATIVE_AGENT_TOOLS, ...asked.flatMap((id) => registry.byToolset(id).map((t) => t.name))])];
}

/**
 * A run on a project that already has a placed board does not need the schematic-authoring tools (about 48k characters of
 * schemas) in front of it: it starts with the board-reading tools, verification, rendering and the `board` toolset. The
 * rest stays one `load_toolset` / `capability_search` away.
 *
 * The board-workflow stage tools (check, edit, route, review, release, silk) are in the `board` toolset, part of
 * BOARD_START_TOOLSETS; add a tool to BOARD_START_TOOLS only for one that lives in another toolset.
 */
export const BOARD_START_TOOLS = ["pcb_environment", "project_status", "pcb_inspect", "schematic_inspect", "schematic_review", "route_status", "verify_erc", "verify_viagrid"] as const;
export const BOARD_START_TOOLSETS = ["core", "render", "board"] as const;
/**
 * Tools of the start toolsets that a board tool replaces for the same job, so the run does not see two ways to do it:
 * `verify_drc` (board_check measures the same DRC with parity and A1-A9). Still loadable (`load_toolset`, `capability_search`).
 * Not listed here because the board tools do not cover the whole job: `route_run` (the single autoroute of the live board),
 * `verify_erc`, `render_*`, `pcb_inspect`, `schematic_inspect`. The `verify` toolset is not a start toolset: `verify_gate` and
 * `release_build` are covered by `board_release`; `verify_erc` and `verify_viagrid` are named in BOARD_START_TOOLS.
 */
export const BOARD_START_SUPERSEDED = ["verify_drc"] as const;

export function boardStartTools(registry: Pick<ToolRegistry, "byToolset">): string[] {
  const superseded = new Set<string>(BOARD_START_SUPERSEDED);
  return [...new Set([...BOARD_START_TOOLS, ...BOARD_START_TOOLSETS.flatMap((id) => registry.byToolset(id).map((t) => t.name))])].filter((n) => !superseded.has(n));
}

/**
 * The one decision, for desktop runs and external MCP sessions alike, of which toolsets a session on `project` starts
 * with besides the defaults: `board` once the project has a placed board and the board workflow is registered
 * (`board_check`; before that the set is board_job alone).
 */
export async function projectStartToolsets(
  registry: Pick<ToolRegistry, "get">,
  project: { dir: string } | null,
): Promise<ToolsetId[]> {
  return project && registry.get("board_check") !== undefined && (await projectHasPlacedBoard(project.dir)) ? ["board"] : [];
}

/** The endpoint query for those toolsets, as a fabdesk run's endpoint carries it (`agent-runs` appendToolsets). */
export function applyStartToolsets(query: URLSearchParams, toolsets: readonly string[]): void {
  if (!toolsets.length) return;
  query.set("toolsets", toolsets.join(","));
  if (toolsets.includes("board")) query.set("start", "board");
}

/** The session's start options for that query: the same lists a desktop run's endpoint gets. */
export function startOptionsFor(
  query: URLSearchParams,
  registry: Pick<ToolRegistry, "byToolset">,
): { initialToolsets: ToolsetId[]; initialTools?: string[] } {
  return {
    initialToolsets: initialToolsetsFor(query.get("toolsets")),
    ...(query.get("start") === "board" ? { initialTools: boardStartTools(registry) } : {}),
  };
}

/** A client times a tool call out after ~60 s unless it was raised (the MCP SDK default and Codex's). */
export const DURABLE_WAIT_SHORT_MS = 50_000;
const DURABLE_WAIT_MAX_MS = 25 * 60_000;
/** Clients whose tool calls outlast a durable job's wait (Claude Code resets its deadline on the progress heartbeat). */
const LONG_CALL_CLIENTS = /^claude-code$/i;

/**
 * How long a board tool waits before it returns a job id (`runDurable`), per session client. undefined keeps the
 * default 25 min: fabdesk's own runs (it raises each agent's tool timeout, e.g. Codex `tool_timeout_sec=1830`) and
 * clients known to wait. A declared timeout (`toolTimeoutSec`, from `fabdesk mcp --tool-timeout` or `/mcp?toolTimeoutSec=`)
 * waits just under it. Anything else, external Codex included, keeps its 60 s default as far as fabdesk can tell, so the
 * call returns a job id after 50 s and `board_job` continues it.
 */
export function durableWaitForClient(
  client: McpClientHint | undefined,
  opts: { ownRun?: boolean; toolTimeoutSec?: number } = {},
): number | undefined {
  const timeoutSec = client?.toolTimeoutSec ?? opts.toolTimeoutSec;
  if (timeoutSec && timeoutSec > 0) {
    const ms = timeoutSec * 1000;
    return Math.min(DURABLE_WAIT_MAX_MS, Math.max(1_000, ms - Math.min(10_000, ms / 4)));
  }
  if (opts.ownRun) return undefined;
  if (client?.name && LONG_CALL_CLIENTS.test(client.name)) return undefined;
  return DURABLE_WAIT_SHORT_MS;
}

export const BOARD_WORKFLOW_RESOURCE_URI = "fabdesk://docs/board-workflow";
export const BOARD_WORKFLOW_PROMPT = "board_workflow";

/** The stage table of the workflow text: `| 1 onboard + check | \`board_check\` | ...`. */
export function boardWorkflowStages(md: string = BOARD_WORKFLOW_MD): Array<{ stage: string; tool: string }> {
  const rows: Array<{ stage: string; tool: string }> = [];
  for (const line of md.split("\n")) {
    const m = /^\|\s*(\d+[a-z]?\s[^|]*?)\s*\|\s*`([a-z_]+)`/.exec(line);
    if (m) rows.push({ stage: m[1]!, tool: m[2]! });
  }
  return rows;
}

/**
 * The board-workflow pointer in the server instructions: what an external agent (Codex, Claude Code through the plugin)
 * otherwise never learns, since the full text reaches only the AGENTS.md of desktop runs. Stages come from the workflow
 * text; the full text is the resource and the prompt.
 */
export function boardWorkflowInstructions(opts: { listed?: boolean } = {}): string {
  const stages = boardWorkflowStages()
    .map((r) => `${r.stage} \`${r.tool}\``)
    .join(" · ");
  return [
    ` Board workflow (a placed board to a releasable one): ${stages}.`,
    "Done is the board's own acceptance checks A1-A9 passing, as board_check measures them against the requirements written at onboarding.",
    "Engines a stage needs (routers, KiCadRoutingTools) install on demand; a call that cannot get one names it.",
    "A long call returns a job id; board_job waits for it, reports it or cancels it.",
    opts.listed
      ? "This project has a placed board, so the board tools are listed from the start."
      : 'The board tools are the `board` toolset (load_toolset {"toolset":"board"}); a session started in a project with a placed board lists them.',
    `Full method: resource ${BOARD_WORKFLOW_RESOURCE_URI}, or prompt ${BOARD_WORKFLOW_PROMPT}.`,
  ].join(" ");
}

export function boardWorkflowPromptText(project?: string, request?: string): string {
  return [
    "Take this project's placed board to a releasable one with the fabdesk board tools, by the method below.",
    project ? `Project: ${project} (pass project="${project}" to the board_* tools).` : "Use the session's project.",
    ...(request?.trim() ? [`Request: ${request.trim()}`] : []),
    "",
    BOARD_WORKFLOW_MD,
  ].join("\n");
}

/** The workflow text as a resource and a prompt, generated from BOARD_WORKFLOW_MD (the AGENTS.md section desktop runs get). */
export function registerBoardWorkflowDocs(server: McpServer): void {
  server.registerResource(
    "board-workflow",
    BOARD_WORKFLOW_RESOURCE_URI,
    {
      title: "Board workflow",
      description: "The board toolset's method: stages, tools, gates, the A1-A9 acceptance checks and working rules.",
      mimeType: "text/markdown",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: BOARD_WORKFLOW_MD }],
    }),
  );
  server.registerPrompt(
    BOARD_WORKFLOW_PROMPT,
    {
      title: "Board workflow",
      description: "Take a placed board to a releasable one with the board_* tools (the full workflow text).",
      argsSchema: {
        project: z.string().optional().describe("Project id, name or path"),
        request: z.string().optional().describe("What to do with the board"),
      } as unknown as ZodRawShapeCompat,
    },
    (args: Record<string, unknown>): GetPromptResult => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: boardWorkflowPromptText(
              typeof args["project"] === "string" && args["project"] ? args["project"] : undefined,
              typeof args["request"] === "string" ? args["request"] : undefined,
            ),
          },
        },
      ],
    }),
  );
}

export type McpSessionOptions = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  version: string;
  /** Hosts accepted in the `Host` header (DNS rebinding protection). Set after bind. */
  allowedHosts?: string[];
  idleMs?: number;
  /**
   * The extra start toolsets of a session opened with `?project=<id|name|dir>` (the stdio proxy sends the folder it was
   * started in): `projectStartToolsets`, so an external client gets a desktop run's start set without `load_toolset`.
   */
  startToolsets?: (projectRef: string) => Promise<readonly string[]>;
  /** The token belongs to a run fabdesk launched (it set that agent's tool timeout); see `durableWaitForClient`. */
  ownRun?: (token: string | null) => boolean;
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
    // Codex snapshots MCP tools when a turn starts and currently ignores tools/list_changed.
    // Let clients that cannot refresh opt into the complete inventory at initialization.
    const query = new URL(req.url).searchParams;
    const profile = query.get("profile");
    // An external session names its project (the stdio proxy's folder): it starts as a desktop run on it would.
    const projectRef = query.get("project");
    if (projectRef && this.opts.startToolsets && !profile && !query.has("toolsets") && !query.has("start"))
      applyStartToolsets(query, await this.opts.startToolsets(projectRef).catch(() => []));
    const agentProfile = profile === "planning" || profile === "substrate";
    const boardDocs = !agentProfile && this.opts.registry.get("board_check") !== undefined;
    const server = new McpServer(
      {
        name: "fabdesk",
        title: "fabPlane",
        version: this.opts.version,
        icons: FABDESK_SERVER_ICONS,
      },
      {
        instructions:
          INSTRUCTIONS +
          (boardDocs ? boardWorkflowInstructions({ listed: query.get("start") === "board" }) : "") +
          (canAsk ? USER_INPUT_INSTRUCTIONS : ""),
      },
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
    const initialToolsets = initialToolsetsFor(query.get("toolsets"));
    const initialTools =
      profile === "planning"
        ? ["request_project_creation"]
        : profile === "native"
          ? nativeToolsFor(query.get("toolsets"), this.opts.registry)
          : profile === "substrate"
            ? []
            : query.get("start") === "board"
              ? boardStartTools(this.opts.registry)
              : undefined;
    // MCP Apps views: `auto` lists them for clients that advertise io.modelcontextprotocol/ui;
    // `?apps=on` forces them (stdio proxy started with --apps). The agent profiles never get them.
    const appsParam = query.get("apps");
    const apps: McpAppsMode =
      profile === "native" || profile === "substrate" || profile === "planning"
        ? "off"
        : appsParam === "on" || appsParam === "off"
          ? appsParam
          : "auto";
    const ownRun = this.opts.ownRun?.(opts.token ?? null) === true;
    const declaredTimeout = Number(query.get("toolTimeoutSec"));
    attachToRegistry(server, this.opts.registry, this.opts.ctxFactory, {
      apps,
      durableWaitMs: (client) =>
        durableWaitForClient(client, {
          ownRun,
          ...(declaredTimeout > 0 ? { toolTimeoutSec: declaredTimeout } : {}),
        }),
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
    if (boardDocs) registerBoardWorkflowDocs(server);
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

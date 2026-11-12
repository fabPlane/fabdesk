/**
 * Tool registry: the single source of truth for every fabdesk tool. Adapters (MCP, HTTP, WebMCP
 * manifest, AGENTS.md) are generated from it; handlers are deterministic and never call a model.
 */
import { z } from "zod/v4";
import { BoardSourceSelection } from "@fabdesk/protocol";
import { createHash } from "node:crypto";
import type {
  CoreEvent,
  Principal,
  ProjectManifest,
  Settings,
  ToolManifestEntry,
} from "@fabdesk/protocol";
import type { CoreServices } from "./services";

export const TOOLSETS = [
  "core",
  "project",
  "circuit",
  "route",
  "kicad",
  "verify",
  "render",
  "export",
  "sim",
  "app",
  "shopping",
  "cad",
  "board",
] as const;
export type ToolsetId = (typeof TOOLSETS)[number];
export const ToolsetId = z.enum(TOOLSETS);

/**
 * Noun forms of toolset ids that load_toolset also accepts. Models asked for "routing" when the id
 * is "route"; the others are the same noun-for-stem pattern. Exact matches only, no fuzzy matching.
 */
export const TOOLSET_ALIASES = {
  routing: "route",
  verification: "verify",
  rendering: "render",
  simulation: "sim",
} as const satisfies Record<string, ToolsetId>;

/** A toolset id or one of its aliases, normalised to the canonical id. */
export const ToolsetIdOrAlias = z
  .enum([...TOOLSETS, ...(Object.keys(TOOLSET_ALIASES) as Array<keyof typeof TOOLSET_ALIASES>)])
  .transform(
    (id): ToolsetId =>
      id in TOOLSET_ALIASES
        ? TOOLSET_ALIASES[id as keyof typeof TOOLSET_ALIASES]
        : (id as ToolsetId),
  );

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolImage = { path: string; mime: string; requiredInline?: boolean };

export type ToolOutput = {
  /** Human/LLM readable summary. Adapters fall back to JSON when omitted. */
  text?: string;
  /** Structured result; exposed as `structuredContent` (MCP) / response body (HTTP). */
  json?: unknown;
  images?: ToolImage[];
  isError?: boolean;
};

/** A project the tool operates on. Files are jailed under `dir`. */
export interface ProjectHandle {
  id: string;
  name: string;
  dir: string;
  manifest(): ProjectManifest;
  updateManifest(patch: Partial<ProjectManifest>): Promise<ProjectManifest>;
}

export interface ToolContext {
  project: ProjectHandle | null;
  requireProject(): ProjectHandle;
  services: CoreServices;
  signal: AbortSignal;
  progress(p: number, note?: string): void;
  principal: Principal | null;
  /** MCP session hooks; absent over HTTP where every toolset is always available. */
  session?: ToolSession;
  /** Optional run-scoped tracing supplied by fabdesk-core. */
  telemetry?: ToolTelemetry;
  /** Captured board scope; a transport must execute it rather than ignore its selector. */
  board?: BoardSourceSelection;
  /** Captured assembly parent for project-relative history; native work still uses project.dir. */
  boardRoot?: Readonly<{ id: string; dir: string }>;
  runInScope?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Host-approved private routing snapshot; never broadens the canonical editable source. */
  runWithRoutingSnapshot?: <T>(directory: string, operation: () => Promise<T>) => Promise<T>;
}

/** A host must bind an explicit selector; ignoring it must never become a root operation. */
export function assertBoardExecutionContext(ctx: ToolContext, board: BoardSourceSelection | undefined): void {
  if (ctx.board && !board) throw new ToolError("This host supplied an implicit board source; pass an explicit board selector.", "precondition");
  if (board && (!ctx.runInScope || ctx.board?.sourceId !== board.sourceId || ctx.board.manifestSha256 !== board.manifestSha256)) throw new ToolError("This host did not establish the requested board source scope; refusing to use the project root.", "precondition");
}

export interface ToolTelemetry {
  traceToolCall(
    input: {
      name: string;
      args: Record<string, unknown>;
      project: ProjectHandle | null;
      readOnly: boolean;
      sessionId?: string;
    },
    invoke: () => Promise<ToolOutput>,
  ): Promise<ToolOutput>;
  recordToolEvent?(type: string, body: unknown): void;
}

export interface ToolSession {
  id: string;
  enabledToolsets(): ToolsetId[];
  enableToolset(id: ToolsetId): void;
}

export type ToolHandler<I extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<I>>,
  ctx: ToolContext,
) => Promise<ToolOutput>;

export type ToolDef<I extends z.ZodRawShape = z.ZodRawShape> = {
  /** snake_case; becomes `mcp__fabdesk__<name>` in Claude Code allow rules. */
  name: string;
  toolset: ToolsetId;
  title: string;
  /** Agent-facing capability, input, and output description. */
  description: string;
  inputSchema: I;
  outputSchema?: z.ZodRawShape;
  /** Declare effects explicitly; omitted MCP hints otherwise default to destructive/open-world. */
  annotations: ToolAnnotations &
    Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "openWorldHint">>;
  /** Runs as a job over HTTP (`{jobId}`), streams progress over MCP. */
  longRunning?: boolean;
  /** False for durable jobs whose MCP request only schedules work. Keeps HTTP job behavior. */
  mcpHeartbeat?: boolean;
  /** `project` tools accept an optional `project` argument (id or path) and require one at runtime. */
  scope?: "project" | "global";
  /**
   * Runs arbitrary code on the host (FreeCAD Python, renderer JavaScript). Served only to the
   * desktop over loopback: adapters reachable from paired phones, the relay or the tailnet refuse
   * it (HTTP: 403 `tool_local_only`) and leave it out of their manifests.
   */
  localOnly?: boolean;
  /** Supports an explicit assembly source selector. Other tools reject that argument. */
  boardScoped?: boolean;
  /** Project mechanical workspace; handlers require explicit jailed source paths and revisions.
   * Does not imply membership or permit unscoped native member edits. */
  assemblyWide?: boolean;
  handler: ToolHandler<I>;
};

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_args"
      | "not_found"
      | "precondition"
      | "cancelled"
      | "unavailable"
      | "internal" = "internal",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** A conflict whose saved and live states must survive higher-level rollback handlers. */
export class NativeRevisionConflict extends ToolError {
  constructor(message: string) {
    super(message, "precondition");
  }
}

/** A backend operation reached its explicit deadline, independently of its log text. */
export class JobTimeoutError extends ToolError {
  constructor(message: string) {
    super(message, "unavailable");
    this.name = "JobTimeoutError";
  }
}

/** Nested mutation objects must reject unknown fields even when an adapter parses first. */
export function mutationInputObject<I extends z.ZodRawShape>(shape: I) {
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const hint = issue.keys.some((key) => key === "x" || key === "y")
        ? "; use position: {x, y} in mm for placement coordinates"
        : "";
      return `Unknown input fields: ${issue.keys.join(", ")}${hint}`;
    },
  });
}

export function defineTool<I extends z.ZodRawShape>(def: ToolDef<I>): ToolDef<I> {
  if (!TOOL_NAME_RE.test(def.name))
    throw new Error(`tool name must match ${TOOL_NAME_RE}: ${def.name}`);
  return def;
}

export const PROJECT_ARG = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Project id, name or absolute path. Optional when the session already has a current project.",
  );

/** A parsed mutating call must never lose input fields before reaching its handler.
 * Compare recursively so this also covers nested objects in arrays/unions, while declared
 * records and opaque payloads (which Zod preserves) remain available to their tools.
 */
function droppedInputFields(raw: unknown, parsed: unknown, path = ""): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((value, index) =>
      droppedInputFields(value, parsed[index], `${path}[${index}]`),
    );
  if (!raw || typeof raw !== "object" || !parsed || typeof parsed !== "object") return [];
  const output = parsed as Record<string, unknown>;
  return Object.entries(raw).flatMap(([key, value]) => {
    const field = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(output, key)) {
      const hint =
        key === "x" || key === "y" ? "; use position: {x, y} in mm for placement coordinates" : "";
      return [`${field}: unknown input field${hint}`];
    }
    return droppedInputFields(value, output[key], field);
  });
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private contractCache: { version: string; sha256: string } | null = null;

  constructor(defs: ReadonlyArray<ToolDef<z.ZodRawShape>> = []) {
    for (const d of defs) this.add(d);
  }

  add<I extends z.ZodRawShape>(def: ToolDef<I>): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    if (!TOOL_NAME_RE.test(def.name)) throw new Error(`bad tool name ${def.name}`);
    if (def.boardScoped && ((def.scope ?? "project") === "global" || Object.hasOwn(def.inputSchema, "board"))) throw new Error("Board-scoped tools must be project-scoped and reserve the board selector argument");
    this.tools.set(def.name, def as unknown as ToolDef);
    this.contractCache = null;
    return this;
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  byToolset(id: ToolsetId): ToolDef[] {
    return this.list().filter((t) => t.toolset === id);
  }

  toolsets(): ToolsetId[] {
    return TOOLSETS.filter((t) => this.byToolset(t).length > 0);
  }

  /** Input shape as exposed to clients: project-scoped tools gain the optional `project` argument. */
  inputShape(def: ToolDef): z.ZodRawShape {
    if ((def.scope ?? "project") === "global") return def.inputSchema;
    return { ...def.inputSchema, project: PROJECT_ARG, ...(def.boardScoped ? { board: BoardSourceSelection.optional().describe("Explicit assembly source ID and captured manifest SHA from project_status or board-source inspection") } : {}) };
  }

  inputObject(def: ToolDef): z.ZodObject<z.ZodRawShape> {
    return z.object(this.inputShape(def)).strict();
  }

  jsonSchema(def: ToolDef): Record<string, unknown> {
    return z.toJSONSchema(this.inputObject(def), { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  }

  manifest(): ToolManifestEntry[] {
    return this.list().map((t) => ({
      name: t.name,
      toolset: t.toolset,
      title: t.title,
      description: t.description,
      inputSchema: this.jsonSchema(t),
      annotations: t.annotations,
      longRunning: t.longRunning ?? false,
    }));
  }

  /** Hash of the exact ordered tool names, descriptions, schemas, annotations and job semantics. */
  contract(): { version: string; sha256: string } {
    if (!this.contractCache) {
      const encoded = JSON.stringify(this.manifest());
      this.contractCache = {
        version: "option-1-mcp/1.0.0",
        sha256: createHash("sha256").update(encoded).digest("hex"),
      };
    }
    return this.contractCache;
  }

  /**
   * Validate `rawArgs` against the tool schema, split off the `project` selector and run the
   * handler. `makeContext` receives the project reference (from args) so adapters can resolve it.
   */
  async invoke(
    name: string,
    rawArgs: unknown,
    makeContext: (
      projectRef: string | undefined,
      def: ToolDef,
      board?: BoardSourceSelection,
    ) => Promise<ToolContext> | ToolContext,
  ): Promise<ToolOutput> {
    const def = this.get(name);
    if (!def) throw new ToolError(`unknown tool ${name}`, "not_found");
    const parsed = this.inputObject(def).safeParse(rawArgs ?? {});
    if (!parsed.success)
      throw new ToolError(
        `invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
        "invalid_args",
      );
    if (!def.annotations.readOnlyHint) {
      const dropped = droppedInputFields(rawArgs, parsed.data);
      if (dropped.length)
        throw new ToolError(`invalid arguments for ${name}: ${dropped.join("\n")}`, "invalid_args");
    }
    const global = (def.scope ?? "project") === "global";
    // Project-scoped tools get the injected `project` selector split off; global tools keep their own arguments intact.
    const { project: projectRef, ...rest } = parsed.data as Record<string, unknown> & {
      project?: string;
    };
    const board = !global && def.boardScoped && rest["board"] ? Object.freeze(BoardSourceSelection.parse(rest["board"])) : undefined;
    const args = global ? (parsed.data as Record<string, unknown>) : def.boardScoped ? Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "board")) : rest;
    const ctx = await makeContext(global ? undefined : projectRef, def, board);
    assertBoardExecutionContext(ctx, board);
    if (!global && !ctx.project) {
      throw new ToolError(
        "no project selected: pass `project` (id, name or path) or create one with the app / POST /projects",
        "precondition",
      );
    }
    const executionBoard = board && ctx.project ? { projectId: ctx.project.id, ...board } : null;
    const handler = () => def.handler(args as never, ctx);
    const invoke = () => ctx.runInScope ? ctx.runInScope(handler) : handler();
    const output = await (ctx.telemetry
      ? ctx.telemetry.traceToolCall(
          {
            name,
            args: parsed.data as Record<string, unknown>,
            project: ctx.project,
            readOnly: def.annotations.readOnlyHint ?? false,
            ...(ctx.session ? { sessionId: ctx.session.id } : {}),
          },
          invoke,
        )
      : invoke());
    const contract = this.contract();
    const structured = output.json;
    return {
      ...output,
      json:
        structured && typeof structured === "object" && !Array.isArray(structured)
          ? { ...(structured as Record<string, unknown>), ...(executionBoard ? { _board: executionBoard } : {}), _contract: contract }
          : { value: structured ?? null, ...(executionBoard ? { _board: executionBoard } : {}), _contract: contract },
    };
  }
}

/** What an adapter hands to the daemon to obtain a ToolContext for one invocation. */
export type ContextRequest = {
  def: ToolDef;
  /** Value of the `project` argument (already stripped from args), if any. */
  projectRef: string | undefined;
  board?: BoardSourceSelection;
  signal: AbortSignal;
  progress: (p: number, note?: string) => void;
  session?: ToolSession;
  /** Transport-level identity (MCP session id, HTTP request id). */
  sessionId?: string;
  /** Bearer token that authenticated the call, when the adapter knows it. */
  token?: string;
};
export type ContextFactory = (req: ContextRequest) => Promise<ToolContext> | ToolContext;

export function makeContext(opts: {
  services: CoreServices;
  project: ProjectHandle | null;
  signal?: AbortSignal;
  progress?: (p: number, note?: string) => void;
  principal?: Principal | null;
  session?: ToolSession;
  telemetry?: ToolTelemetry;
  board?: BoardSourceSelection;
  runInScope?: <T>(operation: () => Promise<T>) => Promise<T>;
  runWithRoutingSnapshot?: <T>(directory: string, operation: () => Promise<T>) => Promise<T>;
  boardRoot?: Readonly<{ id: string; dir: string }>;
}): ToolContext {
  const project = opts.project;
  return {
    project,
    requireProject() {
      if (!project) throw new ToolError("this tool needs a project", "precondition");
      return project;
    },
    services: opts.services,
    signal: opts.signal ?? new AbortController().signal,
    progress: opts.progress ?? (() => {}),
    principal: opts.principal ?? null,
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.boardRoot ? { boardRoot: opts.boardRoot } : {}),
    ...(opts.runInScope ? { runInScope: opts.runInScope } : {}),
    ...(opts.runWithRoutingSnapshot ? { runWithRoutingSnapshot: opts.runWithRoutingSnapshot } : {}),
  };
}

export type { CoreEvent, Settings };

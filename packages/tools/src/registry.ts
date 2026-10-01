/**
 * Tool registry: the single source of truth for every fabdesk tool. Adapters (MCP, HTTP, WebMCP
 * manifest, AGENTS.md) are generated from it; handlers are deterministic and never call a model.
 */
import { z } from "zod/v4";
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
  /** `project` tools accept an optional `project` argument (id or path) and require one at runtime. */
  scope?: "project" | "global";
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

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private contractCache: { version: string; sha256: string } | null = null;

  constructor(defs: ReadonlyArray<ToolDef<z.ZodRawShape>> = []) {
    for (const d of defs) this.add(d);
  }

  add<I extends z.ZodRawShape>(def: ToolDef<I>): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    if (!TOOL_NAME_RE.test(def.name)) throw new Error(`bad tool name ${def.name}`);
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
    return { ...def.inputSchema, project: PROJECT_ARG };
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
    const global = (def.scope ?? "project") === "global";
    // Project-scoped tools get the injected `project` selector split off; global tools keep their own arguments intact.
    const { project: projectRef, ...rest } = parsed.data as Record<string, unknown> & {
      project?: string;
    };
    const args = global ? (parsed.data as Record<string, unknown>) : rest;
    const ctx = await makeContext(global ? undefined : projectRef, def);
    if (!global && !ctx.project) {
      throw new ToolError(
        "no project selected: pass `project` (id, name or path) or create one with the app / POST /projects",
        "precondition",
      );
    }
    const invoke = () => def.handler(args as never, ctx);
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
          ? { ...(structured as Record<string, unknown>), _contract: contract }
          : { value: structured ?? null, _contract: contract },
    };
  }
}

/** What an adapter hands to the daemon to obtain a ToolContext for one invocation. */
export type ContextRequest = {
  def: ToolDef;
  /** Value of the `project` argument (already stripped from args), if any. */
  projectRef: string | undefined;
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
  };
}

export type { CoreEvent, Settings };

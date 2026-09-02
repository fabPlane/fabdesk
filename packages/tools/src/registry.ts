/**
 * Tool registry: the single source of truth for every fabdesk tool. Adapters (MCP, HTTP, WebMCP
 * manifest, AGENTS.md) are generated from it; handlers are deterministic and never call a model.
 */
import { z } from "zod/v4";
import type { CoreEvent, Principal, ProjectManifest, Settings, ToolManifestEntry } from "@fabdesk/protocol";
import type { CoreServices } from "./services";

export const TOOLSETS = ["core", "project", "circuit", "route", "kicad", "verify", "render", "export", "sim"] as const;
export type ToolsetId = (typeof TOOLSETS)[number];
export const ToolsetId = z.enum(TOOLSETS);

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolImage = { path: string; mime: string };

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
  /** Written for an LLM: when to call it, what it needs, what it returns. */
  description: string;
  inputSchema: I;
  outputSchema?: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Runs as a job over HTTP (`{jobId}`), streams progress over MCP. */
  longRunning?: boolean;
  /** `project` tools accept an optional `project` argument (id or path) and require one at runtime. */
  scope?: "project" | "global";
  handler: ToolHandler<I>;
};

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_args" | "not_found" | "precondition" | "cancelled" | "unavailable" | "internal" = "internal",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function defineTool<I extends z.ZodRawShape>(def: ToolDef<I>): ToolDef<I> {
  if (!TOOL_NAME_RE.test(def.name)) throw new Error(`tool name must match ${TOOL_NAME_RE}: ${def.name}`);
  return def;
}

export const PROJECT_ARG = z
  .string()
  .min(1)
  .optional()
  .describe("Project id, name or absolute path. Optional when the session already has a current project.");

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(defs: ReadonlyArray<ToolDef<z.ZodRawShape>> = []) {
    for (const d of defs) this.add(d);
  }

  add<I extends z.ZodRawShape>(def: ToolDef<I>): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    if (!TOOL_NAME_RE.test(def.name)) throw new Error(`bad tool name ${def.name}`);
    this.tools.set(def.name, def as unknown as ToolDef);
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
    return z.toJSONSchema(this.inputObject(def), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
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

  /**
   * Validate `rawArgs` against the tool schema, split off the `project` selector and run the
   * handler. `makeContext` receives the project reference (from args) so adapters can resolve it.
   */
  async invoke(
    name: string,
    rawArgs: unknown,
    makeContext: (projectRef: string | undefined, def: ToolDef) => Promise<ToolContext> | ToolContext,
  ): Promise<ToolOutput> {
    const def = this.get(name);
    if (!def) throw new ToolError(`unknown tool ${name}`, "not_found");
    const parsed = this.inputObject(def).safeParse(rawArgs ?? {});
    if (!parsed.success) throw new ToolError(`invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, "invalid_args");
    const { project: projectRef, ...args } = parsed.data as Record<string, unknown> & { project?: string };
    const ctx = await makeContext((def.scope ?? "project") === "global" ? undefined : projectRef, def);
    if ((def.scope ?? "project") === "project" && !ctx.project) {
      throw new ToolError(
        "no project selected: pass `project` (id, name or path) or create one with the app / POST /projects",
        "precondition",
      );
    }
    return def.handler(args as never, ctx);
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
  };
}

export type { CoreEvent, Settings };

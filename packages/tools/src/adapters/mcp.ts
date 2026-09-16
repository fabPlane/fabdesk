/**
 * MCP adapter: registers the registry on an `McpServer`. The core toolset is enabled; other
 * toolsets are registered disabled and switched on by `load_toolset` (list_changed fires).
 */
import { readFile, stat } from "node:fs/promises";
import { McpServer, ResourceTemplate, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ReadResourceResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, readJsonOrNull } from "../fs";
import {
  TOOLSETS,
  ToolError,
  type ContextFactory,
  type ToolContext,
  type ToolDef,
  type ToolOutput,
  type ToolRegistry,
  type ToolSession,
  type ToolsetId,
} from "../registry";
import type { BuildSummary } from "../tools/core";
import { p } from "../tools/common";

/** How often a long-running tool repeats its last progress so the MCP client does not call it idle. */
export const MCP_PROGRESS_HEARTBEAT_MS = 30_000;
const heartbeatMs = (): number => Number(process.env["FABDESK_MCP_HEARTBEAT_MS"]) || MCP_PROGRESS_HEARTBEAT_MS;

export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export type McpAttachment = {
  session: ToolSession;
  registered: Map<string, RegisteredTool>;
};

export type AttachOptions = {
  sessionId?: string;
  /** Toolsets enabled from the start; `core` is always enabled. */
  initialToolsets?: ToolsetId[];
  /** Exact initial registry tools. Used by clients that snapshot the list at turn start. */
  initialTools?: string[];
  /** Registry tools hidden from capability discovery for a specialized profile. */
  capabilityExclude?: string[];
  /** Skip resources (e.g. lightweight test servers). */
  toolsOnly?: boolean;
};

export function attachToRegistry(
  server: McpServer,
  registry: ToolRegistry,
  ctxFactory: ContextFactory,
  opts: AttachOptions = {},
): McpAttachment {
  const enabled = new Set<ToolsetId>(["core", ...(opts.initialToolsets ?? [])]);
  const initialTools = opts.initialTools ? new Set(opts.initialTools) : null;
  const registered = new Map<string, RegisteredTool>();
  const sessionId = opts.sessionId ?? crypto.randomUUID();

  const session: ToolSession = {
    id: sessionId,
    enabledToolsets: () => TOOLSETS.filter((t) => enabled.has(t)),
    enableToolset(id) {
      if (enabled.has(id)) return;
      enabled.add(id);
      for (const def of registry.byToolset(id)) registered.get(def.name)?.enable();
    },
  };

  for (const def of registry.list()) {
    const tool = server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // The SDK bundles its own zod 4; runtime-compatible with our zod/v4 schemas (`_zod` present).
        inputSchema: registry.inputShape(def) as unknown as ZodRawShapeCompat,
        annotations: { title: def.title, ...def.annotations },
      },
      async (args: Record<string, unknown>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<CallToolResult> => {
        const progressToken = extra._meta?.progressToken;
        let last: { pr: number; note?: string } = { pr: 0 };
        const send = (pr: number, note?: string) => {
          if (progressToken === undefined) return;
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: Math.round(pr * 100), total: 100, ...(note ? { message: note } : {}) },
            })
            .catch(() => {});
        };
        const progress = (pr: number, note?: string) => {
          last = { pr, ...(note !== undefined ? { note } : {}) };
          send(pr, note);
        };
        // Claude Code aborts a tool call that is silent for ~5 minutes; a router stuck in one solver
        // phase reports nothing for longer than that, so long-running tools repeat their last
        // progress on a timer while they work.
        const heartbeat = def.longRunning && progressToken !== undefined ? setInterval(() => send(last.pr, last.note), heartbeatMs()) : null;
        try {
          const output = await registry.invoke(def.name, args, (projectRef) =>
            ctxFactory({ def, projectRef, signal: extra.signal, progress, session, sessionId, ...(extra.authInfo?.token ? { token: extra.authInfo.token } : {}) }),
          );
          return await toCallToolResult(output);
        } catch (e) {
          return errorResult(e);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      },
    );
    registered.set(def.name, tool);
    if (initialTools ? !initialTools.has(def.name) : !enabled.has(def.toolset)) tool.disable();
  }

  registerCapabilityTools(server, registry, ctxFactory, session, sessionId, registered, initialTools, new Set(opts.capabilityExclude ?? []));

  if (!opts.toolsOnly) {
    registerResources(server, registry, ctxFactory, session, sessionId);
  }

  return { session, registered };
}

function registerCapabilityTools(
  server: McpServer,
  registry: ToolRegistry,
  ctxFactory: ContextFactory,
  session: ToolSession,
  sessionId: string,
  registered: Map<string, RegisteredTool>,
  initialTools: Set<string> | null,
  excluded: Set<string>,
): void {
  const discovered = new Set<string>();
  const search = server.registerTool(
    "capability_search",
    {
      title: "Search additional Fabdesk capabilities",
      description: "Find infrequent Fabdesk operations by capability. Returns only matching names, descriptions, and input schemas.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Words describing the operation you need"),
        limit: z.number().int().min(1).max(20).default(8),
      } as unknown as ZodRawShapeCompat,
      annotations: { title: "Search additional Fabdesk capabilities", readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
      const query = String(rawArgs["query"]);
      const limit = Number(rawArgs["limit"] ?? 8);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = registry.list()
        .filter((def) => !initialTools?.has(def.name) && !excluded.has(def.name))
        .map((def) => {
          const haystack = `${def.name} ${def.title} ${def.description} ${def.toolset}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          return { def, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
        .slice(0, limit)
        .map(({ def }) => {
          discovered.add(def.name);
          return { name: def.name, title: def.title, description: def.description, inputSchema: registry.jsonSchema(def), annotations: def.annotations, longRunning: def.longRunning ?? false };
        });
      return toCallToolResult({
        text: matches.length ? `Found ${matches.length} matching additional capabilities.` : `No additional capabilities matched "${query}".`,
        json: { query, matches },
      });
    },
  );
  registered.set("capability_search", search);

  const call = server.registerTool(
    "capability_call",
    {
      title: "Call an additional Fabdesk capability",
      description: "Invoke an operation returned by capability_search with its documented arguments.",
      inputSchema: {
        name: z.string().min(1).describe("Exact operation name returned by capability_search"),
        arguments: z.record(z.string(), z.unknown()).default({}),
      } as unknown as ZodRawShapeCompat,
      annotations: { title: "Call an additional Fabdesk capability", destructiveHint: true, openWorldHint: true },
    },
    async (rawArgs: Record<string, unknown>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<CallToolResult> => {
      const name = String(rawArgs["name"]);
      const args = (rawArgs["arguments"] ?? {}) as Record<string, unknown>;
      if (name === "capability_search" || name === "capability_call") return errorResult(new ToolError(`cannot dispatch ${name}`, "invalid_args"));
      if (!discovered.has(name)) return errorResult(new ToolError(`search for ${name} before calling it`, "invalid_args"));
      try {
        const output = await registry.invoke(name, args, (projectRef, def) =>
          ctxFactory({ def, projectRef, signal: extra.signal, progress: () => {}, session, sessionId, ...(extra.authInfo?.token ? { token: extra.authInfo.token } : {}) }),
        );
        return toCallToolResult(output);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  registered.set("capability_call", call);
}

export function errorResult(e: unknown): CallToolResult {
  const msg = e instanceof ToolError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

export async function toCallToolResult(output: ToolOutput): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [];
  const text = output.text ?? (output.json !== undefined ? JSON.stringify(output.json, null, 2) : "ok");
  content.push({ type: "text", text });
  for (const img of output.images ?? []) {
    const st = await stat(img.path).catch(() => null);
    if (!st) {
      content.push({ type: "text", text: `(image missing: ${img.path})` });
      continue;
    }
    if (st.size > MAX_INLINE_IMAGE_BYTES && !img.requiredInline) {
      content.push({ type: "text", text: `Image too large to inline (${st.size} bytes); read it from ${img.path}` });
      continue;
    }
    if (img.mime === "image/svg+xml") {
      content.push({ type: "resource", resource: { uri: `file://${img.path}`, mimeType: img.mime, text: await readFile(img.path, "utf8") } });
    } else {
      content.push({ type: "image", data: Buffer.from(await readFile(img.path)).toString("base64"), mimeType: img.mime });
    }
  }
  const structured = output.json !== undefined && output.json !== null && typeof output.json === "object" && !Array.isArray(output.json) ? (output.json as Record<string, unknown>) : undefined;
  return { content, ...(structured ? { structuredContent: structured } : {}), ...(output.isError ? { isError: true } : {}) };
}

async function contextFor(ctxFactory: ContextFactory, registry: ToolRegistry, session: ToolSession, sessionId: string, projectRef: string | undefined): Promise<ToolContext> {
  const def = registry.get("project_status") as ToolDef;
  return ctxFactory({ def, projectRef, signal: new AbortController().signal, progress: () => {}, session, sessionId });
}

function registerResources(server: McpServer, registry: ToolRegistry, ctxFactory: ContextFactory, session: ToolSession, sessionId: string): void {
  const listProjects = async () => {
    const ctx = await contextFor(ctxFactory, registry, session, sessionId, undefined);
    return ctx.services.projects.list();
  };
  const project = async (id: string) => {
    const ctx = await contextFor(ctxFactory, registry, session, sessionId, id);
    if (!ctx.project) throw new ToolError(`project not found: ${id}`, "not_found");
    return ctx;
  };
  const text = (uri: URL, mimeType: string, body: string): ReadResourceResult => ({ contents: [{ uri: uri.href, mimeType, text: body }] });

  server.registerResource(
    "project-manifest",
    new ResourceTemplate("fabdesk://project/{id}/manifest", {
      list: async () => ({ resources: (await listProjects()).map((pr) => ({ uri: `fabdesk://project/${pr.id}/manifest`, name: `${pr.name} manifest`, mimeType: "application/json" })) }),
    }),
    { title: "Project manifest", description: "fabdesk.json: board settings, router, allowed DRC warnings", mimeType: "application/json" },
    async (uri, vars) => {
      const ctx = await project(String(vars["id"]));
      return text(uri, "application/json", JSON.stringify(ctx.project!.manifest(), null, 2));
    },
  );

  server.registerResource(
    "project-board-summary",
    new ResourceTemplate("fabdesk://project/{id}/board-summary", {
      list: async () => ({ resources: (await listProjects()).map((pr) => ({ uri: `fabdesk://project/${pr.id}/board-summary`, name: `${pr.name} board summary`, mimeType: "application/json" })) }),
    }),
    { title: "Board summary", description: "Build/route/DRC state of the project", mimeType: "application/json" },
    async (uri, vars) => {
      const ctx = await project(String(vars["id"]));
      const pr = ctx.project!;
      const build = await readJsonOrNull<BuildSummary>(p(pr, PROJECT_FILES.reports, "build.json"));
      const drc = await readJsonOrNull<{ counts: unknown }>(p(pr, PROJECT_FILES.reports, "drc.json"));
      const route = ctx.services.routeRuns.latest(pr.id);
      const summary = {
        id: pr.id,
        name: pr.name,
        board: pr.manifest().board,
        router: pr.manifest().router,
        built: await exists(p(pr, PROJECT_FILES.boardPcb)),
        lastBuild: build ? { ok: build.ok, errors: build.errors.length, warnings: build.warnings.length, at: build.at } : null,
        lastRoute: route ? { runId: route.id, status: route.status, open: route.result?.open ?? null } : null,
        lastDrc: drc?.counts ?? null,
      };
      return text(uri, "application/json", JSON.stringify(summary, null, 2));
    },
  );

  server.registerResource(
    "project-report",
    new ResourceTemplate("fabdesk://project/{id}/reports/{name}", {
      list: async () => {
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
        for (const pr of await listProjects()) {
          for (const n of ["build", "drc", "erc", "gate", "spice"]) {
            if (await exists(p(pr, PROJECT_FILES.reports, `${n}.json`))) resources.push({ uri: `fabdesk://project/${pr.id}/reports/${n}`, name: `${pr.name} ${n} report`, mimeType: "application/json" });
          }
        }
        return { resources };
      },
    }),
    { title: "Report", description: "A JSON report: build, drc, erc, gate, spice", mimeType: "application/json" },
    async (uri, vars) => {
      const ctx = await project(String(vars["id"]));
      const name = String(vars["name"]).replace(/[^a-z0-9_-]/gi, "");
      const path = p(ctx.project!, PROJECT_FILES.reports, `${name}.json`);
      if (!(await exists(path))) throw new ToolError(`no report ${name}`, "not_found");
      return text(uri, "application/json", await readFile(path, "utf8"));
    },
  );
}

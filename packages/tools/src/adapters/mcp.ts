/**
 * MCP adapter: registers the registry on an `McpServer`. The core toolset is enabled; other
 * toolsets are registered disabled and switched on by `load_toolset` (list_changed fires).
 */
import { readFile, stat } from "node:fs/promises";
import { McpServer, ResourceTemplate, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ReadResourceResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
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

export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export type McpAttachment = {
  session: ToolSession;
  registered: Map<string, RegisteredTool>;
};

export type AttachOptions = {
  sessionId?: string;
  /** Toolsets enabled from the start; `core` is always enabled. */
  initialToolsets?: ToolsetId[];
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
        const progress = (pr: number, note?: string) => {
          if (progressToken === undefined) return;
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: Math.round(pr * 100), total: 100, ...(note ? { message: note } : {}) },
            })
            .catch(() => {});
        };
        try {
          const output = await registry.invoke(def.name, args, (projectRef) =>
            ctxFactory({ def, projectRef, signal: extra.signal, progress, session, sessionId, ...(extra.authInfo?.token ? { token: extra.authInfo.token } : {}) }),
          );
          return await toCallToolResult(output);
        } catch (e) {
          return errorResult(e);
        }
      },
    );
    registered.set(def.name, tool);
    if (!enabled.has(def.toolset)) tool.disable();
  }

  if (!opts.toolsOnly) {
    registerResources(server, registry, ctxFactory, session, sessionId);
  }

  return { session, registered };
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
    if (st.size > MAX_INLINE_IMAGE_BYTES) {
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
    "project-circuit",
    new ResourceTemplate("fabdesk://project/{id}/circuit.netlist.json", {
      list: async () => ({ resources: (await listProjects()).map((pr) => ({ uri: `fabdesk://project/${pr.id}/circuit.netlist.json`, name: `${pr.name} circuit.netlist.json`, mimeType: "application/json" })) }),
    }),
    { title: "circuit.netlist.json", description: "Optional circuit.netlist.json project file", mimeType: "application/json" },
    async (uri, vars) => {
      const ctx = await project(String(vars["id"]));
      const path = p(ctx.project!, PROJECT_FILES.netlistJson);
      return text(uri, "application/json", (await exists(path)) ? await readFile(path, "utf8") : "");
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
        source: await exists(p(pr, PROJECT_FILES.netlistJson)),
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

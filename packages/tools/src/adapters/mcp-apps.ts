import { FABPLANE_MARK_SVG } from "../apps/brand";
/**
 * MCP Apps + OpenAI MCP Extensions: interactive views that ChatGPT, Codex, Claude and other MCP Apps
 * hosts render next to the conversation (docs/mcp-extensions.md).
 *
 * - `board_viewer` (ui://fabdesk/boards): PCB / schematic SVG, 3D board, CAD drawings. OpenAI
 *   entrypoints: sidebar (global), thread tab, and a file handler for KiCad / DXF / STL / GLB files.
 * - `shopping_list_viewer` (ui://fabdesk/shopping): the fabplane.com shopping list and inventory.
 * - `fabdesk_ui_call` (app-only): the views' single door into the registry and preview helpers.
 * - `search_mentions` (app-only): composer @-mentions of projects, shopping lists and CAD files.
 *
 * Plain MCP clients that do not advertise `io.modelcontextprotocol/ui` never see these tools
 * (`auto` mode), so terminal agents keep the lean core list.
 */
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, sep, win32 } from "node:path";
import {
  ResourceTemplate,
  type McpServer,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ClientCapabilities,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { boardViewHtml, THREE_CDN } from "../apps/board-view";
import { dxfToSvg } from "../apps/dxf";
import { shoppingViewHtml } from "../apps/shopping-view";
import { PROJECT_FILES, exists, jailPath, readJsonOrNull } from "../fs";
import {
  ToolError,
  type ContextFactory,
  type ProjectHandle,
  type ToolContext,
  type ToolDef,
  type ToolRegistry,
  type ToolSession,
} from "../registry";
import type { CoreServices } from "../services";
import { p, requireBoard, requireKicad, requireSchematic } from "../tools/common";

/** MCP Apps extension id (SEP-1865) and its HTML profile. */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

export const UI_RESOURCES = {
  boards: "ui://fabdesk/boards",
  shopping: "ui://fabdesk/shopping",
} as const;

/** Tools this module registers, in registration order. */
export const MCP_APP_TOOLS = [
  "board_viewer",
  "shopping_list_viewer",
  "fabdesk_ui_call",
  "search_mentions",
] as const;

/**
 * `on`: always list the app tools. `auto`: list them once the client's `initialize` advertises MCP
 * Apps support. `off`: register nothing (native / substrate agent profiles).
 */
export type McpAppsMode = "on" | "auto" | "off";

/** Official monochrome fabPlane mark for host sidebar and entrypoint icons. */
export const FABDESK_ICON_SVG = FABPLANE_MARK_SVG;

/** `serverInfo.icons`: hosts fall back to it for entrypoint icons in the sidebar and tabs. */
export const FABDESK_SERVER_ICONS = [
  {
    src: `data:image/svg+xml;base64,${Buffer.from(FABDESK_ICON_SVG).toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];

/** File types the board viewer opens (file entrypoint and `drawing` previews). */
export const BOARD_FILE_EXTENSIONS = [".kicad_pcb", ".kicad_sch", ".dxf", ".svg", ".stl", ".glb"];
const CAD_EXTENSIONS = new Set([".dxf", ".svg", ".stl", ".glb"]);
const CAD_DIRS = ["exports", "renders", "mechanical", "cad", "enclosure"];
const MAX_CAD_FILES = 200;
/** Largest mesh or drawing sent to a view (base64 grows it by a third). */
export const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;

/** Registry tools the views may call through `fabdesk_ui_call`, whatever toolsets are loaded. */
export const UI_CALLABLE_TOOLS = new Set([
  "project_status",
  "verify_drc",
  "export_dxf",
  "export_stencil",
  "render_glb",
  "shopping_list_get",
  "shopping_list_add",
  "shopping_list_update",
  "shopping_list_remove",
  "shopping_list_sync_bom",
  "shopping_list_destinations",
  "inventory_search",
  // FreeCAD model (docs/fab-cad.md): export it for the drawings tab, open the live web UI.
  "cad_status",
  "cad_export",
  "cad_view",
]);

export function clientSupportsApps(caps: ClientCapabilities | undefined): boolean {
  const ext = (caps as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[
    MCP_APPS_EXTENSION
  ] as { mimeTypes?: unknown } | undefined;
  if (!ext) return false;
  return !Array.isArray(ext.mimeTypes) || ext.mimeTypes.includes(MCP_APP_MIME);
}

export type ProjectSummary = {
  id: string;
  name: string;
  built: boolean;
  hasSchematic: boolean;
  /** The project has a FreeCAD model (`model.FCStd`, `cad` toolset). */
  hasCadModel: boolean;
  lastDrc: { errors: number; warnings: number; unconnected: number } | null;
  lastRoute: { status: string; open: number | null } | null;
  /** Project-relative CAD drawings and meshes (DXF, SVG, STL, GLB). */
  cadFiles: string[];
};

export type PreviewPayload =
  | { kind: "svg"; title: string; sheets: Array<{ name: string; svg: string }>; notes?: string[] }
  | { kind: "mesh"; title: string; format: "glb" | "stl"; data: string; bytes: number };

type AppsDeps = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  session: ToolSession;
  sessionId: string;
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function registerMcpApps(
  server: McpServer,
  deps: AppsDeps,
  mode: Exclude<McpAppsMode, "off">,
): RegisteredTool[] {
  const context = async (projectRef: string | undefined, extra?: Extra): Promise<ToolContext> =>
    deps.ctxFactory({
      def: deps.registry.get("project_status") as ToolDef,
      projectRef,
      signal: extra?.signal ?? new AbortController().signal,
      progress: () => {},
      session: deps.session,
      sessionId: deps.sessionId,
      ...(extra?.authInfo?.token ? { token: extra.authInfo.token } : {}),
    });
  const invoke = (name: string, args: Record<string, unknown>, extra: Extra) =>
    deps.registry.invoke(name, args, (projectRef, def) =>
      deps.ctxFactory({
        def,
        projectRef,
        signal: extra.signal,
        progress: () => {},
        session: deps.session,
        sessionId: deps.sessionId,
        ...(extra.authInfo?.token ? { token: extra.authInfo.token } : {}),
      }),
    );
  const summaries = async (extra?: Extra) => {
    const ctx = await context(undefined, extra);
    return Promise.all(
      (await ctx.services.projects.list()).map((pr) => projectSummary(pr, ctx.services)),
    );
  };
  /** The selected project: explicit reference, else the session default (cwd / --project). */
  const pick = async (ref: string | undefined, extra: Extra) => (await context(ref, extra)).project;

  registerUiResources(server);
  registerProjectResources(server, deps, context);

  const tools: RegisteredTool[] = [];

  tools.push(
    server.registerTool(
      "board_viewer",
      {
        title: "fabPlane Boards",
        description:
          "Open the interactive fabPlane board viewer: the PCB and schematic as zoomable SVG, the 3D board (GLB) and CAD drawings (DXF / SVG / STL / GLB, including STL exports of the project's FreeCAD model) of a fabdesk project, with re-render, DRC, DXF export and FreeCAD export / open buttons. Use it when the user wants to see or show a board; for analysis use the regular tools. Returns the project list and the selected project's status as text for hosts without UI.",
        inputSchema: {
          project: z.string().min(1).optional().describe("Project id, name or absolute path"),
          view: z
            .enum(["pcb", "schematic", "3d", "drawings"])
            .optional()
            .describe("Tab to open (default pcb)"),
          drawing: z
            .string()
            .optional()
            .describe(
              "Project-relative CAD file to show in the drawings tab, e.g. exports/dxf/board-Edge_Cuts.dxf",
            ),
          file: z
            .object({ name: z.string(), resourceUri: z.string() })
            .optional()
            .describe("Set by the host when the user opens a file with the viewer"),
        } as unknown as ZodRawShapeCompat,
        annotations: {
          title: "fabPlane Boards",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: {
          ui: { resourceUri: UI_RESOURCES.boards },
          "openai/ui": {
            entrypoints: [
              { type: "global" },
              { type: "thread" },
              { type: "file", extensions: BOARD_FILE_EXTENSIONS },
            ],
          },
        },
      },
      async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
        const file = args["file"] as { name: string; resourceUri: string } | undefined;
        if (file)
          return {
            content: [{ type: "text", text: `Opened ${file.name} in the fabPlane Boards viewer.` }],
            structuredContent: { file: { name: file.name } },
          };
        const projects = await summaries(extra);
        const project = await pick(str(args["project"]), extra).catch(() => null);
        const view = str(args["view"]) ?? "pcb";
        const selected = projects.find((s) => s.id === project?.id) ?? null;
        return {
          content: [{ type: "text", text: boardViewerText(projects, selected, view) }],
          structuredContent: {
            projects,
            project: selected?.id ?? null,
            view,
            ...(str(args["drawing"]) ? { drawing: str(args["drawing"]) } : {}),
          },
        };
      },
    ),
  );

  tools.push(
    server.registerTool(
      "shopping_list_viewer",
      {
        title: "Shopping List",
        description:
          "Open the interactive fabplane.com shopping list of a fabdesk project: lines grouped by purchase destination with editable quantity, destination and status, BOM sync, quick add and a team-inventory search. Needs a fabplane sign-in. Returns the list as text too.",
        inputSchema: {
          project: z.string().min(1).optional().describe("Project id, name or absolute path"),
        } as unknown as ZodRawShapeCompat,
        annotations: {
          title: "Shopping List",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
          idempotentHint: true,
        },
        _meta: {
          ui: { resourceUri: UI_RESOURCES.shopping },
          "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
        },
      },
      async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
        const projects = await summaries(extra);
        const project = await pick(str(args["project"]), extra).catch(() => null);
        const selected = project ?? null;
        if (!selected)
          return {
            content: [
              {
                type: "text",
                text: projects.length
                  ? `Opened the shopping list viewer. Projects: ${projects.map((s) => s.name).join(", ")}.`
                  : "No fabPlane projects yet.",
              },
            ],
            structuredContent: { projects, project: projects[0]?.id ?? null },
          };
        try {
          const out = await invoke("shopping_list_get", { project: selected.id }, extra);
          return {
            content: [{ type: "text", text: out.text ?? "Shopping list" }],
            structuredContent: { projects, project: selected.id, list: out.json ?? null },
          };
        } catch (e) {
          const listError = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Shopping list for "${selected.name}": ${listError}` }],
            structuredContent: { projects, project: selected.id, list: null, listError },
          };
        }
      },
    ),
  );

  tools.push(
    server.registerTool(
      "fabdesk_ui_call",
      {
        title: "fabPlane view operation",
        description:
          "Used by the fabPlane interactive views only. Agents should call the regular fabdesk tools instead.",
        inputSchema: {
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
          project: z.string().optional(),
        } as unknown as ZodRawShapeCompat,
        // Dispatches to UI_CALLABLE_TOOLS, which include shopping_list_remove / _update / _sync_bom
        // (fabplane.com carts) and cad_export: as effectful as the most effectful of them.
        annotations: {
          title: "fabPlane view operation",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
          idempotentHint: false,
        },
        _meta: { ui: { visibility: ["app"] } },
      },
      async (raw: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
        const name = String(raw["name"]);
        const args = { ...((raw["arguments"] as Record<string, unknown> | undefined) ?? {}) };
        // The stdio proxy injects the detected project at the top level; views pass it inside.
        if (args["project"] === undefined && typeof raw["project"] === "string")
          args["project"] = raw["project"];
        try {
          const json = await uiOperation(name, args, extra);
          return { content: [{ type: "text", text: `${name}: ok` }], structuredContent: json };
        } catch (e) {
          const msg =
            e instanceof ToolError
              ? `${e.code}: ${e.message}`
              : e instanceof Error
                ? e.message
                : String(e);
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      },
    ),
  );

  const uiOperation = async (
    name: string,
    args: Record<string, unknown>,
    extra: Extra,
  ): Promise<Record<string, unknown>> => {
    switch (name) {
      case "projects":
        return { projects: await summaries(extra) };
      case "preview": {
        const ctx = await context(str(args["project"]), extra);
        const project = ctx.requireProject();
        const view = str(args["view"]) ?? "pcb";
        if (view !== "pcb" && view !== "schematic" && view !== "3d" && view !== "drawing")
          throw new ToolError(`unknown view ${view}`, "invalid_args");
        return await preview(ctx, project, view, str(args["path"]), args["refresh"] === true);
      }
      case "host_file": {
        const path = hostResourcePath(extra);
        if (!path)
          throw new ToolError(
            'the host did not provide the opened file\'s path (_meta["openai/resource"].path)',
            "unavailable",
          );
        const ctx = await context(undefined, extra);
        return await hostFilePreview(ctx, await projectFilePath(ctx, path), extra.signal);
      }
      case "convert": {
        const fileName = str(args["name"]) ?? "drawing.dxf";
        const text = typeof args["text"] === "string" ? args["text"] : "";
        if (text.length > MAX_PREVIEW_BYTES)
          throw new ToolError("file too large to preview", "invalid_args");
        return textPreview(fileName, text);
      }
      default: {
        if (!UI_CALLABLE_TOOLS.has(name))
          throw new ToolError(`${name} is not available to views`, "invalid_args");
        const out = await invoke(name, args, extra);
        if (out.isError) throw new ToolError(out.text ?? `${name} failed`, "internal");
        const json: Record<string, unknown> =
          out.json && typeof out.json === "object" && !Array.isArray(out.json)
            ? { ...(out.json as Record<string, unknown>) }
            : { result: out.json ?? null };
        // Views address drawings by project-relative path (export_dxf `files`, cad_export `path`).
        const dir =
          name === "export_dxf" || name === "export_stencil" || name === "cad_export"
            ? (await context(str(args["project"]), extra)).project?.dir
            : undefined;
        if (dir && Array.isArray(json["files"]))
          json["files"] = (json["files"] as string[]).map((f) => relative(dir, f));
        if (dir && typeof json["path"] === "string") json["path"] = relative(dir, json["path"]);
        return json;
      }
    }
  };

  tools.push(
    server.registerTool(
      "search_mentions",
      {
        title: "Search fabPlane",
        description:
          "Composer @-mention search over fabPlane projects, their shopping lists and CAD files. Used by the host UI.",
        inputSchema: { query: z.string() } as unknown as ZodRawShapeCompat,
        annotations: {
          title: "Search fabPlane",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: { "openai/extensions": { "mentions/search": {} }, ui: { visibility: ["app"] } },
      },
      async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
        const items = mentionItems(await summaries(extra), String(args["query"] ?? ""));
        return { content: [], structuredContent: { items } };
      },
    ),
  );

  if (mode === "auto") {
    for (const tool of tools) tool.disable();
    const previous = server.server.oninitialized;
    server.server.oninitialized = () => {
      previous?.();
      if (clientSupportsApps(server.server.getClientCapabilities()))
        for (const tool of tools) tool.enable();
    };
  }
  return tools;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function boardViewerText(
  projects: ProjectSummary[],
  selected: ProjectSummary | null,
  view: string,
): string {
  if (!projects.length)
    return "Opened the fabPlane Boards viewer. There are no fabPlane projects yet.";
  const line = (s: ProjectSummary) =>
    `- ${s.name} (${s.id}): ${s.built ? "board built" : "no board yet"}${s.lastDrc ? `, DRC ${s.lastDrc.errors} errors / ${s.lastDrc.warnings} warnings` : ""}${s.lastRoute ? `, route ${s.lastRoute.status}` : ""}${s.hasCadModel ? ", FreeCAD model" : ""}${s.cadFiles.length ? `, ${s.cadFiles.length} CAD file(s)` : ""}`;
  return [
    selected
      ? `Opened the fabPlane Boards viewer on "${selected.name}" (${view} view).`
      : "Opened the fabPlane Boards viewer.",
    "Projects:",
    ...projects.map(line),
  ].join("\n");
}

async function projectSummary(pr: ProjectHandle, services: CoreServices): Promise<ProjectSummary> {
  const drc = await readJsonOrNull<{
    counts?: { errors?: number; warnings?: number; unconnected?: number };
  }>(p(pr, PROJECT_FILES.reports, "drc.json")).catch(() => null);
  const route = services.routeRuns.latest(pr.id);
  return {
    id: pr.id,
    name: pr.name,
    built: await exists(p(pr, PROJECT_FILES.boardPcb)),
    hasSchematic: await exists(p(pr, PROJECT_FILES.boardSch)),
    hasCadModel: await exists(p(pr, PROJECT_FILES.cadModel)),
    lastDrc: drc?.counts
      ? {
          errors: drc.counts.errors ?? 0,
          warnings: drc.counts.warnings ?? 0,
          unconnected: drc.counts.unconnected ?? 0,
        }
      : null,
    lastRoute: route ? { status: route.status, open: route.result?.open?.length ?? null } : null,
    cadFiles: await cadFiles(pr.dir),
  };
}

/** CAD drawings and meshes under the conventional folders, project-relative, sorted. */
export async function cadFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_CAD_FILES || depth > 3) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child, depth + 1);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        // renders/*.svg are the PCB / schematic tabs, not drawings.
        if (
          CAD_EXTENSIONS.has(ext) &&
          !(ext === ".svg" && child.startsWith(`${PROJECT_FILES.renders}/`))
        )
          out.push(child);
      }
      if (out.length >= MAX_CAD_FILES) return;
    }
  };
  for (const d of CAD_DIRS) await walk(d, 1);
  return out.sort();
}

const newer = async (output: string, sources: string[]): Promise<boolean> => {
  const out = await stat(output).catch(() => null);
  if (!out) return false;
  for (const s of sources) {
    const src = await stat(s).catch(() => null);
    if (src && src.mtimeMs > out.mtimeMs) return false;
  }
  return true;
};

async function readCapped(path: string): Promise<Buffer> {
  const st = await stat(path);
  if (st.size > MAX_PREVIEW_BYTES)
    throw new ToolError(
      `${basename(path)} is ${st.size} bytes; the viewer takes up to ${MAX_PREVIEW_BYTES}`,
      "invalid_args",
    );
  return readFile(path);
}

function textPreview(name: string, text: string): PreviewPayload {
  const ext = extname(name).toLowerCase();
  if (ext === ".svg") return { kind: "svg", title: name, sheets: [{ name, svg: text }] };
  if (ext !== ".dxf")
    throw new ToolError(`cannot convert ${ext || name} to a drawing`, "invalid_args");
  const d = dxfToSvg(text);
  const skipped = Object.entries(d.skipped).map(([t, n]) => `${n} ${t}`);
  return {
    kind: "svg",
    title: `${name} · ${d.entities} entities${d.layers.length ? ` · layers ${d.layers.join(", ")}` : ""}`,
    sheets: [{ name, svg: d.svg }],
    ...(skipped.length ? { notes: [`not drawn: ${skipped.join(", ")}`] } : {}),
  };
}

async function filePreview(path: string, title: string): Promise<PreviewPayload> {
  const ext = extname(path).toLowerCase();
  const data = await readCapped(path);
  if (ext === ".glb" || ext === ".stl")
    return {
      kind: "mesh",
      title,
      format: ext === ".glb" ? "glb" : "stl",
      data: data.toString("base64"),
      bytes: data.byteLength,
    };
  return textPreview(title, data.toString("utf8"));
}

async function preview(
  ctx: ToolContext,
  project: ProjectHandle,
  view: "pcb" | "schematic" | "3d" | "drawing",
  path: string | undefined,
  refresh: boolean,
): Promise<PreviewPayload> {
  if (view === "drawing") {
    if (!path) throw new ToolError("path is required for the drawing view", "invalid_args");
    const abs = await jailPath(project.dir, path);
    if (!CAD_EXTENSIONS.has(extname(abs).toLowerCase()))
      throw new ToolError(`not a CAD drawing: ${path}`, "invalid_args");
    if (!(await exists(abs))) throw new ToolError(`${path} not found`, "not_found");
    return filePreview(abs, relative(project.dir, abs));
  }
  if (view === "pcb") {
    const board = await requireBoard(project);
    const output = p(project, PROJECT_FILES.renders, "pcb.svg");
    if (refresh || !(await newer(output, [board]))) {
      const cli = await requireKicad(ctx);
      await ctx.services.kicad.exportPcbSvg(cli, { board, output, signal: ctx.signal });
    }
    return {
      kind: "svg",
      title: PROJECT_FILES.boardPcb,
      sheets: [{ name: "PCB", svg: await readFile(output, "utf8") }],
    };
  }
  if (view === "schematic") {
    const schematic = await requireSchematic(project);
    const outDir = p(project, PROJECT_FILES.renders, "schematic");
    const cached = (await readdir(outDir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".svg"))
      .map((f) => join(outDir, f))
      .sort();
    let paths = cached;
    const fresh =
      cached.length > 0 &&
      (await Promise.all(cached.map((c) => newer(c, [schematic])))).every(Boolean);
    if (refresh || !fresh) {
      const cli = await requireKicad(ctx);
      paths = (
        await ctx.services.kicad.exportSchematicSvg(cli, { schematic, outDir, signal: ctx.signal })
      ).paths;
    }
    if (!paths.length) throw new ToolError("schematic export produced no sheets", "internal");
    return {
      kind: "svg",
      title: PROJECT_FILES.boardSch,
      sheets: await Promise.all(
        paths.map(async (s) => ({ name: basename(s, ".svg"), svg: await readFile(s, "utf8") })),
      ),
    };
  }
  const board = await requireBoard(project);
  const output = p(project, PROJECT_FILES.renders, "board.glb");
  if (refresh || !(await newer(output, [board]))) {
    const cli = await requireKicad(ctx);
    await ctx.services.kicad.exportGlb(cli, { board, output, signal: ctx.signal });
  }
  return filePreview(output, `${PROJECT_FILES.renders}/board.glb`);
}

/** The absolute path a host (ChatGPT / Codex file entrypoint) attached to an app's tool call. */
export function hostResourcePath(extra: { _meta?: Record<string, unknown> }): string | null {
  const path = (extra._meta?.["openai/resource"] as { path?: unknown } | undefined)?.path;
  return typeof path === "string" && (isAbsolute(path) || win32.isAbsolute(path)) ? path : null;
}

/**
 * The host-supplied path, resolved (symlinks and `..` included) to a file inside one of the
 * fabdesk projects, also resolved. The path comes from the MCP client, so without this any client
 * could read any .svg/.dxf/.stl/.glb on disk or hand kicad-cli any .kicad_* file.
 */
export async function projectFilePath(ctx: ToolContext, path: string): Promise<string> {
  const outside = () =>
    new ToolError(
      "the viewer only opens files inside a fabdesk project; open the project in fabdesk first",
      "invalid_args",
    );
  if (path.split(/[\\/]/).includes("..")) throw outside();
  const real = await realpath(path).catch(() => null);
  if (!real) throw new ToolError(`file not found: ${basename(path)}`, "not_found");
  for (const project of await ctx.services.projects.list()) {
    const dir = await realpath(project.dir).catch(() => null);
    if (!dir) continue;
    const rel = relative(dir, real);
    if (rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) return real;
  }
  throw outside();
}

async function hostFilePreview(
  ctx: ToolContext,
  path: string,
  signal: AbortSignal,
): Promise<PreviewPayload> {
  const ext = extname(path).toLowerCase();
  if (!BOARD_FILE_EXTENSIONS.includes(ext))
    throw new ToolError(`the viewer does not open ${ext || "this file"} files`, "invalid_args");
  if (ext !== ".kicad_pcb" && ext !== ".kicad_sch") return filePreview(path, basename(path));
  const cli = await requireKicad(ctx);
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-view-"));
  try {
    if (ext === ".kicad_pcb") {
      const output = join(scratch, "pcb.svg");
      await ctx.services.kicad.exportPcbSvg(cli, { board: path, output, signal });
      return {
        kind: "svg",
        title: basename(path),
        sheets: [{ name: "PCB", svg: await readFile(output, "utf8") }],
      };
    }
    const { paths } = await ctx.services.kicad.exportSchematicSvg(cli, {
      schematic: path,
      outDir: scratch,
      signal,
    });
    return {
      kind: "svg",
      title: basename(path),
      sheets: await Promise.all(
        paths
          .sort()
          .map(async (s) => ({ name: basename(s, ".svg"), svg: await readFile(s, "utf8") })),
      ),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export type MentionItem = {
  type: "resource_link";
  uri: string;
  name: string;
  title: string;
  description?: string;
  mimeType?: string;
};

const MENTION_LIMIT = 25;

export function mentionItems(projects: ProjectSummary[], query: string): MentionItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all: MentionItem[] = [];
  for (const s of projects) {
    const id = encodeURIComponent(s.id);
    all.push({
      type: "resource_link",
      uri: `fabdesk://project/${id}/board-summary`,
      name: s.name,
      title: `${s.name} board`,
      description: s.built ? "fabPlane PCB project" : "fabPlane project (no board yet)",
      mimeType: "application/json",
    });
    all.push({
      type: "resource_link",
      uri: `fabdesk://project/${id}/shopping-list`,
      name: `${s.name} shopping list`,
      title: `${s.name} shopping list`,
      description: "fabplane.com BOM cart",
      mimeType: "application/json",
    });
    for (const f of s.cadFiles)
      all.push({
        type: "resource_link",
        uri: `fabdesk://project/${id}/files/${encodeURIComponent(f)}`,
        name: basename(f),
        title: `${s.name}: ${f}`,
        description: "CAD file",
        mimeType: mimeFor(f),
      });
  }
  const hits = terms.length
    ? all.filter((it) => {
        const hay = `${it.title} ${it.name}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
    : all;
  return hits.slice(0, MENTION_LIMIT);
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".glb":
      return "model/gltf-binary";
    case ".stl":
      return "model/stl";
    case ".dxf":
      return "image/vnd.dxf";
    default:
      return "application/octet-stream";
  }
}

function registerUiResources(server: McpServer): void {
  // three.js (3D tab) is the only external origin; everything else is inline.
  const boardsMeta = {
    ui: { csp: { resourceDomains: [THREE_CDN] }, prefersBorder: true },
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
  };
  const shoppingMeta = {
    ui: { prefersBorder: true },
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
  };
  const html = (uri: URL, body: string, meta: Record<string, unknown>): ReadResourceResult => ({
    contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: body, _meta: meta }],
  });
  server.registerResource(
    "board-viewer-ui",
    UI_RESOURCES.boards,
    { title: "fabPlane Boards view", mimeType: MCP_APP_MIME, _meta: boardsMeta },
    (uri) => html(uri, boardViewHtml(), boardsMeta),
  );
  server.registerResource(
    "shopping-list-ui",
    UI_RESOURCES.shopping,
    { title: "Shopping list view", mimeType: MCP_APP_MIME, _meta: shoppingMeta },
    (uri) => html(uri, shoppingViewHtml(), shoppingMeta),
  );
}

/** Targets of @-mentions that the base adapter does not already serve. */
function registerProjectResources(
  server: McpServer,
  deps: AppsDeps,
  context: (ref: string | undefined) => Promise<ToolContext>,
): void {
  const project = async (id: string) => {
    const ctx = await context(id);
    if (!ctx.project) throw new ToolError(`project not found: ${id}`, "not_found");
    return ctx;
  };

  server.registerResource(
    "project-shopping-list",
    new ResourceTemplate("fabdesk://project/{id}/shopping-list", { list: undefined }),
    {
      title: "Shopping list",
      description: "The project's fabplane.com shopping list (BOM cart) as JSON",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const ctx = await project(decodeURIComponent(String(vars["id"])));
      const out = await deps.registry.invoke(
        "shopping_list_get",
        { project: ctx.project!.id },
        () => ctx,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(out.json ?? null, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "project-cad-file",
    new ResourceTemplate("fabdesk://project/{id}/files/{path}", { list: undefined }),
    {
      title: "CAD file",
      description: "A CAD drawing or mesh of the project (DXF, SVG, STL, GLB)",
    },
    async (uri, vars) => {
      const ctx = await project(decodeURIComponent(String(vars["id"])));
      const rel = decodeURIComponent(String(vars["path"]));
      const abs = await jailPath(ctx.project!.dir, rel);
      const ext = extname(abs).toLowerCase();
      if (!CAD_EXTENSIONS.has(ext)) throw new ToolError(`not a CAD file: ${rel}`, "invalid_args");
      const data = await readCapped(abs);
      const mimeType = mimeFor(abs);
      return {
        contents: [
          ext === ".dxf" || ext === ".svg"
            ? { uri: uri.href, mimeType, text: data.toString("utf8") }
            : { uri: uri.href, mimeType, blob: data.toString("base64") },
        ],
      };
    },
  );
}

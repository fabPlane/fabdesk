/** Core toolset: always loaded. Covers the happy path sketch → netlist → board → route → DRC → render. */
import { readdir } from "node:fs/promises";
import { z } from "zod/v4";
import type { FpPcbBoardSpec } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, mtimeMs, readJsonOrNull, writeJson } from "../fs";
import { ToolError, ToolsetId, defineTool, TOOLSETS, type ProjectHandle } from "../registry";
import type { BuildResult, DrcReport } from "../services";
import { VIAGRID_9055, viagrid9055BoardSpec } from "../templates/viagrid-9055";
import { fileUrl, loadNetlist, ok, p, requireKicad, table, writeReport } from "./common";
import { runRoute, RouteRunArgs } from "./route";

export const load_toolset = defineTool({
  name: "load_toolset",
  toolset: "core",
  scope: "global",
  title: "Load a toolset",
  description:
    "Enable an additional group of fabdesk tools for this session. Toolsets: project (read/write project files, sketches, board settings, adopt a KiCad board), circuit (query the board, footprint search), route (routing status/cancel/unroute/scope), kicad (board stats), verify (ERC, release gate), render (schematic/PCB SVG, 3D GLB), export (gerbers, drill, pick-and-place, BOM, netlist, zip), sim (SPICE netlist and simulation), app (screenshot and drive the fabPlane desktop app window: find/click/type, switch project, tab, thread, send chat messages, control Route Cinema; needs the app running in dev or with FABDESK_AUTOMATION=1). Call this before using a tool from that group; pcb_environment and the other core tools are always available.",
  inputSchema: {
    toolset: ToolsetId.describe("Toolset to enable"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ toolset }, ctx) => {
    if (ctx.session) ctx.session.enableToolset(toolset);
    const enabled = ctx.session ? ctx.session.enabledToolsets() : [...TOOLSETS];
    return ok(
      `Toolset "${toolset}" enabled. Enabled toolsets: ${enabled.join(", ")}. Tool list has been refreshed.`,
      { toolset, enabled },
    );
  },
});

/** Describe the workbench without prescribing which available lane the agent must use. */
export const pcb_environment = defineTool({
  name: "pcb_environment",
  toolset: "core",
  title: "Inspect the PCB workbench",
  description:
    "Return the current project paths, exact kicad-cli binary and version, FabPCB bridge status, desktop-UI availability, and supported MCP/CLI/UI/direct-file working lanes. circuit_build is a convenience workflow, not a required entry point.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const [cli, bridge, app] = await Promise.all([
      ctx.services.kicad.resolveCli().catch(() => null),
      ctx.services.design.status(),
      ctx.services.appBridge?.status().catch((error) => ({ running: false, reason: error instanceof Error ? error.message : String(error) })) ?? Promise.resolve({ running: false, reason: "desktop automation is not enabled" }),
    ]);
    const files = {
      project: p(project, PROJECT_FILES.boardPro),
      schematic: p(project, PROJECT_FILES.boardSch),
      board: p(project, PROJECT_FILES.boardPcb),
      source: p(project, PROJECT_FILES.netlistJson),
    };
    const present: Record<string, boolean> = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await exists(path)])));
    const lanes = {
      mcp: "Structured live KiCad/FabPCB operations and Fabdesk convenience workflows.",
      cli: "Use the exact kicad-cli path below for persisted-file ERC, DRC, render, and export operations.",
      ui: "Use the app toolset for visual inspection or interaction when desktop automation is available.",
      scripting: "Use scripts for file generation or analysis, report processing, geometry work, invoking kicad-cli, or other project-local tasks.",
    };
    const json = {
      project: { id: project.id, name: project.name, dir: project.dir, files, present },
      kicadCli: cli ? { path: cli.path, version: cli.version } : null,
      bridge,
      desktopUi: app,
      lanes,
      uiConventions: {
        canonicalFiles: files,
        renders: p(project, PROJECT_FILES.renders),
        reports: p(project, PROJECT_FILES.reports),
        exports: p(project, PROJECT_FILES.exports),
      },
      stateNote: "MCP tools may operate on live KiCad state; CLI and direct-file operations usually see persisted files. Save or reload deliberately when switching views.",
    };
    return ok([
      `PCB workbench for ${project.name} at ${project.dir}`,
      `KiCad CLI: ${cli ? `${cli.path} (${cli.version})` : "not found"}`,
      `FabPCB bridge: ${bridge.ok ? "ready" : "unavailable"} at ${bridge.url}${bridge.reason ? ` — ${bridge.reason}` : ""}`,
      `Routers: capacity=${bridge.routers?.capacity?.ok ? "ready" : `unavailable${bridge.routers?.capacity?.reason ? ` — ${bridge.routers.capacity.reason}` : ""}`}; freerouting=${bridge.routers?.freerouting?.ok ? "ready" : `unavailable${bridge.routers?.freerouting?.reason ? ` — ${bridge.routers.freerouting.reason}` : ""}`}`,
      `Desktop UI automation: ${app.running ? "available" : `unavailable${app.reason ? ` — ${app.reason}` : ""}`}`,
      `Project files: ${Object.entries(files).map(([name, path]) => `${name}=${path}${present[name] ? "" : " (missing)"}`).join(", ")}`,
      "Working lanes: MCP for live structured operations; bundled CLI for persisted files; UI for visual work; scripts for direct file/report work or other project-local tasks.",
      "Fabdesk UI directories: renders/, reports/, exports/.",
      "MCP may expose live KiCad state while CLI and file operations see persisted state; save or reload deliberately when switching between them.",
    ].join("\n"), json);
  },
});

export const project_status = defineTool({
  name: "project_status",
  toolset: "core",
  title: "Project status",
  description:
    "Summarise the current project: id, directory, board settings, which artifacts exist (circuit.netlist.json, board.kicad_pcb, board.kicad_sch), last build result, latest route run, and available reports.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const manifest = project.manifest();
    const files: Record<string, { exists: boolean; mtime?: string }> = {};
    for (const rel of [PROJECT_FILES.netlistJson, PROJECT_FILES.boardPcb, PROJECT_FILES.boardSch]) {
      const m = await mtimeMs(p(project, rel));
      files[rel] =
        m === null ? { exists: false } : { exists: true, mtime: new Date(m).toISOString() };
    }
    const build = await readJsonOrNull<BuildSummary>(
      p(project, PROJECT_FILES.reports, "build.json"),
    );
    const reports = (await readdir(p(project, PROJECT_FILES.reports)).catch(() => [])).filter((f) =>
      f.endsWith(".json"),
    );
    const sketches = (await readdir(p(project, PROJECT_FILES.sketches)).catch(() => [])).filter(
      (f) => /\.(png|jpe?g|svg)$/i.test(f),
    );
    const route = ctx.services.routeRuns.latest(project.id);
    const drc = await readJsonOrNull<DrcReport>(p(project, PROJECT_FILES.reports, "drc.json"));
    const json = {
      id: project.id,
      name: project.name,
      dir: project.dir,
      board: manifest.board,
      router: manifest.router,
      files,
      sketches: sketches.map((s) => `${PROJECT_FILES.sketches}/${s}`),
      lastBuild: build
        ? {
            ok: build.ok,
            errors: build.errors.length,
            warnings: build.warnings.length,
            at: build.at,
          }
        : null,
      lastRoute: route
        ? { runId: route.id, status: route.status, open: route.result?.open.length ?? null }
        : null,
      lastDrc: drc ? drc.counts : null,
      reports: reports.map((r) => `${PROJECT_FILES.reports}/${r}`),
      enabledToolsets: ctx.session?.enabledToolsets() ?? [...TOOLSETS],
    };
    const lines = [
      `Project "${project.name}" (${project.id}) at ${project.dir}`,
      `Board: ${manifest.board.layers} layers${manifest.board.widthMm ? `, ${manifest.board.widthMm}×${manifest.board.heightMm ?? "?"} mm` : ""}; router: ${manifest.router}`,
      `Files: ${Object.entries(files)
        .map(([k, v]) => `${k}=${v.exists ? "yes" : "no"}`)
        .join(", ")}`,
      `Sketches: ${sketches.length ? sketches.join(", ") : "none"}`,
      `Last build: ${build ? `${build.ok ? "ok" : "FAILED"} (${build.errors.length} errors, ${build.warnings.length} warnings)` : "never"}`,
      `Last route: ${route ? `${route.status} (${route.result ? `${route.result.open.length} open` : "no result"})` : "never"}`,
      `Last DRC: ${drc ? `${drc.counts.errors} errors, ${drc.counts.warnings} warnings, ${drc.counts.unconnected} unconnected` : "never"}`,
      "Workflow: write circuit.netlist.json (project_write_file) → circuit_build → circuit_read_errors → route_run → verify_drc → render_board.",
    ];
    return ok(lines.join("\n"), json);
  },
});

export type BuildSummary = {
  ok: boolean;
  at: string;
  rebuild: "preserve" | "clean";
  durationMs: number;
  errors: BuildResult["errors"];
  warnings: BuildResult["warnings"];
  counts: BuildResult["counts"];
  revision?: number;
  removedCopper?: { tracks: number; vias: number };
  rejectedSchematicPath?: string;
};

/**
 * What circuit_build sends as the board spec on top of the netlist file's own: a template's blank
 * (which replaces the file's board entirely), or the manifest's rules and size (`fabdesk.json`
 * board.rules / widthMm / heightMm) merged into it. `undefined` when the file's board stands as is.
 */
export async function buildBoardSpec(project: ProjectHandle): Promise<FpPcbBoardSpec | undefined> {
  const m = project.manifest().board;
  if (m.template === VIAGRID_9055.id) return viagrid9055BoardSpec();
  const r = m.rules ?? {};
  const rules = {
    ...(r.clearanceMm !== undefined ? { clearanceMm: r.clearanceMm } : {}),
    ...(r.traceWidthMm !== undefined ? { trackWidthMm: r.traceWidthMm } : {}),
    ...(r.viaDiameterMm !== undefined ? { viaDiameterMm: r.viaDiameterMm } : {}),
    ...(r.viaDrillMm !== undefined ? { viaDrillMm: r.viaDrillMm } : {}),
  };
  const file = await loadNetlist(project).catch(() => null);
  const own = file?.board;
  const hasOutline = Boolean(own?.outline?.length || (own?.widthMm && own?.heightMm));
  const size =
    !hasOutline && m.widthMm && m.heightMm ? { widthMm: m.widthMm, heightMm: m.heightMm } : {};
  if (!Object.keys(rules).length && !Object.keys(size).length) return undefined;
  return {
    ...(own ?? {}),
    ...size,
    ...(Object.keys(rules).length ? { rules: { ...(own?.rules ?? {}), ...rules } } : {}),
  };
}

export const circuit_build = defineTool({
  name: "circuit_build",
  toolset: "core",
  title: "Build the board",
  description:
    "Compile circuit.netlist.json into board.kicad_pcb and a generated board.kicad_sch. Footprints are pulled from KiCad libraries, explicitly placed when board.placements names them, and connected into the ratsnest; libSource draws searchable schematic symbols with labelled wire stubs. Returns actionable errors/warnings. Rebuilds replace only generated schematic items, preserve manual schematic work and unlisted manual footprint placement, keep tracks whose nets still exist, and remove footprints the netlist no longer names.",
  inputSchema: {
    entrypoint: z
      .string()
      .optional()
      .describe("Netlist file relative to the project, default circuit.netlist.json"),
    rebuild: z
      .enum(["preserve", "clean"])
      .default("preserve")
      .describe(
        "preserve keeps compatible existing copper; clean removes routed tracks/arcs/vias after source validation before rebuilding",
      ),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ entrypoint, rebuild }, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.05, "building");
    const board = await buildBoardSpec(project);
    const result = await ctx.services.design.build({
      projectDir: project.dir,
      ...(entrypoint ? { entrypoint } : {}),
      ...(board ? { board } : {}),
      rebuild,
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(0.05 + fraction * 0.9, note),
    });
    const summary: BuildSummary = {
      ok: result.ok,
      at: new Date().toISOString(),
      rebuild,
      durationMs: result.durationMs,
      errors: result.errors,
      warnings: result.warnings,
      counts: result.counts,
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      ...(result.removedCopper ? { removedCopper: result.removedCopper } : {}),
      ...(result.rejectedSchematicPath ? { rejectedSchematicPath: result.rejectedSchematicPath } : {}),
    };
    await writeReport(project, "build", summary);
    ctx.progress(1, "done");
    const c = result.counts;
    const text = result.ok
      ? `Build OK (${rebuild} rebuild) in ${Math.round(result.durationMs)} ms: ${c.components} components, ${c.nets} nets, ${c.footprintsAdded} footprints added, ${c.footprintsPlaced} placed${result.removedCopper ? `, ${result.removedCopper.tracks} old tracks/arcs and ${result.removedCopper.vias} routed vias removed` : ""}${c.viasAdded ? `, blank drawn (${c.viasAdded} free vias, ${c.holesAdded ?? 0} holes)` : ""}.${project.manifest().board.template ? ` Template ${project.manifest().board.template}: the netlist's own board spec was replaced by the blank.` : ""}${result.warnings.length ? `\nWarnings:\n${formatErrors(result.warnings)}` : ""}`
      : `Build FAILED (${result.errors.length} errors):\n${formatErrors(result.errors)}${result.rejectedSchematicPath ? `\nRejected schematic preserved at ${result.rejectedSchematicPath}; the canonical schematic was restored.` : ""}`;
    return { text, json: summary, isError: !result.ok };
  },
});

export function formatErrors(errs: BuildResult["errors"]): string {
  return errs
    .slice(0, 50)
    .map(
      (e) =>
        `- ${e.file ?? PROJECT_FILES.netlistJson}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}${e.type ? ` [${e.type}]` : ""}: ${e.message}`,
    )
    .join("\n");
}

export const circuit_read_errors = defineTool({
  name: "circuit_read_errors",
  toolset: "core",
  title: "Read build errors",
  description:
    "Return the errors and warnings of the last circuit_build (from reports/build.json). Use it to decide what to fix in circuit.netlist.json.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const build = await readJsonOrNull<BuildSummary>(
      p(project, PROJECT_FILES.reports, "build.json"),
    );
    if (!build) return ok("No build yet. Run circuit_build.", { build: null });
    const parts = [
      `Last build (${build.at}): ${build.ok ? "ok" : "failed"}, ${build.errors.length} errors, ${build.warnings.length} warnings`,
    ];
    if (build.errors.length) parts.push(`Errors:\n${formatErrors(build.errors)}`);
    if (build.warnings.length) parts.push(`Warnings:\n${formatErrors(build.warnings)}`);
    return ok(parts.join("\n\n"), { build });
  },
});

export const route_run = defineTool({
  name: "route_run",
  toolset: "core",
  title: "Autoroute the board",
  description:
    "Autoroute the canonical board on the design server (capacity: the built-in JS router; freerouting: internal builds only). Streams progress frames to the app, persists them under .fabdesk/runs/<runId>/frames.jsonl, applies tracks to the live board as one undo entry, saves it, and returns open connections plus track/via counts. The board may come from circuit_build, project_import_kicad, native KiCad work, or another method. Use onlyConnections to limit a run to named nets.",
  inputSchema: RouteRunArgs,
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: (args, ctx) =>
    runRoute(
      {
        timeoutMs: args.timeoutMs,
        ...(args.router ? { router: args.router } : {}),
        ...(args.onlyConnections ? { onlyConnections: args.onlyConnections } : {}),
        ...(args.settings ? { settings: args.settings } : {}),
      },
      ctx,
    ),
});

export const verify_drc = defineTool({
  name: "verify_drc",
  toolset: "core",
  title: "Run KiCad DRC",
  description:
    "Run KiCad design rule check on board.kicad_pcb. Writes reports/drc.json and returns error/warning/unconnected counts with the first violations. Requires kicad-cli and circuit_build.",
  inputSchema: {
    severity: z
      .enum(["all", "error"])
      .default("all")
      .describe("Report all severities or errors only"),
    schematicParity: z
      .boolean()
      .default(false)
      .describe("Also check PCB↔schematic parity (requires libSource for generated symbols)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(30)
      .describe("Max violations to include in the text summary"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ severity, schematicParity, limit }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board)))
      throw new ToolError("board.kicad_pcb not found: run circuit_build first", "precondition");
    ctx.progress(0.4, "running DRC");
    const outFile = p(project, PROJECT_FILES.reports, "drc.json");
    const report = await ctx.services.kicad.runDrc(cli, {
      board,
      outFile,
      severity,
      schematicParity,
      signal: ctx.signal,
    });
    await writeJson(outFile, report);
    ctx.progress(1, "done");
    const c = report.counts;
    const lines = [`DRC: ${c.errors} errors, ${c.warnings} warnings, ${c.unconnected} unconnected`];
    const show = (label: string, items: unknown[]) => {
      if (!items.length) return;
      lines.push(`${label} (${items.length}${items.length > limit ? `, showing ${limit}` : ""}):`);
      for (const v of items.slice(0, limit)) lines.push(`- ${describeViolation(v)}`);
    };
    show("Violations", report.violations);
    show("Unconnected", report.unconnected);
    show("Schematic parity", report.schematicParity);
    // The full report can run to hundreds of KiB (KiCad repeats a library warning per footprint), which
    // exceeds what an agent may receive from one tool call; the JSON carries counts by rule and the first
    // `limit` of each list, the complete report stays in reports/drc.json.
    const byRule = (items: unknown[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const v of items as Array<Record<string, unknown>>) {
        const key = String(v["rule"] ?? v["type"] ?? "unknown");
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    const json = {
      counts: c,
      reportPath: outFile,
      byRule: {
        violations: byRule(report.violations),
        unconnected: byRule(report.unconnected),
        schematicParity: byRule(report.schematicParity),
      },
      violations: report.violations.slice(0, limit),
      unconnected: report.unconnected.slice(0, limit),
      schematicParity: report.schematicParity.slice(0, limit),
      truncated:
        report.violations.length > limit ||
        report.unconnected.length > limit ||
        report.schematicParity.length > limit,
    };
    if (json.truncated) lines.push(`Full report with every violation: ${outFile}`);
    return { text: lines.join("\n"), json, isError: c.errors > 0 || c.unconnected > 0 };
  },
});

export function describeViolation(v: unknown): string {
  if (!v || typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const sev = o["severity"] ?? "";
  const type = o["type"] ?? "";
  const desc = o["description"] ?? o["message"] ?? "";
  const rule = o["rule"] ?? type;
  const items = Array.isArray(o["items"])
    ? (o["items"] as Array<Record<string, unknown>>)
        .map((i) => i["description"])
        .filter(Boolean)
        .join("; ")
    : "";
  const pos =
    Array.isArray(o["items"]) && (o["items"] as Array<Record<string, unknown>>)[0]?.["pos"];
  const posStr =
    pos && typeof pos === "object"
      ? ` @(${(pos as Record<string, unknown>)["x"]}, ${(pos as Record<string, unknown>)["y"]})`
      : "";
  return `[${sev}] ${rule}: ${desc}${items ? ` — ${items}` : ""}${posStr}`;
}

export const render_board = defineTool({
  name: "render_board",
  toolset: "core",
  title: "Render board image",
  description:
    "Render a PNG of the KiCad board (top or bottom, raytraced optional) to renders/<view>.png and return it as an image so you can inspect placement and routing. Requires kicad-cli and circuit_build.",
  inputSchema: {
    view: z.enum(["top", "bottom", "perspective", "side"]).default("top"),
    width: z.number().int().min(128).max(4096).default(1024),
    height: z.number().int().min(128).max(4096).default(768),
    quality: z.enum(["basic", "high"]).default("basic").describe("basic is fast; high raytraces"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ view, width, height, quality }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board)))
      throw new ToolError("board.kicad_pcb not found: run circuit_build first", "precondition");
    const output = p(project, PROJECT_FILES.renders, `${view}.png`);
    ctx.progress(0.3, "rendering");
    await ctx.services.kicad.renderPng(cli, {
      board,
      output,
      view,
      width,
      height,
      quality,
      signal: ctx.signal,
    });
    ctx.progress(1, "done");
    const url = fileUrl(output);
    return ok(
      `Rendered ${view} view to ${PROJECT_FILES.renders}/${view}.png (${width}×${height}). Browser URL: ${url}`,
      { path: output, url, fileUrl: url, view, width, height },
      { images: [{ path: output, mime: "image/png" }] },
    );
  },
});

export const coreTools = [
  load_toolset,
  pcb_environment,
  project_status,
  circuit_build,
  circuit_read_errors,
  route_run,
  verify_drc,
  render_board,
];
export { table };

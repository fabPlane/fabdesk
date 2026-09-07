/** Core toolset: always loaded. Covers the happy path sketch → circuit → route → DRC → render. */
import { readdir } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, mtimeMs, readJsonOrNull, writeJson } from "../fs";
import { ToolError, ToolsetId, defineTool, TOOLSETS, type ProjectHandle } from "../registry";
import type { BuildResult, DrcReport } from "../services";
import { loadCircuitJson, ok, p, requireKicad, table, writeReport } from "./common";
import { runRoute, RouteRunArgs } from "./route";
import { convertProject } from "./kicad";

export const load_toolset = defineTool({
  name: "load_toolset",
  toolset: "core",
  scope: "global",
  title: "Load a toolset",
  description:
    "Enable an additional group of fabdesk tools for this session. Toolsets: project (read/write project files, sketches, board settings), circuit (query circuit elements, run design checks, search the tscircuit part registry), route (routing status/cancel/unroute), kicad (convert to KiCad, board stats), verify (ERC, release gate), render (schematic/PCB SVG, 3D GLB), export (gerbers, drill, pick-and-place, BOM, netlist, zip), sim (SPICE netlist and simulation), app (screenshot and drive the fabPlane desktop app window: find/click/type, switch project, tab, thread, send chat messages, control Route Cinema; needs the app running in dev or with FABDESK_AUTOMATION=1). Call this before using a tool from that group; the core tools (project_status, circuit_build, circuit_read_errors, route_run, verify_drc, render_board) are always available.",
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

export const project_status = defineTool({
  name: "project_status",
  toolset: "core",
  title: "Project status",
  description:
    "Summarise the current project: id, directory, board settings, which artefacts exist (circuit.tsx, circuit.json, circuit.routed.json, KiCad board), last build error count, latest route run and available reports. Call it first to learn the file contract before writing circuit.tsx.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const manifest = project.manifest();
    const files: Record<string, { exists: boolean; mtime?: string }> = {};
    for (const rel of [PROJECT_FILES.circuitTsx, PROJECT_FILES.circuitJson, PROJECT_FILES.routedJson, PROJECT_FILES.boardPcb, PROJECT_FILES.boardSch]) {
      const m = await mtimeMs(p(project, rel));
      files[rel] = m === null ? { exists: false } : { exists: true, mtime: new Date(m).toISOString() };
    }
    const build = await readJsonOrNull<BuildSummary>(p(project, PROJECT_FILES.reports, "build.json"));
    const reports = (await readdir(p(project, PROJECT_FILES.reports)).catch(() => [])).filter((f) => f.endsWith(".json"));
    const sketches = (await readdir(p(project, PROJECT_FILES.sketches)).catch(() => [])).filter((f) => /\.(png|jpe?g|svg)$/i.test(f));
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
      lastBuild: build ? { ok: build.ok, errors: build.errors.length, warnings: build.warnings.length, at: build.at } : null,
      lastRoute: route ? { runId: route.id, status: route.status, complete: route.result?.complete.length ?? null, open: route.result?.open.length ?? null } : null,
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
      `Last route: ${route ? `${route.status} (${route.result ? `${route.result.complete.length} complete, ${route.result.open.length} open` : "no result"})` : "never"}`,
      `Last DRC: ${drc ? `${drc.counts.errors} errors, ${drc.counts.warnings} warnings, ${drc.counts.unconnected} unconnected` : "never"}`,
      "Workflow: write circuit.tsx (project_write_file) → circuit_build → circuit_read_errors → route_run → verify_drc → render_board.",
    ];
    return ok(lines.join("\n"), json);
  },
});

export type BuildSummary = {
  ok: boolean;
  at: string;
  durationMs: number;
  errors: BuildResult["errors"];
  warnings: BuildResult["warnings"];
  elementCounts: Record<string, number>;
};

export const circuit_build = defineTool({
  name: "circuit_build",
  toolset: "core",
  title: "Build the circuit",
  description:
    "Compile the project's circuit source into circuit.json (no autorouting): circuit.tsx with tscircuit, or circuit.netlist.json through FabPlane PCB when the fp-pcb compiler is selected (that path also writes board.kicad_pcb and marks it the source of truth). Returns ok/errors/warnings with positions and element counts. On failure fix the source and build again; routing, conversion and verification all consume the output of this step. Invalidates circuit.routed.json.",
  inputSchema: {
    entrypoint: z.string().optional().describe("Entry file relative to the project, default circuit.tsx (a *.netlist.json entry selects the fp-pcb compiler)"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ entrypoint }, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.05, "building");
    const result = await ctx.services.tscircuit.buildCircuit({
      projectDir: project.dir,
      ...(entrypoint ? { entrypoint } : {}),
      cacheDir: p(project, PROJECT_FILES.cache),
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(0.05 + fraction * 0.8, note),
    });
    ctx.progress(0.9, "writing circuit.json");
    if (result.ok || result.circuitJson.length > 0) await writeJson(p(project, PROJECT_FILES.circuitJson), result.circuitJson);
    // A rebuilt circuit invalidates previous routing.
    const routed = p(project, PROJECT_FILES.routedJson);
    if (await exists(routed)) await Bun.file(routed).delete().catch(() => {});
    const summary: BuildSummary = {
      ok: result.ok,
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      errors: result.errors,
      warnings: result.warnings,
      elementCounts: result.elementCounts,
    };
    await writeReport(project, "build", summary);
    // Record who owns board.kicad_pcb now (see BoardSettings.source); only a successful build changes hands.
    const boardSource = result.boardSource ?? "tscircuit";
    if (result.ok && project.manifest().board.source !== boardSource) await project.updateManifest({ board: { ...project.manifest().board, source: boardSource } });
    ctx.progress(1, "done");
    const text = result.ok
      ? `Build OK in ${Math.round(result.durationMs)} ms. Elements: ${Object.entries(result.elementCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}${result.warnings.length ? `\nWarnings:\n${formatErrors(result.warnings)}` : ""}`
      : `Build FAILED (${result.errors.length} errors):\n${formatErrors(result.errors)}`;
    return { text, json: summary, isError: !result.ok };
  },
});

export function formatErrors(errs: BuildResult["errors"]): string {
  return errs
    .slice(0, 50)
    .map((e) => `- ${e.file ?? "circuit.tsx"}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}${e.type ? ` [${e.type}]` : ""}: ${e.message}`)
    .join("\n");
}

export const circuit_read_errors = defineTool({
  name: "circuit_read_errors",
  toolset: "core",
  title: "Read build errors",
  description:
    "Return the errors and warnings of the last circuit_build (from reports/build.json) plus any *_error elements present in circuit.json (e.g. pcb_placement_error, source_failed_to_create_component_error). Use it to decide what to fix in circuit.tsx.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const build = await readJsonOrNull<BuildSummary>(p(project, PROJECT_FILES.reports, "build.json"));
    let elementErrors: unknown[] = [];
    const cj = await readJsonOrNull<unknown[]>(p(project, PROJECT_FILES.circuitJson));
    if (cj) elementErrors = ctx.services.tscircuit.queryCircuit(cj, "errors");
    if (!build && !cj) return ok("No build yet. Run circuit_build.", { build: null, elementErrors: [] });
    const parts: string[] = [];
    if (build) {
      parts.push(`Last build (${build.at}): ${build.ok ? "ok" : "failed"}, ${build.errors.length} errors, ${build.warnings.length} warnings`);
      if (build.errors.length) parts.push(`Errors:\n${formatErrors(build.errors)}`);
      if (build.warnings.length) parts.push(`Warnings:\n${formatErrors(build.warnings)}`);
    }
    parts.push(
      elementErrors.length
        ? `Error elements in circuit.json (${elementErrors.length}):\n${table(elementErrors.slice(0, 50) as Array<Record<string, unknown>>, ["type", "message"])}`
        : "No error elements in circuit.json.",
    );
    return ok(parts.join("\n\n"), { build, elementErrors });
  },
});

export const route_run = defineTool({
  name: "route_run",
  toolset: "core",
  title: "Autoroute the board",
  description:
    "Autoroute the built circuit (circuit.json → circuit.routed.json). Streams live routing frames to the app, persists them under .fabdesk/runs/<runId>/frames.jsonl and returns which connections completed or stayed open plus via/segment counts. Requires circuit_build. Use route_unroute + route_run with onlyConnections to redo specific nets.",
  inputSchema: RouteRunArgs,
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: (args, ctx) =>
    runRoute(
      {
        timeoutMs: args.timeoutMs,
        ...(args.router ? { router: args.router } : {}),
        ...(args.onlyConnections ? { onlyConnections: args.onlyConnections } : {}),
        ...(args.minTraceWidth !== undefined ? { minTraceWidth: args.minTraceWidth } : {}),
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
    "Run KiCad design rule check on board.kicad_pcb (converting circuit.routed.json/circuit.json to KiCad first when the board is missing or stale). Writes reports/drc.json and returns error/warning/unconnected counts with the first violations. Requires kicad-cli.",
  inputSchema: {
    severity: z.enum(["all", "error"]).default("all").describe("Report all severities or errors only"),
    schematicParity: z.boolean().default(false).describe("Also check PCB↔schematic parity"),
    convert: z.boolean().default(true).describe("Convert to KiCad first when the board is missing or older than the circuit"),
    limit: z.number().int().min(1).max(200).default(30).describe("Max violations to include in the text summary"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ severity, schematicParity, convert, limit }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    if (convert) {
      const stale = await boardIsStale(project);
      if (stale) {
        ctx.progress(0.1, "converting to KiCad");
        await convertProject(ctx);
      }
    }
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found: run kicad_convert first", "precondition");
    ctx.progress(0.4, "running DRC");
    const outFile = p(project, PROJECT_FILES.reports, "drc.json");
    const report = await ctx.services.kicad.runDrc(cli, { board, outFile, severity, schematicParity, signal: ctx.signal });
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
    return { text: lines.join("\n"), json: report, isError: c.errors > 0 || c.unconnected > 0 };
  },
});

export function describeViolation(v: unknown): string {
  if (!v || typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const sev = o["severity"] ?? "";
  const type = o["type"] ?? "";
  const desc = o["description"] ?? o["message"] ?? "";
  const rule = o["rule"] ?? type;
  const items = Array.isArray(o["items"]) ? (o["items"] as Array<Record<string, unknown>>).map((i) => i["description"]).filter(Boolean).join("; ") : "";
  const pos = Array.isArray(o["items"]) && (o["items"] as Array<Record<string, unknown>>)[0]?.["pos"];
  const posStr = pos && typeof pos === "object" ? ` @(${(pos as Record<string, unknown>)["x"]}, ${(pos as Record<string, unknown>)["y"]})` : "";
  return `[${sev}] ${rule}: ${desc}${items ? ` — ${items}` : ""}${posStr}`;
}

/**
 * Whether `board.kicad_pcb` needs regenerating from circuit.json. Never when the FabPlane PCB
 * compiler wrote the board (`board.source === "kicad"`): circuit.json was imported *from* it, and
 * converting back would discard the real board.
 */
export async function boardIsStale(project: Pick<ProjectHandle, "dir" | "manifest">): Promise<boolean> {
  const board = await mtimeMs(p(project as never, PROJECT_FILES.boardPcb));
  if (board === null) return true;
  if (project.manifest().board.source === "kicad") return false;
  const src = Math.max((await mtimeMs(p(project as never, PROJECT_FILES.routedJson))) ?? 0, (await mtimeMs(p(project as never, PROJECT_FILES.circuitJson))) ?? 0);
  return src > board;
}

export const render_board = defineTool({
  name: "render_board",
  toolset: "core",
  title: "Render board image",
  description:
    "Render a PNG of the KiCad board (top or bottom, raytraced optional) to renders/<view>.png and return it as an image so you can inspect placement and routing. Requires kicad-cli and a converted board (verify_drc/kicad_convert create it).",
  inputSchema: {
    view: z.enum(["top", "bottom", "perspective", "side"]).default("top"),
    width: z.number().int().min(128).max(4096).default(1024),
    height: z.number().int().min(128).max(4096).default(768),
    quality: z.enum(["basic", "high"]).default("basic").describe("basic is fast; high raytraces"),
    convert: z.boolean().default(true).describe("Convert to KiCad first when the board is missing or stale"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ view, width, height, quality, convert }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    if (convert && (await boardIsStale(project))) {
      ctx.progress(0.1, "converting to KiCad");
      await convertProject(ctx);
    }
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found: run kicad_convert first", "precondition");
    const output = p(project, PROJECT_FILES.renders, `${view}.png`);
    ctx.progress(0.3, "rendering");
    await ctx.services.kicad.renderPng(cli, { board, output, view, width, height, quality, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Rendered ${view} view to ${PROJECT_FILES.renders}/${view}.png (${width}×${height}).`, { path: output, view, width, height }, { images: [{ path: output, mime: "image/png" }] });
  },
});

export const coreTools = [load_toolset, project_status, circuit_build, circuit_read_errors, route_run, verify_drc, render_board];

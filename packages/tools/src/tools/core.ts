/** Core toolset: always loaded. */
import { createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { z } from "zod/v4";
import type { FpPcbBoardSpec } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, mtimeMs, readJsonOrNull, writeJson } from "../fs";
import { ToolError, ToolsetId, defineTool, TOOLSETS, type ProjectHandle } from "../registry";
import type { BuildResult, DesignRow, DesignSelect, DrcReport, DrcViolation } from "../services";
import { VIAGRID_9055, viagrid9055BoardSpec } from "../templates/viagrid-9055";
import { fileUrl, loadNetlist, ok, p, requireKicad, table, writeReport } from "./common";
import { runRoute, RouteRunArgs } from "./route";

export const load_toolset = defineTool({
  name: "load_toolset",
  toolset: "core",
  scope: "global",
  title: "Load a toolset",
  description:
    "Enable an additional group of fabdesk tools for this session. Available toolsets are project, circuit, route, kicad, verify, render, export, sim, and app. Core tools are always available.",
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

/** Describe the available workbench interfaces. */
export const pcb_environment = defineTool({
  name: "pcb_environment",
  toolset: "core",
  title: "Inspect the PCB workbench",
  description:
    "Return current project paths, kicad-cli identity, FabPCB bridge status, desktop-UI availability, and available interfaces.",
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
    const interfaces = {
      mcp: "Structured KiCad, FabPCB, project, render, verification, and export operations.",
      cli: "Bundled kicad-cli path and version.",
      ui: "Desktop application automation status.",
      files: "Project-local files are directly accessible.",
    };
    const json = {
      project: { id: project.id, name: project.name, dir: project.dir, files, present },
      kicadCli: cli ? { path: cli.path, version: cli.version } : null,
      bridge,
      desktopUi: app,
      interfaces,
      uiConventions: {
        canonicalFiles: files,
        renders: p(project, PROJECT_FILES.renders),
        reports: p(project, PROJECT_FILES.reports),
        exports: p(project, PROJECT_FILES.exports),
      },
      stateVisibility: "MCP operations may address live KiCad state; CLI and direct-file operations address persisted files.",
    };
    return ok([
      `PCB workbench for ${project.name} at ${project.dir}`,
      `KiCad CLI: ${cli ? `${cli.path} (${cli.version})` : "not found"}`,
      `FabPCB bridge: ${bridge.ok ? "ready" : "unavailable"} at ${bridge.url}${bridge.reason ? ` — ${bridge.reason}` : ""}`,
      `Routers: capacity=${bridge.routers?.capacity?.ok ? "ready" : `unavailable${bridge.routers?.capacity?.reason ? ` — ${bridge.routers.capacity.reason}` : ""}`}; freerouting=${bridge.routers?.freerouting?.ok ? "ready" : `unavailable${bridge.routers?.freerouting?.reason ? ` — ${bridge.routers.freerouting.reason}` : ""}`}`,
      `Desktop UI automation: ${app.running ? "available" : `unavailable${app.reason ? ` — ${app.reason}` : ""}`}`,
      `Project files: ${Object.entries(files).map(([name, path]) => `${name}=${path}${present[name] ? "" : " (missing)"}`).join(", ")}`,
      "Available interfaces: MCP, bundled kicad-cli, desktop UI automation, and direct project files.",
      "Fabdesk UI directories: renders/, reports/, exports/.",
      "State visibility: MCP operations may address live KiCad state; CLI and file operations address persisted state.",
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
    "Return errors and warnings from reports/build.json.",
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
    "Autoroute the canonical board on the design server (capacity: built-in JS router; freerouting: internal builds only). Streams progress frames, persists them under .fabdesk/runs/<runId>/frames.jsonl, applies tracks as one undo entry, saves, and returns open connections and track/via counts. onlyConnections limits the run to named nets.",
  inputSchema: RouteRunArgs,
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: (args, ctx) =>
    runRoute(
      {
        timeoutMs: args.timeoutMs,
        ...(args.router ? { router: args.router } : {}),
        ...(args.onlyConnections ? { onlyConnections: args.onlyConnections } : {}),
        ...(args.targets ? { targets: args.targets } : {}),
        ...(args.rules ? { rules: args.rules } : {}),
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
    "Run KiCad design rule check on board.kicad_pcb. Writes reports/drc.json and returns revision-bound violations with rules, severities, coordinates, layers, nets, object IDs, and matched board geometry.",
  inputSchema: {
    severity: z
      .enum(["all", "error"])
      .default("all")
      .describe("Report all severities or errors only"),
    schematicParity: z
      .boolean()
      .default(true)
      .describe("Include PCB↔schematic parity checks"),
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
    if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found", "precondition");
    const beforeRevision = await pcbFileRevision(board);
    ctx.progress(0.4, "running DRC");
    const outFile = p(project, PROJECT_FILES.reports, "drc.json");
    const report = await ctx.services.kicad.runDrc(cli, {
      board,
      outFile,
      severity,
      schematicParity,
      signal: ctx.signal,
    });
    const geometry = await queryDrcGeometry(ctx, project.dir);
    const afterRevision = await pcbFileRevision(board);
    if (beforeRevision.sha256 !== afterRevision.sha256) {
      await unlink(outFile).catch(() => {});
      throw new ToolError("board.kicad_pcb changed while DRC was running", "precondition");
    }
    const enriched = enrichDrcReport(report, geometry);
    const checkedReport: DrcReport & { pcbRevision: typeof afterRevision } = {
      ...enriched,
      schematicParityChecked: schematicParity,
      pcbRevision: afterRevision,
    };
    await writeJson(outFile, checkedReport);
    ctx.progress(1, "done");
    const c = enriched.counts;
    const lines = [`DRC: ${c.errors} errors, ${c.warnings} warnings, ${c.unconnected} unconnected`];
    const show = (label: string, items: unknown[]) => {
      if (!items.length) return;
      lines.push(`${label} (${items.length}${items.length > limit ? `, showing ${limit}` : ""}):`);
      for (const v of items.slice(0, limit)) lines.push(`- ${describeViolation(v)}`);
    };
    show("Violations", enriched.violations);
    show("Unconnected", enriched.unconnected);
    show("Schematic parity", enriched.schematicParity);
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
        violations: byRule(enriched.violations),
        unconnected: byRule(enriched.unconnected),
        schematicParity: byRule(enriched.schematicParity),
      },
      pcbRevision: afterRevision,
      violations: enriched.violations.slice(0, limit),
      unconnected: enriched.unconnected.slice(0, limit),
      schematicParity: enriched.schematicParity.slice(0, limit),
      truncated:
        enriched.violations.length > limit ||
        enriched.unconnected.length > limit ||
        enriched.schematicParity.length > limit,
    };
    if (json.truncated) lines.push(`Full report with every violation: ${outFile}`);
    return {
      text: lines.join("\n"),
      json: { ...json, schematicParityChecked: schematicParity },
      isError: c.errors > 0 || c.unconnected > 0,
    };
  },
});

type PcbFileRevision = { sha256: string; bytes: number };
type DrcGeometry = { objectType: DesignSelect; [key: string]: unknown };

async function pcbFileRevision(path: string): Promise<PcbFileRevision> {
  const data = await readFile(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

const DRC_GEOMETRY_SELECTS: DesignSelect[] = [
  "pads",
  "tracks",
  "vias",
  "zones",
  "keepouts",
  "board_geometry",
  "texts",
];

async function queryDrcGeometry(ctx: Parameters<typeof requireKicad>[0], projectDir: string): Promise<DrcGeometry[]> {
  const groups = await Promise.all(
    DRC_GEOMETRY_SELECTS.map(async (objectType) =>
      (await ctx.services.design.query(projectDir, objectType)).map((row) => ({ objectType, ...row })),
    ),
  );
  return groups.flat();
}

function normalizedId(value: unknown): string {
  return String(value ?? "").replace(/[{}]/g, "").toLowerCase();
}

function geometryCoordinates(row: DesignRow): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const [x, y] = value.split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: x!, y: y! });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const x = Number((value as Record<string, unknown>)["x"]);
    const y = Number((value as Record<string, unknown>)["y"]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  };
  const x = Number(row["x"]);
  const y = Number(row["y"]);
  if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  for (const key of ["position", "start", "mid", "end"]) add(row[key]);
  if (Array.isArray(row["points"])) for (const point of row["points"]) add(point);
  return points;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function enrichDrcReport(report: DrcReport, geometry: DrcGeometry[]): DrcReport {
  const byId = new Map<string, DrcGeometry[]>();
  for (const row of geometry) {
    const id = normalizedId(row["id"]);
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  const enrich = (violation: DrcViolation): DrcViolation => {
    const objectIds = uniqueBy(
      [...violation.objectIds, ...violation.items.flatMap((item) => (item.uuid ? [item.uuid] : []))],
      normalizedId,
    );
    const affectedGeometry = uniqueBy(
      objectIds.flatMap((id) => byId.get(normalizedId(id)) ?? []),
      (row) => `${row.objectType}:${normalizedId(row["id"])}`,
    );
    const coordinates = uniqueBy(
      [...violation.coordinates, ...affectedGeometry.flatMap(geometryCoordinates)],
      (point) => `${point.x},${point.y}`,
    );
    const layers = uniqueBy(
      [
        ...violation.layers,
        ...affectedGeometry.flatMap((row) => [row["layer"], ...(Array.isArray(row["layers"]) ? row["layers"] : [])]),
      ].filter((layer): layer is string | number => typeof layer === "string" || typeof layer === "number"),
      String,
    );
    const nets = uniqueBy(
      [...violation.nets, ...affectedGeometry.map((row) => row["net"])].filter(
        (net): net is string => typeof net === "string" && net.length > 0,
      ),
      String,
    );
    return { ...violation, coordinates, layers, nets, objectIds, affectedGeometry };
  };
  return {
    ...report,
    violations: report.violations.map(enrich),
    unconnected: report.unconnected.map(enrich),
    schematicParity: report.schematicParity.map(enrich),
  };
}

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
      throw new ToolError("board.kicad_pcb not found", "precondition");
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

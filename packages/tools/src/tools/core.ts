import {
  compareTaskCheckpoint,
  compactTaskComparison,
  taskCheckpointText,
} from "../task-checkpoints";
/** Core toolset: always loaded. */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, mkdtemp, rm } from "node:fs/promises";
import { z } from "zod/v4";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSEMBLY_MANIFEST_PATH, type ProjectBoardSources, type FpPcbBoardSpec, type NetlistFile } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, jailPath, mtimeMs, readJsonOrNull, writeJson } from "../fs";
import {
  ToolError,
  ToolsetIdOrAlias,
  TOOLSET_ALIASES,
  defineTool,
  TOOLSETS,
  type ProjectHandle,
} from "../registry";
import type { BuildResult, DesignRow, DesignSelect, DrcReport, DrcViolation } from "../services";
import { VIAGRID_9055, viagrid9055BoardSpec } from "../templates/viagrid-9055";
import {
  fileUrl,
  inspectSavedHierarchy,
  loadNetlist,
  ok,
  p,
  requireKicad,
  table,
  writeReport,
} from "./common";
import { formatLastRelease, readProjectStatusEvidence } from "./project-status-evidence";
import { ROUTE_RUN_DEFAULT_WAIT_MS, ROUTE_RUN_MAX_WAIT_MS, runRoute, RouteRunArgs } from "./route";
import { inspectProjectBoardSources } from "../assembly";
import { compilerSourceHelp, formatCompilerSourceHelp } from "./compiler-source-guide";

export const load_toolset = defineTool({
  name: "load_toolset",
  toolset: "core",
  scope: "global",
  title: "Load a toolset",
  description:
    "Enable an additional group of fabdesk tools for this session. Available toolsets are project (files, board settings, off-board parts library), circuit, route, kicad, verify, render, export, sim, app, shopping (fabplane.com shopping list and team inventory), and cad (the mechanical model in FreeCAD). Core tools are always available.",
  inputSchema: {
    toolset: ToolsetIdOrAlias.describe(
      `Toolset to enable. Aliases ${Object.entries(TOOLSET_ALIASES)
        .map(([alias, id]) => `${alias}=${id}`)
        .join(", ")} are accepted; the result reports the canonical id.`,
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
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
  title: "Inspect the PCB workbench and script interface",
  description:
    "Return current project paths, kicad-cli identity, FabPCB bridge status, desktop-UI availability, and available interfaces.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const [cli, bridge, app] = await Promise.all([
      ctx.services.kicad.resolveCli().catch(() => null),
      ctx.services.design.status(),
      ctx.services.appBridge?.status().catch((error) => ({
        running: false,
        reason: error instanceof Error ? error.message : String(error),
      })) ?? Promise.resolve({ running: false, reason: "desktop automation is not enabled" }),
    ]);
    const files = {
      project: p(project, PROJECT_FILES.boardPro),
      schematic: p(project, PROJECT_FILES.boardSch),
      board: p(project, PROJECT_FILES.boardPcb),
    };
    const present: Record<string, boolean> = Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([name, path]) => [name, await exists(path)]),
      ),
    );
    const interfaces = {
      mcp: "Structured KiCad, FabPCB, project, render, verification, and export operations.",
      cli: "Bundled kicad-cli path and version.",
      script:
        "fabpcb tool exposes the same registry as JSON/JSONL for programmable calls and batches.",
      ui: "Desktop application automation status.",
      files: "Project-local files are directly accessible.",
    };
    const json = {
      project: { id: project.id, name: project.name, dir: project.dir, files, present },
      kicadCli: cli ? { path: cli.path, version: cli.version } : null,
      bridge,
      desktopUi: app,
      interfaces,
      scriptCli: {
        search: 'fabpcb tool search "inspect board region"',
        describe: "fabpcb tool describe pcb_inspect",
        call: "fabpcb tool call pcb_inspect --request @request.json",
        batch: "fabpcb tool batch --input @calls.jsonl",
      },
      uiConventions: {
        canonicalFiles: files,
        renders: p(project, PROJECT_FILES.renders),
        reports: p(project, PROJECT_FILES.reports),
        exports: p(project, PROJECT_FILES.exports),
      },
      stateVisibility:
        "MCP operations may address live KiCad state; CLI and direct-file operations address persisted files.",
    };
    return ok(
      [
        `PCB workbench for ${project.name} at ${project.dir}`,
        `KiCad CLI: ${cli ? `${cli.path} (${cli.version})` : "not found"}`,
        `FabPCB bridge: ${bridge.ok ? "ready" : "unavailable"} at ${bridge.url}${bridge.reason ? ` — ${bridge.reason}` : ""}`,
        "Scriptable registry: fabpcb tool search <words>; describe <name>; call <name> --request <json|@file>; batch --input @calls.jsonl.",
        `Routers (default freerouting → fab_router fallback): fab_router=${bridge.routers?.fab_router?.ok ? "ready" : `unavailable${bridge.routers?.fab_router?.reason ? ` — ${bridge.routers.fab_router.reason}` : ""}`}; freerouting=${bridge.routers?.freerouting?.ok ? "ready" : `unavailable${bridge.routers?.freerouting?.reason ? ` — ${bridge.routers.freerouting.reason}` : ""}`}; tracemaker=${ctx.services.routers?.get("tracemaker").ready ? "ready" : "not installed — Settings → Routers or TRACEMAKER_BIN"}`,
        `Desktop UI automation: ${app.running ? "available" : `unavailable${app.reason ? ` — ${app.reason}` : ""}`}`,
        `Project files: ${Object.entries(files)
          .map(([name, path]) => `${name}=${path}${present[name] ? "" : " (missing)"}`)
          .join(", ")}`,
        "Available interfaces: MCP, bundled kicad-cli, desktop UI automation, and direct project files.",
        "Fabdesk UI directories: renders/, reports/, exports/.",
        "State visibility: MCP operations may address live KiCad state; CLI and file operations address persisted state.",
      ].join("\n"),
      json,
    );
  },
});

export const project_status = defineTool({
  name: "project_status",
  toolset: "core",
  title: "Project status",
  description:
    "Summarise the selected project: directory, board settings, native KiCad files, latest source/compiler build, persisted release evidence and staleness, route and verification state, sketches, reports, and explicitly declared assembly board sources/instances/connections. Assembly source availability is not compatibility evidence. Does not run ERC, DRC, or release.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const manifest = project.manifest();
    let assembly: { status: "inspected"; membership: ProjectBoardSources; editing: "explicit-source-tools" } | { status: "unavailable"; reason: string; editing: "unavailable" } | null = null;
    let declaredAssembly = false;
    try {
      // lstat sees dangling declarations too; an unsafe manifest cannot silently become a root board.
      await lstat(p(project, ASSEMBLY_MANIFEST_PATH));
      declaredAssembly = true;
      const membership = await inspectProjectBoardSources(project);
      if (membership.mode !== "assembly") throw new Error("Assembly declaration changed during inspection");
      assembly = { status: "inspected", membership, editing: "explicit-source-tools" };
    } catch (error) {
      if (declaredAssembly || (error as NodeJS.ErrnoException)?.code !== "ENOENT") assembly = { status: "unavailable", reason: "Assembly membership could not be verified. Inspect fabplane.assembly.json; project-root status does not describe its member boards.", editing: "unavailable" };
    }
    const files: Record<string, { exists: boolean; mtime?: string }> = {};
    for (const rel of [PROJECT_FILES.boardPro, PROJECT_FILES.boardSch, PROJECT_FILES.boardPcb, PROJECT_FILES.projectParts]) {
      const m = await mtimeMs(p(project, rel));
      files[rel] =
        m === null ? { exists: false } : { exists: true, mtime: new Date(m).toISOString() };
    }
    const { lastSourceBuild, lastRelease } = await readProjectStatusEvidence(project);
    // A read-only status must not fail because KiCad saved mid-comparison or a manifest is bad.
    let taskComparison: Awaited<ReturnType<typeof compareTaskCheckpoint>> = null;
    let taskComparisonError: string | null = null;
    try {
      taskComparison = await compareTaskCheckpoint(project);
    } catch (error) {
      taskComparisonError = error instanceof Error ? error.message : String(error);
    }
    const reports = (await readdir(p(project, PROJECT_FILES.reports)).catch(() => [])).filter((f) =>
      f.endsWith(".json"),
    );
    const sketches = (await readdir(p(project, PROJECT_FILES.sketches)).catch(() => [])).filter(
      (f) => /\.(png|jpe?g|svg)$/i.test(f),
    );
    const route = ctx.services.routeRuns.latest(project.id);
    const drc = await readJsonOrNull<DrcReport>(p(project, PROJECT_FILES.reports, "drc.json"));
    const json = {
      contract: { name: "fabdesk.project-status", version: "2.0.0" },
      id: project.id,
      name: project.name,
      dir: project.dir,
      ...(assembly ? { assembly, nativeStatusScope: "project-root" } : {}),
      board: manifest.board,
      router: manifest.router === "capacity" ? "fab_router" : (manifest.router ?? "auto"),
      files,
      sketches: sketches.map((s) => `${PROJECT_FILES.sketches}/${s}`),
      lastSourceBuild,
      lastRelease,
      lastRoute: route
        ? { runId: route.id, status: route.status, open: route.result?.open.length ?? null }
        : null,
      lastDrc: drc ? drc.counts : null,
      taskComparison: taskComparisonError
        ? { error: taskComparisonError }
        : compactTaskComparison(taskComparison),
      reports: reports.map((r) => `${PROJECT_FILES.reports}/${r}`),
      enabledToolsets: ctx.session?.enabledToolsets() ?? [...TOOLSETS],
    };
    const lines = [
      `Project "${project.name}" (${project.id}) at ${project.dir}`,
      ...(assembly ? [assembly.status === "inspected"
        ? `Assembly instances: ${assembly.membership.assembly!.instances.length}; source boards: ${assembly.membership.sources.length}; declared connections: ${assembly.membership.assembly!.connections.length}. Source files available: ${assembly.membership.sources.filter(source => source.status === "available").length}/${assembly.membership.sources.length}. Geometry, schematic parity and connection compatibility are unverified. Explicit source tools pcb_inspect, render_pcb_svg, pcb_place and pcb_resize_outline accept board {sourceId, manifestSha256}. Placement and resize require the selected source's inspected expectedSourceSha256; shared physical instances use the same edited source. Other member workflows remain unavailable. Canvas placement and rectangular resizing require verified preview coordinates and captured source ownership. Remaining native status below describes only the project root.`
        : assembly.reason] : []),
      `${assembly ? "Root project defaults" : "Board"}: ${manifest.board.layers} layers${manifest.board.widthMm ? `, ${manifest.board.widthMm}×${manifest.board.heightMm ?? "?"} mm` : ""}; router: ${manifest.router === "capacity" ? "fab_router" : (manifest.router ?? "freerouting (default; fab_router fallback)")}`,
      `${assembly ? "Root files" : "Files"}: ${Object.entries(files)
        .map(([k, v]) => `${k}=${v.exists ? "yes" : "no"}`)
        .join(", ")}`,
      `Sketches: ${sketches.length ? sketches.join(", ") : "none"}`,
      `Last source/compiler build: ${lastSourceBuild ? `${lastSourceBuild.ok ? "ok" : "FAILED"} (${lastSourceBuild.errors} errors, ${lastSourceBuild.warnings} warnings, captured ${lastSourceBuild.at})` : "never"}`,
      `${assembly ? "Root last release" : "Last release"}: ${formatLastRelease(lastRelease)}`,
      taskComparisonError
        ? `Task baseline comparison unavailable: ${taskComparisonError}`
        : taskCheckpointText(taskComparison),
      `Last route: ${route ? `${route.status} (${route.result ? `${route.result.open.length} open` : "no result"})` : "never"}`,
      `${assembly ? "Root last DRC" : "Last DRC"}: ${drc ? `${drc.counts.errors} errors, ${drc.counts.warnings} warnings, ${drc.counts.unconnected} unconnected` : "never"}`,
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
  /**
   * Declared (fabdesk.json board.layers) and built copper layer counts, when the build could read
   * the built board's. `match` false means the two disagree and a `layer_mismatch` warning was added.
   */
  copperLayers?: { declared: number; built: number; match: boolean };
};

/**
 * Compare fabdesk.json's declared stackup with the board a successful build produced. The manifest
 * is never rewritten here: board.layers always has a value (schema default 2) and may be an
 * explicit `project_set_board` choice that the compile did not apply. A disagreement becomes a
 * build warning so it is visible instead of silent (issue #92).
 */
export function checkBoardLayers(
  declared: number,
  built: number | undefined,
): {
  layers?: NonNullable<BuildSummary["copperLayers"]>;
  warning?: BuildResult["warnings"][number];
} {
  if (built === undefined || !Number.isInteger(built)) return {};
  const layers = { declared, built, match: declared === built };
  if (layers.match) return { layers };
  return {
    layers,
    warning: {
      type: "layer_mismatch",
      file: PROJECT_FILES.manifest,
      message: `fabdesk.json board.layers is ${declared} but the built board has ${built} copper layers. fabdesk.json was not changed. Make the netlist's board.copperLayers and project_set_board layers agree, then rebuild.`,
    },
  };
}

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

/**
 * Net names the KiCad fork cannot save once net-class rules are set. KiCad's own netlist export
 * writes a label's `/` as `{slash}` (and other characters as `{colon}`, `{space}`, …); with a rules
 * write (`SetNetClasses`) the fork's project save then fails with `basic_string` (fab_pcb G30), and
 * the build reports only that. Without rules the same board saves.
 */
export function escapedNetNames(file: NetlistFile): string[] {
  return file.netlist.nets.map((n) => n.name).filter((name) => /[{}]/.test(name));
}

export const circuit_build = defineTool({
  name: "circuit_build",
  toolset: "core",
  title: "Build the board",
  description:
    "Compile circuit.netlist.json into board.kicad_pcb and a generated board.kicad_sch. Footprints are pulled from KiCad libraries, explicitly placed when board.placements names them, and connected into the ratsnest; libSource draws all library units, including power units, with labelled wire stubs. For a rejected build, fix the source and call circuit_build again, or use schematic_edit to create native units (same reference, distinct unit numbers); schematic_inspect returns IDs for editing or replacement. Returns actionable errors/warnings, with source-format guidance and an example when the entrypoint is missing or malformed. Rebuilds replace only generated schematic items, preserve manual schematic work and unlisted manual footprint placement, keep tracks whose nets still exist, and remove footprints the netlist no longer names.",
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
    fresh: z
      .boolean()
      .optional()
      .describe(
        "Discard the existing board first (outline, placement, tracks) and build from the netlist alone. Needed after changing the board size: a build never redraws an outline that exists.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  longRunning: true,
  handler: async ({ entrypoint, rebuild, fresh }, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.05, "building");
    const file = entrypoint ? null : await loadNetlist(project).catch(() => null);
    const escaped = file ? escapedNetNames(file) : [];
    const board = await buildBoardSpec(project);
    const rules = board?.rules ?? file?.board?.rules;
    const writesRules = Boolean(rules && Object.values(rules).some((v) => v !== undefined));
    // Braces only break the save when the build writes net-class rules; otherwise say so and go on.
    const escapeWarnings: BuildResult["warnings"] =
      escaped.length && !writesRules
        ? [
            {
              type: "net_name_escape",
              file: PROJECT_FILES.netlistJson,
              message: `net names contain "{" or "}": ${escaped.join(", ")}. The build goes ahead because this board sets no rules, but adding board.rules later will make the KiCad fork fail to save; KiCad writes a label's "/" as {slash}, so use "_" instead.`,
            },
          ]
        : [];
    if (escaped.length && writesRules) {
      const summary: BuildSummary = {
        ok: false,
        at: new Date().toISOString(),
        rebuild,
        durationMs: 0,
        errors: [
          {
            type: "net_name_escape",
            file: PROJECT_FILES.netlistJson,
            message: `net names may not contain "{" or "}" when the board sets rules (the KiCad fork cannot save such a board): ${escaped.join(", ")}. KiCad writes a label's "/" as {slash}; use "_" instead.`,
          },
        ],
        warnings: [],
        counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
      };
      await writeReport(project, "build", summary);
      return {
        text: `Build FAILED (1 errors):\n${formatErrors(summary.errors)}`,
        json: summary,
        isError: true,
      };
    }
    const result = await ctx.services.design.build({
      projectDir: project.dir,
      ...(entrypoint ? { entrypoint } : {}),
      ...(board ? { board } : {}),
      rebuild,
      ...(fresh ? { fresh } : {}),
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(0.05 + fraction * 0.9, note),
    });
    const layerCheck = result.ok
      ? checkBoardLayers(project.manifest().board.layers, result.copperLayers)
      : {};
    const warnings = [
      ...escapeWarnings,
      ...result.warnings,
      ...(layerCheck.warning ? [layerCheck.warning] : []),
    ];
    const summary: BuildSummary = {
      ok: result.ok,
      at: new Date().toISOString(),
      rebuild,
      durationMs: result.durationMs,
      errors: result.errors,
      warnings,
      counts: result.counts,
      ...(result.revision !== undefined ? { revision: result.revision } : {}),
      ...(result.removedCopper ? { removedCopper: result.removedCopper } : {}),
      ...(result.rejectedSchematicPath
        ? { rejectedSchematicPath: result.rejectedSchematicPath }
        : {}),
      ...(layerCheck.layers ? { copperLayers: layerCheck.layers } : {}),
    };
    await writeReport(project, "build", summary);
    ctx.progress(1, "done");
    const c = result.counts;
    const text = result.ok
      ? `Build OK (${rebuild} rebuild) in ${Math.round(result.durationMs)} ms: ${c.components} components, ${c.nets} nets, ${c.footprintsAdded} footprints added, ${c.footprintsPlaced} placed${result.removedCopper ? `, ${result.removedCopper.tracks} old tracks/arcs and ${result.removedCopper.vias} routed vias removed` : ""}${c.viasAdded ? `, blank drawn (${c.viasAdded} free vias, ${c.holesAdded ?? 0} holes)` : ""}.${project.manifest().board.template ? ` Template ${project.manifest().board.template}: the netlist's own board spec was replaced by the blank.` : ""}${warnings.length ? `\nWarnings:\n${formatErrors(warnings)}` : ""}`
      : `Build FAILED (${result.errors.length} errors):\n${formatErrors(result.errors)}${result.rejectedSchematicPath ? `\nRejected schematic preserved at ${result.rejectedSchematicPath}; the canonical schematic was restored.` : ""}`;
    const sourceGuide = result.ok ? undefined : compilerSourceHelp(result.errors);
    return {
      text: sourceGuide ? text + "\n\n" + formatCompilerSourceHelp(sourceGuide) : text,
      json: { ...summary, ...(sourceGuide ? { sourceGuide } : {}) },
      isError: !result.ok,
    };
  },
});

export const circuit_place = defineTool({
  name: "circuit_place",
  toolset: "core",
  title: "Place footprints",
  description:
    "Move built-board footprints to explicit KiCad board coordinates in millimetres, with optional rotation. Tracks are not moved. Returns moved and missing references.",
  inputSchema: {
    placements: z
      .array(
        z.object({
          ref: z.string().min(1).describe("Reference designator, e.g. J2"),
          x: z.number().describe("Footprint origin X in mm"),
          y: z.number().describe("Footprint origin Y in mm"),
          rotation: z.number().optional().describe("Degrees; omit to keep"),
        }),
      )
      .min(1)
      .max(1000),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ placements }, ctx) => {
    const project = ctx.requireProject();
    const result = await ctx.services.design.place(
      project.dir,
      placements.map((p) => ({
        ref: p.ref,
        x: p.x,
        y: p.y,
        ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
      })),
    );
    const lines = result.moved.map((m) => `- ${m.ref} → (${m.x}, ${m.y}) mm, ${m.rotation}°`);
    if (result.missing.length)
      lines.push(
        `Not on the board: ${result.missing.join(", ")} (build first, or check the reference).`,
      );
    const text = result.moved.length
      ? `Placed ${result.moved.length} footprint${result.moved.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nRun verify_drc to check, and route_run (after route_unroute for nets that moved) to re-route.`
      : `Nothing moved.\n${lines.join("\n")}`;
    return { text, json: result, isError: result.moved.length === 0 };
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
  description: "Return errors and warnings from reports/build.json.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const build = await readJsonOrNull<BuildSummary>(
      p(project, PROJECT_FILES.reports, "build.json"),
    );
    if (!build) return ok("No build yet. Run circuit_build.", { build: null });
    const parts = [
      `Last source/compiler build (${build.at}): ${build.ok ? "ok" : "failed"}, ${build.errors.length} errors, ${build.warnings.length} warnings`,
    ];
    if (build.errors.length) parts.push(`Errors:\n${formatErrors(build.errors)}`);
    if (build.warnings.length) parts.push(`Warnings:\n${formatErrors(build.warnings)}`);
    return ok(parts.join("\n\n"), { build });
  },
});

function routeRunTool(inputSchema: typeof RouteRunArgs) {
  return defineTool({
    name: "route_run",
    toolset: "core",
    title: "Autoroute the board",
    description: `Start a durable autoroute against a revision-bound board snapshot. Waits up to waitMs (default ${ROUTE_RUN_DEFAULT_WAIT_MS / 1000} s, max ${ROUTE_RUN_MAX_WAIT_MS / 1000} s); returns the final result when the run finishes within that time, otherwise its run ID and running state. The run continues after the request returns, and its progress, diagnostics and artifacts remain available through route_status. applyPolicy=auto (default) atomically applies only while the starting PCB revision is current; manual preserves a validated native candidate for route_apply. onlyConnections limits the run to named nets.`,
    inputSchema: inputSchema as typeof RouteRunArgs,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
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
          ...(args.rerouteMode ? { rerouteMode: args.rerouteMode } : {}),
          ...(args.freeroutingPasses !== undefined
            ? { freeroutingPasses: args.freeroutingPasses }
            : {}),
          ...(args.allowQualityRegression
            ? { allowQualityRegression: args.allowQualityRegression }
            : {}),
          applyPolicy: args.applyPolicy,
          waitMs: args.waitMs,
        },
        ctx,
      ),
  });
}

export const route_run = routeRunTool(RouteRunArgs);

/**
 * Byte budget for each inline violation category. The complete report is always on disk, so the
 * response carries only as much of each list as stays cheap to keep in a transcript.
 */
const DRC_SAMPLE_BUDGET_BYTES = 8192;

export const verify_drc = defineTool({
  name: "verify_drc",
  toolset: "core",
  title: "Run KiCad DRC",
  description:
    "Run KiCad design rule check on board.kicad_pcb. When parity is enabled, require a complete saved schematic hierarchy and bind parity evidence to its aggregate revision. Returns violation descriptions, rule types and native item IDs with actionable geometry; responseMode=full returns all rows. Writes reports/drc.json.",
  inputSchema: {
    severity: z
      .enum(["all", "error"])
      .default("all")
      .describe("Report all severities or errors only"),
    schematicParity: z.boolean().default(true).describe("Include PCB↔schematic parity checks"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(30)
      .describe(
        "Max violations per category in the response (maximum 200). Every violation is in reports/drc.json regardless; this only bounds the inline sample.",
      ),
    responseMode: z
      .enum(["summary", "full"])
      .default("summary")
      .describe(
        "summary: counts, per-rule totals and a byte-bounded sample without per-violation geometry rows. full: the complete enriched violations inline, which costs roughly 1 KiB per violation.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ severity, schematicParity, limit, responseMode }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found", "precondition");
    const beforeRevision = await pcbFileRevision(board);
    const beforeHierarchy = schematicParity ? await inspectSavedHierarchy(ctx, project, cli) : null;
    if (beforeHierarchy && !beforeHierarchy.complete)
      throw new ToolError(
        `schematic parity requires a complete saved hierarchy: ${beforeHierarchy.issues.map((issue) => `${issue.kind}: ${issue.path}`).join(", ")}`,
        "precondition",
      );
    ctx.progress(0.4, "running DRC");
    const reportPath = `${PROJECT_FILES.reports}/drc.json`;
    const outFile = await jailPath(project.dir, reportPath);
    const scratch = await mkdtemp(join(tmpdir(), "fabplane-drc-"));
    let report: DrcReport;
    try {
      // The CLI may write a partial report before failing. Never expose it over a previous measurement.
      report = await ctx.services.kicad.runDrc(cli, {
        board,
        outFile: join(scratch, "drc.json"),
        severity,
        schematicParity,
        signal: ctx.signal,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const geometry = await queryDrcGeometry(ctx, project.dir);
    const afterRevision = await pcbFileRevision(board);
    const afterHierarchy = schematicParity ? await inspectSavedHierarchy(ctx, project, cli) : null;
    if (beforeRevision.sha256 !== afterRevision.sha256) {
      throw new ToolError("board.kicad_pcb changed while DRC was running", "precondition");
    }
    if (
      beforeHierarchy &&
      afterHierarchy &&
      beforeHierarchy.aggregateRevision !== afterHierarchy.aggregateRevision
    ) {
      throw new ToolError(
        "a referenced schematic changed while parity DRC was running",
        "precondition",
      );
    }
    const enriched = enrichDrcReport(report, geometry);
    const checkedReport = {
      ...enriched,
      schematicParityChecked: schematicParity,
      pcbRevision: afterRevision,
      ...(beforeHierarchy
        ? {
            schematicHierarchy: {
              scope: "complete saved hierarchy" as const,
              aggregateRevision: beforeHierarchy.aggregateRevision,
              referencedSheetCount: beforeHierarchy.sheets.length,
              complete: beforeHierarchy.complete,
              source: beforeHierarchy.source,
            },
          }
        : {}),
    };
    // Revalidate the output jail and captured native ownership immediately before publication.
    await jailPath(project.dir, reportPath);
    await ctx.runInScope?.(async () => {});
    ctx.signal.throwIfAborted();
    await writeJson(outFile, checkedReport);
    ctx.progress(1, "done");
    const c = enriched.counts;
    const savedReport = await readFile(outFile);
    const outcome = c.errors > 0 || c.unconnected > 0 ? "violations" : "clean";
    const lines = [`DRC: ${c.errors} errors, ${c.warnings} warnings, ${c.unconnected} unconnected`];
    lines.push(
      `Check completed on PCB ${afterRevision.sha256.slice(0, 12)}; outcome: ${outcome}. This result is a measurement, not a tool failure.`,
    );
    // A completed check is reported as a successful result whatever it found: the model must be able
    // to ask "how many opens?" without a failed tool call. Enforcement lives in verify_gate and
    // release_build, which read reports/drc.json independently.
    const byRule = (items: unknown[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const v of items as Array<Record<string, unknown>>) {
        const key = String(v["rule"] ?? v["type"] ?? "unknown");
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    // The enriched violations cost roughly 1 KiB each, dominated by the raw `items` and the matched
    // `affectedGeometry` rows. At the former default this made one DRC call a ~450 KiB tool result that
    // stays in the transcript, so the model bought affordable checks by dropping `limit` to 1. Summary
    // mode keeps the facts that identify and locate a violation, drops the bulk to reports/drc.json, and
    // bounds the sample by bytes as well as by count.
    const sample = (items: DrcViolation[]) => {
      const rows: unknown[] = [];
      // The readable line keeps the full violation, including the item descriptions and position
      // that name the offending objects; only the structured row is slimmed.
      const described: DrcViolation[] = [];
      let bytes = 0;
      let stop: "complete" | "limit" | "bytes" = "complete";
      for (const violation of items) {
        if (rows.length >= limit) {
          stop = "limit";
          break;
        }
        const row =
          responseMode === "full"
            ? violation
            : {
                rule: violation.rule,
                severity: violation.severity,
                description: violation.description,
                coordinates: violation.coordinates,
                layers: violation.layers,
                nets: violation.nets,
                objectIds: violation.objectIds,
                signature: violation.signature,
                itemCount: violation.items.length,
                affectedGeometryCount: violation.affectedGeometry.length,
              };
        const size = JSON.stringify(row).length;
        // `full` is the explicit opt-in to the complete enriched list and keeps the pre-existing
        // behaviour, bounded only by `limit`; only the default sample is byte-bounded.
        if (responseMode !== "full" && rows.length && bytes + size > DRC_SAMPLE_BUDGET_BYTES) {
          stop = "bytes";
          break;
        }
        rows.push(row);
        described.push(violation);
        bytes += size;
      }
      return { rows, described, total: items.length, stop };
    };
    const sampled = {
      violations: sample(enriched.violations),
      unconnected: sample(enriched.unconnected),
      schematicParity: sample(enriched.schematicParity),
    };
    const show = (label: string, part: ReturnType<typeof sample>) => {
      if (!part.total) return;
      lines.push(
        `${label} (${part.total}${part.rows.length < part.total ? `, showing ${part.rows.length}` : ""}):`,
      );
      for (const v of part.described) lines.push(`- ${describeViolation(v)}`);
    };
    show("Violations", sampled.violations);
    show("Unconnected", sampled.unconnected);
    show("Schematic parity", sampled.schematicParity);
    const json = {
      counts: c,
      reportPath: outFile,
      byRule: {
        violations: byRule(enriched.violations),
        unconnected: byRule(enriched.unconnected),
        schematicParity: byRule(enriched.schematicParity),
      },
      pcbRevision: afterRevision,
      ...(beforeHierarchy
        ? {
            schematicHierarchy: {
              scope: "complete saved hierarchy" as const,
              aggregateRevision: beforeHierarchy.aggregateRevision,
              referencedSheetCount: beforeHierarchy.sheets.length,
              complete: beforeHierarchy.complete,
              source: beforeHierarchy.source,
            },
          }
        : {}),
      violations: sampled.violations.rows,
      unconnected: sampled.unconnected.rows,
      schematicParity: sampled.schematicParity.rows,
      truncated:
        sampled.violations.rows.length < sampled.violations.total ||
        sampled.unconnected.rows.length < sampled.unconnected.total ||
        sampled.schematicParity.rows.length < sampled.schematicParity.total,
      sampling: {
        responseMode,
        limit,
        ...(responseMode === "summary" ? { budgetBytes: DRC_SAMPLE_BUDGET_BYTES } : {}),
        ...(responseMode === "summary"
          ? { omittedPerViolation: ["items", "affectedGeometry"] as const }
          : {}),
        violations: {
          included: sampled.violations.rows.length,
          total: sampled.violations.total,
          stoppedBy: sampled.violations.stop,
        },
        unconnected: {
          included: sampled.unconnected.rows.length,
          total: sampled.unconnected.total,
          stoppedBy: sampled.unconnected.stop,
        },
        schematicParity: {
          included: sampled.schematicParity.rows.length,
          total: sampled.schematicParity.total,
          stoppedBy: sampled.schematicParity.stop,
        },
      },
      report: {
        path: outFile,
        bytes: savedReport.byteLength,
        sha256: createHash("sha256").update(savedReport).digest("hex"),
      },
    };
    lines.push(
      `Complete report, every violation with its matched geometry: ${outFile} (${savedReport.byteLength} bytes).`,
    );
    return {
      text: lines.join("\n"),
      json: {
        ...json,
        status: "measured" as const,
        outcome,
        schematicParityChecked: schematicParity,
      },
    };
  },
});

type PcbFileRevision = { sha256: string; bytes: number };
type DrcGeometry = { objectType: DesignSelect; [key: string]: unknown };

async function pcbFileRevision(path: string): Promise<PcbFileRevision> {
  const data = await readFile(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

const DRC_GEOMETRY_SOURCES: Array<{ select: DesignSelect; objectType: DesignSelect }> = [
  { select: "pads", objectType: "pads" },
  { select: "tracks", objectType: "tracks" },
  { select: "vias", objectType: "vias" },
  { select: "zones", objectType: "zones" },
  { select: "keepouts", objectType: "keepouts" },
  { select: "board_geometry", objectType: "board_geometry" },
  // Preserve the pre-H4 combined geometry ordering and objectType in DRC enrichment while querying
  // the newly explicit source so footprint-owned violations retain their matching coordinates.
  { select: "footprint_geometry", objectType: "board_geometry" },
  { select: "texts", objectType: "texts" },
];

async function queryDrcGeometry(
  ctx: Parameters<typeof requireKicad>[0],
  projectDir: string,
): Promise<DrcGeometry[]> {
  const groups = await Promise.all(
    DRC_GEOMETRY_SOURCES.map(async ({ select, objectType }) =>
      (await ctx.services.design.query(projectDir, select)).map((row) => ({
        objectType,
        ...row,
      })),
    ),
  );
  return groups.flat();
}

function normalizedId(value: unknown): string {
  return String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
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
      [
        ...violation.objectIds,
        ...violation.items.flatMap((item) => (item.uuid ? [item.uuid] : [])),
      ],
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
        ...affectedGeometry.flatMap((row) => [
          row["layer"],
          ...(Array.isArray(row["layers"]) ? row["layers"] : []),
        ]),
      ].filter(
        (layer): layer is string | number => typeof layer === "string" || typeof layer === "number",
      ),
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
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ view, width, height, quality }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found", "precondition");
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
  circuit_place,
  circuit_read_errors,
  route_run,
  verify_drc,
  render_board,
];
export { table };

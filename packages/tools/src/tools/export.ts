/** Export toolset: manufacturing outputs via kicad-cli. */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { projectBomCsv } from "@fabdesk/protocol";
import { PROJECT_FILES, ensureDir, jailPath, writeAtomic } from "../fs";
import { readProjectBom, assertProjectBomInputs } from "../project-bom";
import { ToolError, defineTool } from "../registry";
import { ok, p, requireBoard, requireKicad, requireSchematic } from "./common";
import { expectedPcbSource, withPcbOutput } from "../pcb-output";
import { silk_art } from "./silk-art";

const rel = (project: { dir: string }, abs: string) =>
  abs.startsWith(project.dir) ? abs.slice(project.dir.length + 1) : abs;

export const export_gerbers = defineTool({
  name: "export_gerbers",
  boardScoped: true,
  toolset: "export",
  title: "Export Gerbers",
  description:
    "Export Gerber files for all copper, mask, paste, silkscreen and edge layers to exports/gerbers/. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: { expectedSourceSha256: expectedPcbSource },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => withPcbOutput(ctx, args.expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "gerbers"));
    ctx.progress(0.2, "exporting gerbers");
    const { paths: files } = await ctx.services.kicad.exportGerbers(cli, {
      board,
      outDir,
      signal: ctx.signal,
    });
    ctx.progress(1, "done");
    return ok(
      `Exported ${files.length} gerber file(s) to exports/gerbers/:\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`,
      { files },
    );
  }),
});

const DXF_DEFAULT_LAYERS = ["F.Cu", "B.Cu", "Edge.Cuts"];

export const export_dxf = defineTool({
  name: "export_dxf",
  boardScoped: true,
  toolset: "export",
  title: "Export DXF artwork",
  description:
    "Export one millimetre-unit DXF per selected layer to exports/dxf/. Defaults to F.Cu, B.Cu, and Edge.Cuts. Bottom-layer output uses a top-view orientation.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    layers: z
      .array(z.string().min(1))
      .min(1)
      .default(DXF_DEFAULT_LAYERS)
      .describe("KiCad layer names, e.g. F.Cu, B.Cu, Edge.Cuts, F.Mask"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ layers, expectedSourceSha256 }, ctx) => withPcbOutput(ctx, expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "dxf"));
    ctx.progress(0.2, "exporting DXF");
    const { paths: files } = await ctx.services.kicad.exportDxf(cli, {
      board,
      outDir,
      layers,
      signal: ctx.signal,
    });
    ctx.progress(1, "done");
    const template = ctx.board ? undefined : project.manifest().board.template;
    const notes = [
      ...(layers.some((l) => /^B\./.test(l))
        ? ["Bottom-layer DXFs use a top-view orientation."]
        : []),
      ...(template === "viagrid-9055"
        ? [
            "Viagrid 9055: align to the exposed-FR4 marks in the blank's corners; the factory vias and mounting holes are already in the blank, so only copper is removed.",
          ]
        : []),
    ];
    return ok(
      `Exported ${files.length} DXF file(s) to exports/dxf/:\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}${notes.length ? `\n${notes.join("\n")}` : ""}`,
      { files, layers, notes },
    );
  }),
});

export const export_drill = defineTool({
  name: "export_drill",
  boardScoped: true,
  toolset: "export",
  title: "Export drill files",
  description:
    "Export Excellon drill files (plated/non-plated, with map) to exports/gerbers/. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: { expectedSourceSha256: expectedPcbSource },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => withPcbOutput(ctx, args.expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "gerbers"));
    ctx.progress(0.2, "exporting drill");
    const { paths: files } = await ctx.services.kicad.exportDrill(cli, {
      board,
      outDir,
      signal: ctx.signal,
    });
    ctx.progress(1, "done");
    return ok(
      `Exported ${files.length} drill file(s):\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`,
      { files },
    );
  }),
});

export const export_pos = defineTool({
  name: "export_pos",
  boardScoped: true,
  toolset: "export",
  title: "Export pick-and-place",
  description:
    "Export the component placement (pick-and-place) CSV to exports/positions.csv. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: { expectedSourceSha256: expectedPcbSource },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => withPcbOutput(ctx, args.expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const output = p(project, PROJECT_FILES.exports, "positions.csv");
    ctx.progress(0.2, "exporting positions");
    await ctx.services.kicad.exportPos(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Exported exports/positions.csv.`, { path: output });
  }),
});

export const export_bom = defineTool({
  name: "export_bom",
  toolset: "export",
  title: "Export BOM",
  description:
    "Export the project BOM from captured native schematic sources, explicit physical instances and project hardware. Writes exports/bom.csv and its coverage receipt. Incomplete or netlist-only coverage requires explicit allowPartial; pass expectedRevision from bom_read to refuse changed inputs.",
  inputSchema: { expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), allowPartial: z.boolean().default(false) },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ expectedRevision, allowPartial }, ctx) => {
    const project = ctx.requireProject();
    const snapshot = await readProjectBom(ctx);
    if (expectedRevision && snapshot.revision !== expectedRevision) throw new ToolError("BOM inputs changed; refresh and review the parts list before exporting.", "precondition");
    if (!snapshot.complete && !allowPartial) throw new ToolError("BOM source coverage is incomplete or netlist-only. Review bom_read coverage and explicitly choose allowPartial to export only listed parts.", "precondition");
    if (!snapshot.lines.length) throw new ToolError("No included parts are listed. Resolve the board sources or add project hardware before exporting.", "precondition");
    const output = await jailPath(project.dir, "exports/bom.csv"), receipt = await jailPath(project.dir, "exports/bom.coverage.json");
    await assertProjectBomInputs(project.dir, snapshot);
    await writeAtomic(receipt, `${JSON.stringify(snapshot, null, 2)}\n`);
    await writeAtomic(output, projectBomCsv(snapshot.lines));
    return ok(`Exported exports/bom.csv (${snapshot.lines.length} lines${snapshot.complete ? "" : "; partial source coverage"}). Coverage receipt: exports/bom.coverage.json. Electrical checks remain separate.`, { path: output, receiptPath: receipt, lines: snapshot.lines.length, complete: snapshot.complete, revision: snapshot.revision });
  },
});

export const export_netlist = defineTool({
  name: "export_netlist",
  toolset: "export",
  title: "Export netlist",
  description:
    "Export a KiCad or SPICE netlist from the saved native schematic to exports/netlist.<net|cir>.",
  inputSchema: {
    format: z.enum(["kicadsexpr", "spice"]).default("kicadsexpr"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ format }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const ext = { kicadsexpr: "net", spice: "cir" }[format];
    const output = p(project, PROJECT_FILES.exports, `netlist.${ext}`);
    await ctx.services.kicad.exportNetlist(cli, { schematic, output, format, signal: ctx.signal });
    return ok(`Exported exports/netlist.${ext} (${format}) from board.kicad_sch.`, {
      path: output,
      format,
      source: PROJECT_FILES.boardSch,
    });
  },
});

export const export_zip = defineTool({
  name: "export_zip",
  boardScoped: true,
  toolset: "export",
  title: "Zip fabrication outputs",
  description:
    "Bundle the files currently present in exports/gerbers plus positions.csv and bom.csv into exports/fabrication.zip or a named filename under exports/. Missing optional entries are reported.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    gerberFiles: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(240)).min(1).max(512).optional()
      .describe("Exact basenames in exports/gerbers/ to package from a completed Gerber/drill export. Omitting this retains saved-file packaging."),
    filename: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.zip$/)
      .max(200)
      .default("fabrication.zip")
      .describe("Archive basename under exports/, such as controller-fabrication.zip"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ filename, expectedSourceSha256, gerberFiles }, ctx) => withPcbOutput(ctx, expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const exportsDir = p(project, PROJECT_FILES.exports);
    const gerbersDir = join(exportsDir, "gerbers");
    const entries: Array<{ name: string; path: string }> = [];
    for (const f of gerberFiles ? [...new Set(gerberFiles)] : await readdir(gerbersDir).catch(() => [])) {
      const abs = join(gerbersDir, f);
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) entries.push({ name: `gerbers/${f}`, path: abs });
      else if (gerberFiles) throw new ToolError(`Requested manufacturing file is missing: ${f}. Export again before packaging.`, "precondition");
    }
    const missing: string[] = [];
    for (const f of gerberFiles ? [] : ["positions.csv", "bom.csv"]) {
      const abs = join(exportsDir, f);
      if (await stat(abs).catch(() => null)) entries.push({ name: f, path: abs });
      else missing.push(f);
    }
    if (entries.length === 0)
      throw new ToolError("no fabrication outputs found in exports/", "precondition");
    const output = join(exportsDir, filename);
    await zipFiles(output, entries);
    const size = (await stat(output)).size;
    return ok(
      `Wrote exports/${filename} (${entries.length} files, ${size} bytes).${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`,
      { path: output, files: entries.map((e) => e.name), missing, size },
    );
  }, true),
});

/** Minimal ZIP writer (stored, no compression) to avoid a dependency; fab outputs are small. */
export async function zipFiles(
  output: string,
  entries: Array<{ name: string; path: string }>,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  const crcTable = makeCrcTable();
  for (const e of entries) {
    const data = new Uint8Array(await Bun.file(e.path).arrayBuffer());
    const name = enc.encode(e.name);
    const crc = crc32(data, crcTable);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  await Bun.write(output, out);
}

function makeCrcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

function crc32(data: Uint8Array, table: Uint32Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    crc = (table[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const export_stencil = defineTool({
  name: "export_stencil",
  boardScoped: true,
  toolset: "export",
  title: "Export 3D-printed solder stencil",
  description:
    "Build a solder-stencil STL from the board's F.Paste (or B.Paste) pads, preserving paste geometry by default. Writes exports/stencil/<side>-Paste.stl plus JSON/markdown/SVG summaries. Shrink, small-opening/fine-pitch filters and alignment holes are opt-in; skipped pads are reported. Optional jig tray. Pure TypeScript — does not need kicad-cli. Inspect the sliced openings for your nozzle before printing.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    side: z.enum(["F", "B"]).default("F").describe("Paste layer: F.Paste or B.Paste"),
    thicknessMm: z
      .number()
      .positive()
      .default(0.15)
      .describe("Plate thickness in mm (0.12–0.2 is typical for FDM/resin)"),
    frameMm: z.number().nonnegative().default(5).describe("Border around the board outline in mm"),
    apertureOffsetMm: z
      .number()
      .default(0)
      .describe(
        "Additional per-pad shrink (positive) or grow (negative) in mm, after KiCad paste margins",
      ),
    minApertureMm: z
      .number()
      .nonnegative()
      .default(0)
      .describe("Skip pads whose opening is smaller than this after shrink"),
    skipFinePitch: z
      .boolean()
      .default(false)
      .describe("Skip footprints whose paste-pad pitch is below finePitchMm"),
    finePitchMm: z.number().positive().default(0.5).describe("Fine-pitch threshold in mm"),
    alignment: z
      .enum(["holes", "pegs", "none"])
      .default("none")
      .describe("Registration: NPTH/tooling holes, or frame-corner holes if the board has none"),
    alignmentHoleMm: z
      .number()
      .positive()
      .default(3.2)
      .describe("Frame-corner hole diameter when no NPTH tooling holes exist"),
    includeJig: z
      .boolean()
      .default(false)
      .describe("Also write a simple PCB-holder tray STL with a board pocket and alignment pegs"),
    pcbThicknessMm: z
      .number()
      .positive()
      .default(1.6)
      .describe("Pocket depth for the optional jig"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => withPcbOutput(ctx, args.expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "stencil"));
    ctx.progress(0.2, "building stencil");
    const summary = await ctx.services.kicad.exportStencil({
      board,
      outDir,
      side: args.side,
      thicknessMm: args.thicknessMm,
      frameMm: args.frameMm,
      apertureOffsetMm: args.apertureOffsetMm,
      minApertureMm: args.minApertureMm,
      skipFinePitch: args.skipFinePitch,
      finePitchMm: args.finePitchMm,
      alignment: args.alignment,
      alignmentHoleMm: args.alignmentHoleMm,
      includeJig: args.includeJig,
      pcbThicknessMm: args.pcbThicknessMm,
    });
    ctx.progress(1, "done");
    const files = [
      summary.files.stl,
      summary.files.json,
      summary.files.markdown,
      summary.files.svg,
    ];
    if (summary.files.jig) files.push(summary.files.jig);
    const warn = summary.warnings.length
      ? `\nWarnings:\n${summary.warnings.map((w) => `- ${w.message}`).join("\n")}`
      : "";
    return ok(
      `Exported 3D-printed ${summary.side}.Paste stencil to exports/stencil/: ${summary.apertureCount} aperture(s) from ${summary.padCount} paste pad(s), ${summary.triangleCount} triangles, min opening ${summary.minApertureMm == null ? "n/a" : `${summary.minApertureMm.toFixed(3)} mm`}.${warn}\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`,
      { ...summary, files, path: summary.files.stl },
    );
  }),
});

export const export_laser_stencil = defineTool({
  name: "export_laser_stencil",
  boardScoped: true,
  toolset: "export",
  title: "Export laser-cut solder stencil",
  description:
    "Export a LightBurn .lbrn2 job plus layered SVG/DXF of F.Paste (or B.Paste) for a ComMarker Omni X 355 nm UV galvo (LightBurn / EZCAD). Presets: mylar-uv (default, 0.1 mm Mylar/PET), kapton (0.075 mm PI), stainless-0.1. Applies paste-release shrink plus kerf compensation, minimum-aperture checks, a frame, and printer-frame fiducials. Power/speed/frequency/passes are editable starting points written into the .lbrn2. Pure TypeScript — does not need kicad-cli.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    side: z.enum(["F", "B"]).default("F").describe("Paste layer: F.Paste or B.Paste"),
    preset: z
      .enum(["mylar-uv", "kapton", "stainless-0.1"])
      .default("mylar-uv")
      .describe(
        "mylar-uv = 0.1 mm Mylar/PET on Omni X 355 nm UV (default); kapton = 0.075 mm PI; stainless-0.1 = 0.1 mm stainless foil",
      ),
    frameMm: z
      .number()
      .nonnegative()
      .optional()
      .describe("Border around the board outline in mm (preset default 8)"),
    thicknessMm: z.number().positive().optional().describe("Film / foil thickness in mm"),
    apertureOffsetMm: z
      .number()
      .optional()
      .describe("Per-side paste-release shrink (positive) or grow (negative) in mm"),
    kerfMm: z
      .number()
      .optional()
      .describe("Additional per-side kerf compensation in mm, added to apertureOffsetMm"),
    minApertureMm: z
      .number()
      .nonnegative()
      .optional()
      .describe("Skip pads whose opening is smaller than this after shrink"),
    skipFinePitch: z
      .boolean()
      .optional()
      .describe("Skip footprints whose paste-pad pitch is below finePitchMm"),
    finePitchMm: z.number().positive().optional().describe("Fine-pitch threshold in mm"),
    alignmentHoleMm: z
      .number()
      .positive()
      .optional()
      .describe("Printer-frame fiducial diameter in mm (preset default 3.2)"),
    includeFiducials: z
      .boolean()
      .optional()
      .describe("Cut frame-corner + board NPTH registration holes (default true)"),
    powerPct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Starting-point laser power percent (not a certified recipe)"),
    speedMmPerS: z
      .number()
      .positive()
      .optional()
      .describe("Starting-point cut speed in mm/s (not a certified recipe)"),
    frequencyKhz: z
      .number()
      .positive()
      .optional()
      .describe("Starting-point pulse frequency in kHz (not a certified recipe)"),
    pulseNs: z
      .number()
      .positive()
      .optional()
      .describe("Starting-point pulse width in ns (not a certified recipe)"),
    passes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Starting-point pass count (not a certified recipe)"),
    lensMm: z.number().positive().optional().describe("Lens focal length in mm used for the starting-point table"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => withPcbOutput(ctx, args.expectedSourceSha256, async (ctx) => {
    const project = ctx.requireProject();
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "stencil"));
    ctx.progress(0.2, "building laser stencil");
    let summary;
    try {
      summary = await ctx.services.kicad.exportLaserStencil({
        board,
        outDir,
        side: args.side,
        preset: args.preset,
        ...(args.frameMm != null ? { frameMm: args.frameMm } : {}),
        ...(args.thicknessMm != null ? { thicknessMm: args.thicknessMm } : {}),
        ...(args.apertureOffsetMm != null ? { apertureOffsetMm: args.apertureOffsetMm } : {}),
        ...(args.kerfMm != null ? { kerfMm: args.kerfMm } : {}),
        ...(args.minApertureMm != null ? { minApertureMm: args.minApertureMm } : {}),
        ...(args.skipFinePitch != null ? { skipFinePitch: args.skipFinePitch } : {}),
        ...(args.finePitchMm != null ? { finePitchMm: args.finePitchMm } : {}),
        ...(args.alignmentHoleMm != null ? { alignmentHoleMm: args.alignmentHoleMm } : {}),
        ...(args.includeFiducials != null ? { includeFiducials: args.includeFiducials } : {}),
        ...(args.powerPct != null ? { powerPct: args.powerPct } : {}),
        ...(args.speedMmPerS != null ? { speedMmPerS: args.speedMmPerS } : {}),
        ...(args.frequencyKhz != null ? { frequencyKhz: args.frequencyKhz } : {}),
        ...(args.pulseNs != null ? { pulseNs: args.pulseNs } : {}),
        ...(args.passes != null ? { passes: args.passes } : {}),
        ...(args.lensMm != null ? { lensMm: args.lensMm } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "LaserStencilOptionsError") {
        throw new ToolError(error.message, "invalid_args");
      }
      throw error;
    }
    ctx.progress(1, "done");
    const files = [
      summary.files.lbrn2,
      summary.files.svg,
      summary.files.dxf,
      summary.files.json,
      summary.files.markdown,
      summary.files.notes,
    ];
    const warn = summary.warnings.length
      ? `\nWarnings:\n${summary.warnings.map((w) => `- ${w.message}`).join("\n")}`
      : "";
    return ok(
      `Exported laser-cut ${summary.side}.Paste stencil (${summary.presetTitle}) to exports/stencil/: ${summary.apertureCount} aperture(s), ${summary.fiducialCount} fiducial(s), shrink ${summary.totalShrinkMm} mm/side. Starting-point job ${summary.job.powerPct}% · ${summary.job.speedMmPerS} mm/s · ${summary.job.frequencyKhz} kHz · ${summary.job.passes} pass(es). Open the .lbrn2 in LightBurn; SVG/DXF are for EZCAD.${warn}\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`,
      { ...summary, files, path: summary.files.lbrn2 },
    );
  }),
});

export const exportTools = [
  export_gerbers,
  export_drill,
  export_pos,
  export_bom,
  export_netlist,
  export_zip,
  export_dxf,
  silk_art,
  export_stencil,
  export_laser_stencil,
];

/** Export toolset: manufacturing outputs via kicad-cli. */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { copyFile } from "node:fs/promises";
import type { NetlistComponent } from "@fabdesk/protocol";
import { PROJECT_FILES, ensureDir, exists, writeAtomic } from "../fs";
import { ToolError, defineTool } from "../registry";
import { loadNetlist, ok, p, requireBoard, requireKicad } from "./common";

const rel = (project: { dir: string }, abs: string) => abs.startsWith(project.dir) ? abs.slice(project.dir.length + 1) : abs;

export const export_gerbers = defineTool({
  name: "export_gerbers",
  toolset: "export",
  title: "Export Gerbers",
  description: "Export Gerber files for all copper, mask, paste, silkscreen and edge layers to exports/gerbers/. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "gerbers"));
    ctx.progress(0.2, "exporting gerbers");
    const { paths: files } = await ctx.services.kicad.exportGerbers(cli, { board, outDir, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Exported ${files.length} gerber file(s) to exports/gerbers/:\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`, { files });
  },
});

const DXF_DEFAULT_LAYERS = ["F.Cu", "B.Cu", "Edge.Cuts"];

export const export_dxf = defineTool({
  name: "export_dxf",
  toolset: "export",
  title: "Export DXF artwork",
  description:
    "Export one DXF per layer (mm) to exports/dxf/: the copper-removal artwork for prefab blanks such as Viagrid, where a laser (LightBurn) or CNC isolates the traces instead of a fab. Default layers F.Cu, B.Cu and Edge.Cuts. The bottom layer is drawn as seen from the top: mirror it in the laser software before burning. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {
    layers: z.array(z.string().min(1)).min(1).default(DXF_DEFAULT_LAYERS).describe("KiCad layer names, e.g. F.Cu, B.Cu, Edge.Cuts, F.Mask"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ layers }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "dxf"));
    ctx.progress(0.2, "exporting DXF");
    const { paths: files } = await ctx.services.kicad.exportDxf(cli, { board, outDir, layers, signal: ctx.signal });
    ctx.progress(1, "done");
    const template = project.manifest().board.template;
    const notes = [
      ...(layers.some((l) => /^B\./.test(l)) ? ["Bottom-layer DXFs are as seen from the top; mirror them (LightBurn: Arrange → Flip Horizontal) before burning."] : []),
      ...(template === "viagrid-9055" ? ["Viagrid 9055: align to the exposed-FR4 marks in the blank's corners; the factory vias and mounting holes are already in the blank, so only copper is removed."] : []),
    ];
    return ok(`Exported ${files.length} DXF file(s) to exports/dxf/:\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}${notes.length ? `\n${notes.join("\n")}` : ""}`, { files, layers, notes });
  },
});

export const export_drill = defineTool({
  name: "export_drill",
  toolset: "export",
  title: "Export drill files",
  description: "Export Excellon drill files (plated/non-plated, with map) to exports/gerbers/. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.exports, "gerbers"));
    ctx.progress(0.2, "exporting drill");
    const { paths: files } = await ctx.services.kicad.exportDrill(cli, { board, outDir, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Exported ${files.length} drill file(s):\n${files.map((f) => `- ${rel(project, f)}`).join("\n")}`, { files });
  },
});

export const export_pos = defineTool({
  name: "export_pos",
  toolset: "export",
  title: "Export pick-and-place",
  description: "Export the component placement (pick-and-place) CSV to exports/positions.csv. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const output = p(project, PROJECT_FILES.exports, "positions.csv");
    ctx.progress(0.2, "exporting positions");
    await ctx.services.kicad.exportPos(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Exported exports/positions.csv.`, { path: output });
  },
});

export const export_bom = defineTool({
  name: "export_bom",
  toolset: "export",
  title: "Export BOM",
  description: "Export the bill of materials CSV (reference, value, footprint, quantity and any extra fields) from circuit.netlist.json to exports/bom.csv.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const { netlist } = await loadNetlist(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const output = p(project, PROJECT_FILES.exports, "bom.csv");
    await writeAtomic(output, bomCsv(netlist.components));
    return ok(`Exported exports/bom.csv (${netlist.components.length} components).`, { path: output, components: netlist.components.length });
  },
});

export const export_netlist = defineTool({
  name: "export_netlist",
  toolset: "export",
  title: "Export netlist",
  description: "Export the netlist to exports/netlist.<net|cir>: kicadsexpr is the KiCad netlist the last circuit_build handed to KiCad; spice is generated from circuit.netlist.json.",
  inputSchema: {
    format: z.enum(["kicadsexpr", "spice"]).default("kicadsexpr"),
  },
  annotations: { idempotentHint: true },
  handler: async ({ format }, ctx) => {
    const project = ctx.requireProject();
    await ensureDir(p(project, PROJECT_FILES.exports));
    const ext = { kicadsexpr: "net", spice: "cir" }[format];
    const output = p(project, PROJECT_FILES.exports, `netlist.${ext}`);
    if (format === "kicadsexpr") {
      const compiled = p(project, PROJECT_FILES.compileNet);
      if (!(await exists(compiled))) throw new ToolError(`${PROJECT_FILES.compileNet} not found: run circuit_build first`, "precondition");
      await copyFile(compiled, output);
    } else {
      await writeAtomic(output, ctx.services.sim.spiceNetlist(await loadNetlist(project)));
    }
    return ok(`Exported exports/netlist.${ext} (${format}).`, { path: output, format });
  },
});

export const export_zip = defineTool({
  name: "export_zip",
  toolset: "export",
  title: "Zip fabrication outputs",
  description: "Bundle exports/gerbers, positions.csv and bom.csv into exports/fabrication.zip for upload to a fab house. Run export_gerbers, export_drill, export_pos and export_bom first (missing ones are skipped and reported).",
  inputSchema: {},
  annotations: { idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const exportsDir = p(project, PROJECT_FILES.exports);
    const gerbersDir = join(exportsDir, "gerbers");
    const entries: Array<{ name: string; path: string }> = [];
    for (const f of await readdir(gerbersDir).catch(() => [])) {
      const abs = join(gerbersDir, f);
      if ((await stat(abs)).isFile()) entries.push({ name: `gerbers/${f}`, path: abs });
    }
    const missing: string[] = [];
    for (const f of ["positions.csv", "bom.csv"]) {
      const abs = join(exportsDir, f);
      if (await stat(abs).catch(() => null)) entries.push({ name: f, path: abs });
      else missing.push(f);
    }
    if (entries.length === 0) throw new ToolError("nothing to zip: run export_gerbers/export_drill/export_pos/export_bom first", "precondition");
    const output = join(exportsDir, "fabrication.zip");
    await zipFiles(output, entries);
    const size = (await stat(output)).size;
    return ok(`Wrote exports/fabrication.zip (${entries.length} files, ${size} bytes).${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`, { path: output, files: entries.map((e) => e.name), missing, size });
  },
});

/** CSV with one row per component; extra `fields` become extra columns. */
export function bomCsv(components: readonly NetlistComponent[]): string {
  const extra = [...new Set(components.flatMap((c) => Object.keys(c.fields ?? {})))].sort();
  const cols = ["Reference", "Value", "Footprint", ...extra];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [cols.join(",")];
  for (const c of [...components].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))) {
    lines.push([c.ref, c.value, c.footprint, ...extra.map((k) => c.fields?.[k] ?? "")].map(q).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Minimal ZIP writer (stored, no compression) to avoid a dependency; fab outputs are small. */
export async function zipFiles(output: string, entries: Array<{ name: string; path: string }>): Promise<void> {
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
  for (let i = 0; i < data.length; i++) crc = (table[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const exportTools = [export_gerbers, export_drill, export_pos, export_bom, export_netlist, export_zip, export_dxf];

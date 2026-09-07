/** Render toolset: SVGs and GLB from the KiCad board via kicad-cli. */
import { readFile } from "node:fs/promises";
import { PROJECT_FILES, ensureDir } from "../fs";
import { defineTool } from "../registry";
import { ok, p, requireBoard, requireKicad, requireSchematic } from "./common";

export const render_schematic_svg = defineTool({
  name: "render_schematic_svg",
  toolset: "render",
  title: "Render schematic SVG",
  description: "Render board.kicad_sch to renders/schematic.svg with kicad-cli and return it. A compiled project has no drawn schematic (the netlist carries no geometry), so this only shows an imported one.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const outDir = await ensureDir(p(project, PROJECT_FILES.renders, "schematic"));
    ctx.progress(0.2, "exporting svg");
    const { paths } = await ctx.services.kicad.exportSchematicSvg(cli, { schematic, outDir, signal: ctx.signal });
    const first = paths[0];
    const output = p(project, PROJECT_FILES.renders, "schematic.svg");
    if (first) await Bun.write(output, await readFile(first));
    ctx.progress(1, "done");
    return ok(`Rendered ${paths.length} schematic sheet(s); first at ${PROJECT_FILES.renders}/schematic.svg.`, { path: output, sheets: paths }, first ? { images: [{ path: output, mime: "image/svg+xml" }] } : {});
  },
});

export const render_pcb_svg = defineTool({
  name: "render_pcb_svg",
  toolset: "render",
  title: "Render PCB SVG",
  description: "Render board.kicad_pcb (copper, silkscreen, edge cuts) to renders/pcb.svg with kicad-cli and return it. Requires circuit_build.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    await ensureDir(p(project, PROJECT_FILES.renders));
    const output = p(project, PROJECT_FILES.renders, "pcb.svg");
    ctx.progress(0.2, "exporting svg");
    await ctx.services.kicad.exportPcbSvg(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Rendered PCB to ${PROJECT_FILES.renders}/pcb.svg.`, { path: output }, { images: [{ path: output, mime: "image/svg+xml" }] });
  },
});

export const render_glb = defineTool({
  name: "render_glb",
  toolset: "render",
  title: "Export 3D GLB",
  description: "Export a 3D model (GLB) of the KiCad board to renders/board.glb for the app's 3D tab. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const output = p(project, PROJECT_FILES.renders, "board.glb");
    ctx.progress(0.2, "exporting glb");
    const res = await ctx.services.kicad.exportGlb(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    return ok(`Exported ${PROJECT_FILES.renders}/board.glb${res.fused ? " (fused shapes)" : ""}.${res.warnings.length ? `\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}` : ""}`, { path: output, ...res });
  },
});

export const renderTools = [render_schematic_svg, render_pcb_svg, render_glb];

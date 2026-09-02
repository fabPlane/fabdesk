/** Render toolset: SVGs from circuit-json, GLB from KiCad. */
import { z } from "zod/v4";
import { PROJECT_FILES, writeAtomic } from "../fs";
import { defineTool } from "../registry";
import { loadCircuitJson, ok, p, requireBoard, requireKicad } from "./common";

export const render_schematic_svg = defineTool({
  name: "render_schematic_svg",
  toolset: "render",
  title: "Render schematic SVG",
  description: "Render the schematic of the built circuit to renders/schematic.svg (circuit-to-svg, no KiCad needed) and return it. Useful to check symbol placement and net labels.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const { circuitJson, source } = await loadCircuitJson(project);
    const svg = ctx.services.tscircuit.schematicSvg(circuitJson);
    const output = p(project, PROJECT_FILES.renders, "schematic.svg");
    await writeAtomic(output, svg);
    return ok(`Rendered schematic from ${source} to ${PROJECT_FILES.renders}/schematic.svg (${svg.length} bytes).`, { path: output, bytes: svg.length }, { images: [{ path: output, mime: "image/svg+xml" }] });
  },
});

export const render_pcb_svg = defineTool({
  name: "render_pcb_svg",
  toolset: "render",
  title: "Render PCB SVG",
  description: "Render the PCB (footprints, traces, vias, board outline) of the built or routed circuit to renders/pcb.svg (circuit-to-svg, no KiCad needed) and return it.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const { circuitJson, source } = await loadCircuitJson(project);
    const svg = ctx.services.tscircuit.pcbSvg(circuitJson);
    const output = p(project, PROJECT_FILES.renders, "pcb.svg");
    await writeAtomic(output, svg);
    return ok(`Rendered PCB from ${source} to ${PROJECT_FILES.renders}/pcb.svg (${svg.length} bytes).`, { path: output, bytes: svg.length }, { images: [{ path: output, mime: "image/svg+xml" }] });
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

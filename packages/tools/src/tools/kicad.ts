/** KiCad toolset: conversion and board statistics. */
import { z } from "zod/v4";
import { PROJECT_FILES } from "../fs";
import { defineTool, type ToolContext, type ToolOutput } from "../registry";
import { loadCircuitJson, ok, p, requireBoard, requireKicad, table, writeReport } from "./common";

export async function convertProject(ctx: ToolContext): Promise<{ files: string[]; warnings: string[]; source: string }> {
  const project = ctx.requireProject();
  const { circuitJson, source } = await loadCircuitJson(project);
  const res = await ctx.services.kicad.convertToKicad({ circuitJson, projectDir: project.dir, projectName: "board" });
  await writeReport(project, "convert", { at: new Date().toISOString(), source, ...res });
  return { ...res, source };
}

export const kicad_convert = defineTool({
  name: "kicad_convert",
  toolset: "kicad",
  title: "Convert to KiCad",
  description:
    "Convert the circuit (circuit.routed.json when present, else circuit.json) into board.kicad_pcb, board.kicad_sch and board.kicad_pro in the project directory. Needed before DRC/ERC, rendering and exports; verify_drc and render_board call it automatically when the board is stale.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx): Promise<ToolOutput> => {
    ctx.progress(0.1, "converting");
    const { files, warnings, source } = await convertProject(ctx);
    ctx.progress(1, "done");
    return ok(`Converted ${source} → ${files.map((f) => f.split("/").pop()).join(", ")}${warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""}`, { files, warnings, source });
  },
});

export const kicad_stats = defineTool({
  name: "kicad_stats",
  toolset: "kicad",
  title: "Board statistics",
  description: "Board statistics from KiCad: outline size, layer count, footprint/pad/track/via counts, drill sizes. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const stats = await ctx.services.kicad.boardStats(cli, { board, scratchFile: p(project, PROJECT_FILES.reports, "stats.json") });
    const rows = Object.entries(stats).map(([key, value]) => ({ key, value }));
    return ok(`Board stats for ${PROJECT_FILES.boardPcb}:\n${table(rows)}`, stats);
  },
});

export const kicadTools = [kicad_convert, kicad_stats];

/** KiCad toolset: board statistics. The board itself is written by circuit_build and edited by route_run. */
import { PROJECT_FILES } from "../fs";
import { defineTool } from "../registry";
import { ok, p, requireBoard, requireKicad, table } from "./common";

export const kicad_stats = defineTool({
  name: "kicad_stats",
  toolset: "kicad",
  title: "Board statistics",
  description:
    "Board statistics from KiCad: outline size, layer count, footprint/pad/track/via counts, drill sizes. Requires board.kicad_pcb and a kicad-cli build with pcb export stats (not available in every build; doctor reports support).",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const stats = await ctx.services.kicad.boardStats(cli, {
      board,
      scratchFile: p(project, PROJECT_FILES.reports, "stats.json"),
    });
    const rows = Object.entries(stats).map(([key, value]) => ({ key, value }));
    return ok(`Board stats for ${PROJECT_FILES.boardPcb}:\n${table(rows)}`, stats);
  },
});

export const kicadTools = [kicad_stats];

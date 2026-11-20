import { relative } from "node:path";
import { z } from "zod/v4";
import { refresh, inspect, packet } from "@fabdesk/board-representation";
import { defineTool } from "../registry";
import { jailPath, readJsonOrNull } from "../fs";

export const board_representation = defineTool({
  name: "board_representation",
  toolset: "board",
  title: "Read saved board facts and revision evidence",
  description:
    "Separate factual saved-source representation. current captures actual native files and reports changes, saved-fill checks and coverage without judging completion or gating saves. inspect refreshes current files before retrieving a labelled historical revision. Native runtime required; unsupported runtime/checks fail explicitly. Does not refill or save the original. Full native facts and check occurrences stay in revision evidence.",
  inputSchema: {
    action: z.enum(["current", "inspect"]).default("current"),
    pcb: z.string().optional(),
    revision: z.string().optional(),
    component: z.string().optional(),
    net: z.string().optional(),
    region: z
      .array(z.number().finite())
      .length(4)
      .optional()
      .describe("Intersect native bounds with x1,y1,x2,y2 in mm"),
    detail: z.enum(["facts", "receipt", "source"]).default("facts"),
    finding: z.string().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  longRunning: true,
  handler: async ({ action, pcb, revision, component, net, region, detail, finding }, ctx) => {
    const project = ctx.requireProject();
    const manifest = await readJsonOrNull<{ importedBoard?: { path?: string } }>(
      `${project.dir}/fabdesk.json`,
    );
    const board = relative(
      project.dir,
      await jailPath(project.dir, pcb ?? manifest?.importedBoard?.path ?? "board.kicad_pcb"),
    ).replaceAll("\\", "/");
    const current = await refresh(project.dir, board, (options) =>
      ctx.services.kicad.resolveCli(options),
    );
    const result =
      action === "inspect"
        ? {
            current: packet(current),
            detail: await inspect(project.dir, board, revision ?? current.revision, {
              ...(component ? { component } : {}),
              ...(net !== undefined ? { net } : {}),
              ...(region ? { region } : {}),
              detail,
              ...(finding ? { finding } : {}),
            }),
          }
        : packet(current);
    return {
      text: `Saved board representation: ${current.sourceStatus}; checks ${current.check.status}; revision ${current.revision}.`,
      json: result,
    };
  },
});

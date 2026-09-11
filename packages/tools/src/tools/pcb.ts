/** Explicit native PCB setup and placement following schematic forward annotation. */
import { z } from "zod/v4";
import { ToolError, defineTool } from "../registry";
import { ok } from "./common";

const Point = z.object({ x: z.number().finite(), y: z.number().finite() });

export const pcb_define_outline = defineTool({
  name: "pcb_define_outline",
  toolset: "circuit",
  title: "Define PCB outline",
  description:
    "Create a native board.kicad_pcb outer Edge.Cuts boundary. Give widthMm/heightMm for a rectangle at (0,0), or at least three polygon points in mm. Re-running accepts an exact match. replace=true updates only an outline previously created by this tool; a different existing outline fails closed.",
  inputSchema: {
    widthMm: z.number().positive().optional(),
    heightMm: z.number().positive().optional(),
    points: z.array(Point).min(3).max(100).optional(),
    replace: z.boolean().default(false),
  },
  annotations: { idempotentHint: true },
  handler: async ({ widthMm, heightMm, points, replace }, ctx) => {
    if (!points && !(widthMm && heightMm))
      throw new ToolError("provide points or both widthMm and heightMm", "invalid_args");
    const outline = points ?? [
      { x: 0, y: 0 },
      { x: widthMm!, y: 0 },
      { x: widthMm!, y: heightMm! },
      { x: 0, y: heightMm! },
    ];
    const project = ctx.requireProject();
    const result = await ctx.services.design.defineBoardOutline(project.dir, outline, replace);
    return ok(
      `PCB outline saved at revision ${result.revision}: ${result.created} segments created, ${result.replaced} replaced.`,
      result,
    );
  },
});

export const pcb_place = defineTool({
  name: "pcb_place",
  toolset: "circuit",
  title: "Place PCB footprints",
  description:
    "Place native PCB footprints by reference at explicit millimetre coordinates. This changes only physical placement in board.kicad_pcb. Unknown references fail without a partial placement.",
  inputSchema: {
    placements: z
      .array(
        z.object({
          reference: z.string().min(1),
          position: Point.optional(),
          rotation: z.number().finite().optional(),
          flip: z.boolean().optional(),
          lock: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(500),
  },
  annotations: { idempotentHint: true },
  handler: async ({ placements }, ctx) => {
    const project = ctx.requireProject();
    const result = await ctx.services.design.placeFootprints(project.dir, placements);
    return {
      text: result.missing.length
        ? `Placement blocked; unknown references: ${result.missing.join(", ")}.`
        : `Placed ${result.moved.length} footprint(s) and saved board revision ${result.revision}: ${result.moved.join(", ") || "already at requested positions"}.`,
      json: result,
      isError: result.missing.length > 0,
    };
  },
});

export const pcbTools = [pcb_define_outline, pcb_place];

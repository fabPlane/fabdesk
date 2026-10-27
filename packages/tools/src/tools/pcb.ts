/** Explicit native PCB setup and placement following schematic forward annotation. */
import { readCopper, recordRemoval, quality, qualityText } from "../routing-quality";
import { z } from "zod/v4";
import { ToolError, defineTool, mutationInputObject } from "../registry";
import { ok } from "./common";

const Point = mutationInputObject({ x: z.number().finite(), y: z.number().finite() });

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
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
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
    "Place native PCB footprints and adjust their silkscreen reference fields at explicit millimetre coordinates. Reports routed copper made stale or shorted by a transform. Existing embedded geometry is preserved; the source footprint library is not required. Unknown references fail without a partial placement. Save any open PCB and schematic first: placement recovery may restart KiCad.",
  inputSchema: {
    placements: z
      .array(
        mutationInputObject({
          reference: z.string().min(1),
          position: Point.optional(),
          rotation: z.number().finite().optional(),
          flip: z.boolean().optional(),
          lock: z.boolean().optional(),
          referenceField: mutationInputObject({
            visible: z.boolean().optional(),
            position: Point.optional().describe("Absolute board position in millimetres"),
            sizeMm: z.number().positive().max(5).optional(),
          }).optional(),
        }),
      )
      .min(1)
      .max(500),
    expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Saved PCB hash from pcb_inspect. Reject the edit if the board changed since inspection."),
    staleCopper: z
      .enum(["keep", "remove"])
      .default("keep")
      .describe(
        "Whether to preserve stale attached fan-out copper or remove it in the placement transaction",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ placements, staleCopper, expectedSourceSha256 }, ctx) => {
    const project = ctx.requireProject();
    const copperBefore = staleCopper === "remove" ? await readCopper(project.dir) : null;
    const result = await ctx.services.design.placeFootprints(project.dir, placements, {
      staleCopper,
      ...(expectedSourceSha256 ? { expectedSourceSha256 } : {}),
    });
    const removedFacts =
      copperBefore && result.removedCopper
        ? await recordRemoval(project.dir, copperBefore, await readCopper(project.dir))
        : null;
    const staleLines = Object.entries(result.staleCopper ?? {}).map(
      ([reference, report]) =>
        `${reference}: ${report.staleCount} stale copper item(s) on ${report.nets.length} net(s); ${report.shortedCount} now touch pads of other nets.`,
    );
    if (result.removedCopper)
      staleLines.push(
        `Removed ${result.removedCopper.ids.length} stale copper item(s) in the placement transaction on net(s) ${result.removedCopper.nets.join(", ")}; zone refill ${result.zoneRefill ? (result.zoneRefill.refilled ? "completed" : `failed: ${result.zoneRefill.error ?? "unknown error"}`) : "not run"}.`,
      );
    if (removedFacts)
      staleLines.push(
        qualityText({
          nets: removedFacts.nets,
          pairs: [],
          reference: [],
          lengthConvention: "chord",
        }),
      );
    const base = result.missing.length
      ? `Placement blocked; unknown references: ${result.missing.join(", ")}.`
      : `Placed ${result.moved.length} footprint(s) and saved board revision ${result.revision}: ${result.moved.join(", ") || "already at requested positions"}.`;
    return {
      text: [base, ...staleLines].join("\n"),
      json: { ...result, ...(removedFacts ? { removedCopperFacts: removedFacts } : {}) },
      isError: result.missing.length > 0,
    };
  },
});

export const pcbTools = [pcb_define_outline, pcb_place];

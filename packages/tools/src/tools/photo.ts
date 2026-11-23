/** Photo → editable KiCad project. */
import { z } from "zod/v4";
import { PhotoSighting, SightedItem } from "@fabdesk/protocol";
import { defineTool } from "../registry";
import { analyzePhotos, continueToProject, loadSighting, markStep, newPhotoSession, saveSession, PHOTO_FILES } from "../photo/pipeline";
import { ok, table } from "./common";
import { ToolError } from "../registry";

const PhotoPath = z.string().min(1).describe("Project-relative path, usually under sketches/");

const ScaleHintArgs = {
  knownDimensionMm: z.number().positive().optional().describe("One measured edge of the board or a known part, in mm"),
  knownDimensionOf: z.enum(["width", "height", "diagonal", "part"]).optional(),
  knownPart: z
    .enum(["usb_c", "usb_a", "aa_holder", "aaa_holder", "18650", "rj45", "hdmi", "microsd", "pin_header_2_54"])
    .optional(),
};

export const photo_analyze = defineTool({
  name: "photo_analyze",
  toolset: "core",
  title: "Read hardware photos",
  description:
    "Vision pass over one or more photos of a board or device: identify visible parts (ICs with markings, connectors, switches, LEDs, batteries, displays, encoders, passives), front/back, mounting holes, the board outline, and a scale assumption. Writes photo/sighting.json. Returns a what-I-see table with per-item confidence so the user can correct it before photo_to_project. Does not copy traces; later steps draft a functional equivalent. Pass items when you already read the photos yourself.",
  inputSchema: {
    photos: z.array(PhotoPath).min(1).max(8),
    description: z.string().max(4000).optional().describe("What the user wants the board to do"),
    sides: z.array(z.enum(["front", "back", "unknown"])).optional(),
    items: z.array(SightedItem).optional().describe("Corrected or agent-supplied what-I-see list"),
    openSourceSuspected: z.boolean().optional(),
    ...ScaleHintArgs,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  longRunning: true,
  handler: async (args, ctx) => {
    const { sighting, session } = await analyzePhotos(ctx, {
      photos: args.photos,
      ...(args.description ? { description: args.description } : {}),
      ...(args.items ? { items: args.items } : {}),
      ...(args.openSourceSuspected ? { openSourceSuspected: true } : {}),
      ...(args.sides ? { sides: args.sides } : {}),
      hint: {
        ...(args.knownDimensionMm ? { userDimensionMm: args.knownDimensionMm } : {}),
        ...(args.knownDimensionOf ? { userDimensionOf: args.knownDimensionOf } : {}),
        ...(args.knownPart ? { knownPart: args.knownPart } : {}),
      },
    });
    const rows = sighting.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      markings: item.markings ?? "",
      mpn: item.mpn ?? "",
      side: item.side,
      confidence: item.confidence,
    }));
    const license = sighting.openSourceNote?.suspected
      ? `\nPossible open-source original${sighting.openSourceNote.projectName ? ` (${sighting.openSourceNote.projectName})` : ""}. Attribute the authors; this draft is not that design.`
      : "";
    const text = [
      `What I see (${sighting.items.length} items). Scale: ${sighting.scale.note}`,
      `Outline: ${sighting.outline.polygon.length} points, ${sighting.scale.boardWidthMm}×${sighting.scale.boardHeightMm} mm (${sighting.outline.source}).`,
      table(rows, ["id", "kind", "label", "markings", "mpn", "side", "confidence"]),
      sighting.equivalentDisclaimer,
      license,
      "Correct the table (re-run photo_analyze with items=...) then call photo_to_project.",
    ]
      .filter(Boolean)
      .join("\n\n");
    return ok(text, { sighting, session, path: "photo/sighting.json" });
  },
});

export const photo_to_project = defineTool({
  name: "photo_to_project",
  toolset: "core",
  title: "Draft a project from photos",
  description:
    "Continue from a corrected photo/sighting.json (or re-analyze photos) and draft a real, editable KiCad project: functional-equivalent schematic, in-stock-style parts, outline from the photo silhouette, placement that preserves front/back, then route and ERC/DRC. Never claims the draft is the original design. Writes circuit.netlist.json, board.kicad_sch, board.kicad_pcb, photo/draft.json and photo/publish.json.",
  inputSchema: {
    photos: z.array(PhotoPath).max(8).optional(),
    description: z.string().max(4000).optional(),
    items: z.array(SightedItem).optional(),
    acceptSighting: z.boolean().default(true).describe("Use the saved photo/sighting.json when present"),
    openSourceSuspected: z.boolean().optional(),
    ...ScaleHintArgs,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  longRunning: true,
  handler: async (args, ctx) => {
    let sighting = args.acceptSighting ? await loadSighting(ctx) : null;
    let session = sighting
      ? markStep(
          newPhotoSession(ctx.requireProject().id),
          "read",
          "done",
          `${sighting.items.length} items`,
          PHOTO_FILES.sighting,
        )
      : undefined;
    if (sighting && args.items) sighting = PhotoSighting.parse({ ...sighting, items: args.items });
    if (!sighting) {
      if (!args.photos?.length) {
        throw new ToolError("no sighting yet: pass photos or run photo_analyze first", "precondition");
      }
      const analyzed = await analyzePhotos(ctx, {
        photos: args.photos,
        ...(args.description ? { description: args.description } : {}),
        ...(args.items ? { items: args.items } : {}),
        ...(args.openSourceSuspected ? { openSourceSuspected: true } : {}),
        hint: {
          ...(args.knownDimensionMm ? { userDimensionMm: args.knownDimensionMm } : {}),
          ...(args.knownDimensionOf ? { userDimensionOf: args.knownDimensionOf } : {}),
          ...(args.knownPart ? { knownPart: args.knownPart } : {}),
        },
      });
      sighting = analyzed.sighting;
      session = analyzed.session;
    } else {
      ctx.services.bus.emit({ ts: Date.now(), topic: "photo.started", session: session! });
      await saveSession(ctx, session!);
    }
    const result = await continueToProject(ctx, sighting, args.description ?? "", session!);
    const text = [
      result.intent.disclaimer,
      `Picked ${result.parts.length} parts; outline ${sighting.scale.boardWidthMm}×${sighting.scale.boardHeightMm} mm.`,
      table(
        result.parts.map((p) => ({ ref: p.ref, value: p.value, footprint: p.footprint, source: p.source })),
        ["ref", "value", "footprint", "source"],
      ),
      `Route: ${String((result.draft["route"] as { routed?: number })?.routed ?? "?")} routed. ERC/DRC in photo/draft.json.`,
      "Review the draft like any other agent change. Side-by-side reference lives on the Photo board tab.",
    ].join("\n\n");
    return ok(text, { ...result, sighting });
  },
});

export const photoTools = [photo_analyze, photo_to_project];

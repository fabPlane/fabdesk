import type {
  CircuitIntent,
  NetlistFile,
  PickedPart,
  PhotoPublishMeta,
  PhotoSighting,
} from "@fabdesk/protocol";
import type { ToolContext } from "../registry";
import { PROJECT_FILES, exists, writeAtomic, writeJson } from "../fs";
import { p } from "../tools/common";
import { placementsFromSighting } from "./parts";

export async function writeNetlist(
  ctx: ToolContext,
  sighting: PhotoSighting,
  intent: CircuitIntent,
  parts: readonly PickedPart[],
): Promise<NetlistFile> {
  const byId = new Map(parts.map((part) => [part.itemId, part]));
  const components = parts.map((part) => ({
    ref: part.ref,
    value: part.value,
    footprint: part.footprint,
    ...(part.mpn ? { fields: { MPN: part.mpn } } : {}),
  }));
  const nets = intent.nets
    .map((net) => ({
      name: net.name,
      nodes: net.nodes
        .map((node) => {
          const part = byId.get(node.itemId);
          if (!part) return null;
          return { ref: part.ref, pin: node.pin ?? "1" };
        })
        .filter((n): n is { ref: string; pin: string } => n !== null),
    }))
    .filter((net) => net.nodes.length > 0);
  const file: NetlistFile = {
    netlist: { components, nets },
    board: {
      widthMm: sighting.scale.boardWidthMm,
      heightMm: sighting.scale.boardHeightMm,
      outline: sighting.outline.polygon,
      ...(sighting.mountingHoles.length
        ? {
            holes: sighting.mountingHoles.map((h) => ({
              x: h.x,
              y: h.y,
              diameterMm: h.diameterMm,
            })),
          }
        : {}),
    },
  };
  const project = ctx.requireProject();
  await writeJson(p(project, PROJECT_FILES.netlistJson), file);
  return file;
}

export async function draftSchematic(
  ctx: ToolContext,
  parts: readonly PickedPart[],
  intent: CircuitIntent,
): Promise<void> {
  const byId = new Map(parts.map((part) => [part.itemId, part]));
  const symbols = parts.map((part, i) => ({
    libId: part.symbol,
    reference: part.ref,
    value: part.value,
    footprint: part.footprint,
    position: { x: 20 + (i % 6) * 30, y: 20 + Math.floor(i / 6) * 25 },
  }));
  const connections = intent.nets
    .map((net) => ({
      name: net.name,
      label: "global" as const,
      nodes: net.nodes
        .map((node) => {
          const part = byId.get(node.itemId);
          if (!part) return null;
          return { reference: part.ref, pin: node.pin ?? "1" };
        })
        .filter((n): n is { reference: string; pin: string } => n !== null),
    }))
    .filter((c) => c.nodes.length > 0);
  const project = ctx.requireProject();
  await ctx.services.design.schematicEdit(project.dir, {
    symbols,
    connections,
    texts: [
      {
        text: "Functional equivalent drafted from a photo. Not a copy of the original design.",
        position: { x: 20, y: 8 },
      },
    ],
    save: true,
  });
  const sch = p(project, PROJECT_FILES.boardSch);
  if (!(await exists(sch))) {
    await writeAtomic(
      sch,
      [
        "(kicad_sch",
        "  (version 20250114)",
        '  (generator "fabdesk")',
        '  (generator_version "photo")',
        '  (uuid "00000000-0000-4000-8000-000000000001")',
        '  (paper "A4")',
        '  (title_block (title "Functional equivalent from photo")',
        '    (comment 1 "Not a copy of the original design."))',
        ")\n",
      ].join("\n"),
    );
  }
}

export async function draftBoard(
  ctx: ToolContext,
  sighting: PhotoSighting,
  parts: readonly PickedPart[],
): Promise<{ placements: ReturnType<typeof placementsFromSighting> }> {
  const project = ctx.requireProject();
  ctx.progress(0.35, "building board");
  await ctx.services.design.build({ projectDir: project.dir, signal: ctx.signal });
  ctx.progress(0.5, "fitting outline");
  await ctx.services.design.defineBoardOutline(project.dir, sighting.outline.polygon, true);
  const placements = placementsFromSighting(sighting, parts);
  if (placements.length) {
    ctx.progress(0.6, "placing footprints");
    await ctx.services.design.placeFootprints(
      project.dir,
      placements.map((pl) => ({
        reference: pl.ref,
        position: { x: pl.x, y: pl.y },
        rotation: pl.rotation,
        ...(pl.layer === "B" ? { flip: true } : {}),
      })),
    );
  }
  return { placements };
}

export async function writePublishMeta(
  ctx: ToolContext,
  sighting: PhotoSighting,
): Promise<PhotoPublishMeta> {
  const meta: PhotoPublishMeta = {
    startedFromPhoto: true,
    referencePhotos: sighting.photos.map((photo) => ({
      path: photo.path,
      ...(photo.side !== "unknown" ? { side: photo.side } : {}),
      alt: `${photo.side} reference photo`,
    })),
    equivalentDisclaimer: sighting.equivalentDisclaimer,
    ...(sighting.openSourceNote ? { openSourceNote: sighting.openSourceNote } : {}),
  };
  await writeJson(p(ctx.requireProject(), PROJECT_FILES.photoPublish), meta);
  return meta;
}

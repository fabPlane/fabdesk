/**
 * Generate a printable enclosure from the KiCad board (outline, mounting holes, edge connectors)
 * and keep cutouts aligned when the board changes. Works without FreeCAD; when the CAD bridge is
 * up, the same primitives are mirrored into model.FCStd.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { extractBoardFeatures } from "@fabdesk/kicad/board-features";
import {
  checkEnclosureAlignment,
  enclosureSummary,
  generateEnclosure,
  isEnclosureSpec,
  normalizeEnclosureSpec,
  meshEnclosure,
  previewEnclosureSvg,
  type AlignmentReport,
  type EnclosureParams,
  type EnclosureSpec,
  type VentFace,
  type VentPattern,
} from "@fabdesk/kicad/enclosure";
import { PROJECT_FILES, projectRelative, readJsonOrNull, writeAtomic, writeJson } from "../fs";
import { defineTool, ToolError, type ProjectHandle } from "../registry";
import type { CadService } from "../services";
import { findBoard, ok, p, requireBoard, table } from "./common";

const ENCLOSURE_NAME = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/)
  .default("enclosure")
  .describe("Output base name under exports/ and enclosure.json");

async function loadFeatures(project: ProjectHandle) {
  const board = await requireBoard(project);
  return extractBoardFeatures(await readFile(board, "utf8"));
}

async function loadSpec(project: ProjectHandle): Promise<EnclosureSpec | null> {
  const raw = await readJsonOrNull<unknown>(p(project, PROJECT_FILES.enclosure));
  return normalizeEnclosureSpec(raw) ?? (isEnclosureSpec(raw) ? raw : null);
}

function placement(x: number, y: number, z: number) {
  return { $type: "Placement", base: [x, y, z], rotation: [0, 0, 0, 1] };
}

async function applyEnclosureToCad(
  cad: CadService,
  dir: string,
  spec: EnclosureSpec,
): Promise<string[]> {
  const model = await cad.model(dir);
  const stale = model.objects.filter(
    (o) => o.name.startsWith("Enclosure") || o.label.startsWith("Enclosure"),
  );
  for (const o of stale) await cad.removeObject(dir, o.name, true);
  const group = await cad.addObject(dir, {
    type: "App::DocumentObjectGroup",
    name: "Enclosure",
    label: "Enclosure",
  });
  const created = [group.name];
  for (const solid of spec.solids) {
    const dx = solid.max.x - solid.min.x;
    const dy = solid.max.y - solid.min.y;
    const dz = solid.max.z - solid.min.z;
    if (solid.kind === "profile" && solid.profile) {
      const data = JSON.stringify({ solid, document: model.document, group: group.name });
      const result = await cad.python(
        dir,
        `import json, FreeCAD as App, Part
p=json.loads(${JSON.stringify(data)})
s=p['solid']; profile=s['profile']; axis=profile['axis']; start=s['min'][axis]
doc=App.getDocument(p['document'])
faces=[]
for ring in profile['rings']:
    pts=[App.Vector(start,u,v) if axis=='x' else App.Vector(u,start,v) for u,v in ring]
    faces.append(Part.Face(Part.makePolygon(pts+[pts[0]])))
face=faces[0]
for hole in faces[1:]: face=face.cut(hole)
depth=s['max'][axis]-start
shape=face.extrude(App.Vector(depth,0,0) if axis=='x' else App.Vector(0,depth,0))
if not shape.isValid(): raise ValueError('Invalid enclosure wall profile')
obj=doc.addObject('Part::Feature',s['name']); obj.Shape=shape
doc.getObject(p['group']).addObject(obj)
`,
        "exec",
      );
      if (result.exception) throw new Error(result.exception);
      created.push(solid.name);
      continue;
    }
    if (solid.kind === "cylinder" && solid.radiusMm) {
      const cx = (solid.min.x + solid.max.x) / 2;
      const cy = (solid.min.y + solid.max.y) / 2;
      const stand = spec.standoffs.find(
        (h) => Math.abs(h.x - cx) < 1e-6 && Math.abs(h.y - cy) < 1e-6,
      );
      const cylinder = (suffix: string, radius: number) =>
        cad.addObject(dir, {
          type: "Part::Cylinder",
          name: `${solid.name}_${suffix}`,
          label: `${solid.name}_${suffix}`,
          properties: { Radius: radius, Height: dz, Placement: placement(cx, cy, solid.min.z) },
        });
      const outer = await cylinder("Outer", solid.radiusMm);
      const bore = await cylinder("Bore", (stand?.innerDiameterMm ?? solid.radiusMm) / 2);
      const added = await cad.addObject(dir, {
        type: "Part::Cut",
        name: solid.name,
        label: solid.name,
        group: group.name,
        properties: {
          Base: { $type: "Object", doc: model.document, name: outer.name },
          Tool: { $type: "Object", doc: model.document, name: bore.name },
        },
      });
      created.push(outer.name, bore.name, added.name);
      continue;
    }
    const added = await cad.addObject(dir, {
      type: "Part::Box",
      name: solid.name,
      label: solid.name,
      group: group.name,
      properties: {
        Length: dx,
        Width: dy,
        Height: dz,
        Placement: placement(solid.min.x, solid.min.y, solid.min.z),
      },
    });
    created.push(added.name);
  }
  const recompute = await cad.recompute(dir);
  await cad.save(dir);
  if (recompute.errors.length)
    throw new Error(recompute.errors.map((e) => `${e.object}: ${e.message}`).join("; "));
  return created;
}

function filesJson(project: ProjectHandle, name: string) {
  const paths = {
    spec: p(project, PROJECT_FILES.enclosure),
    stl: p(project, PROJECT_FILES.exports, `${name}.stl`),
    lidStl: p(project, PROJECT_FILES.exports, `${name}-lid.stl`),
    step: p(project, PROJECT_FILES.exports, `${name}.step`),
    preview: p(project, PROJECT_FILES.exports, `${name}-preview.svg`),
  };
  return {
    spec: projectRelative(project.dir, paths.spec),
    stl: projectRelative(project.dir, paths.stl),
    lidStl: projectRelative(project.dir, paths.lidStl),
    step: projectRelative(project.dir, paths.step),
    preview: projectRelative(project.dir, paths.preview),
    paths,
  };
}

export const cad_enclosure = defineTool({
  name: "cad_enclosure",
  toolset: "cad",
  title: "Generate a board-synced enclosure",
  description:
    "Generate a printable two-piece enclosure from board.kicad_pcb (Edge.Cuts outline, NPTH / mounting holes, edge connectors, tall parts). v2 adds a separate outline offset, vent patterns (grid / slots / honeycomb), snap-fit clips, an SVG preview, and STL/STEP export. Cutouts and standoffs stay keyed to the board hash. Writes enclosure.json plus exports/<name>.stl, <name>-lid.stl, <name>.step and <name>-preview.svg. FreeCAD is optional — when the CAD bridge is up, the same primitives are mirrored into model.FCStd.",
  inputSchema: {
    action: z
      .enum(["generate", "preview", "status", "check"])
      .default("generate")
      .describe(
        "preview returns meshes without writing; generate writes the case; status reports sync; check compares cutouts to the current board",
      ),
    expectedBoardRevision: z
      .string()
      .optional()
      .describe("Reject apply if the board changed since preview"),
    wallMm: z.number().positive().max(20).optional(),
    clearanceMm: z.number().nonnegative().max(20).optional(),
    outlineOffsetMm: z
      .number()
      .nonnegative()
      .max(40)
      .optional()
      .describe("Extra outward offset beyond clearanceMm"),
    floorMm: z.number().positive().max(20).optional(),
    lidMm: z.number().positive().max(20).optional(),
    standoffMm: z.number().nonnegative().max(30).optional(),
    headroomMm: z.number().nonnegative().max(40).optional(),
    cutoutClearanceMm: z.number().nonnegative().max(5).optional(),
    ventPattern: z.enum(["none", "grid", "slots", "honeycomb"]).optional(),
    ventPitchMm: z.number().positive().max(30).optional(),
    ventSizeMm: z.number().positive().max(20).optional(),
    ventMarginMm: z.number().nonnegative().max(40).optional(),
    ventFaces: z.enum(["lid", "walls", "both"]).optional(),
    snapFit: z.boolean().optional().describe("Through-lid snap-fit clips on the long walls"),
    snapCount: z.number().int().min(1).max(6).optional(),
    applyToCad: z
      .boolean()
      .default(true)
      .describe("When the FabPlane CAD bridge is running, also update model.FCStd"),
    name: ENCLOSURE_NAME,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (args, ctx) => {
    const project = ctx.requireProject();
    if (args.action === "status") {
      const board = await findBoard(project);
      if (!board) {
        const spec = await loadSpec(project);
        if (!spec)
          return ok("No board.kicad_pcb yet. Add a board to generate an enclosure.", {
            exists: false,
            noBoard: true,
          });
        return ok("Enclosure exists, but this project has no board.kicad_pcb.", {
          exists: true,
          noBoard: true,
          stale: true,
        });
      }
    }
    const features = await loadFeatures(project);
    if (args.expectedBoardRevision && args.expectedBoardRevision !== features.pcbRevision)
      throw new ToolError(
        "The board changed since this preview. Preview again before applying.",
        "precondition",
      );
    if (args.action === "status" || args.action === "check") {
      const spec = await loadSpec(project);
      if (!spec) {
        if (args.action === "check")
          throw new ToolError("no enclosure.json; run cad_enclosure generate", "precondition");
        return ok(
          `No enclosure yet. Board ${features.outline.widthMm}×${features.outline.heightMm} mm, ${features.holes.length} hole(s), ${features.connectors.length} edge connector(s).`,
          {
            exists: false,
            features: summarizeFeatures(features),
          },
        );
      }
      const alignment = checkEnclosureAlignment(spec, features);
      const payload = resultPayload(project, spec, alignment, args.name, features, false);
      if (args.action === "check" && !alignment.ok)
        return ok(enclosureSummary(spec, alignment), payload, { isError: true });
      return ok(enclosureSummary(spec, alignment), payload);
    }

    const params: Partial<EnclosureParams> = {
      ...(args.wallMm !== undefined ? { wallMm: args.wallMm } : {}),
      ...(args.clearanceMm !== undefined ? { clearanceMm: args.clearanceMm } : {}),
      ...(args.outlineOffsetMm !== undefined ? { outlineOffsetMm: args.outlineOffsetMm } : {}),
      ...(args.floorMm !== undefined ? { floorMm: args.floorMm } : {}),
      ...(args.lidMm !== undefined ? { lidMm: args.lidMm } : {}),
      ...(args.standoffMm !== undefined ? { standoffMm: args.standoffMm } : {}),
      ...(args.headroomMm !== undefined ? { headroomMm: args.headroomMm } : {}),
      ...(args.cutoutClearanceMm !== undefined
        ? { cutoutClearanceMm: args.cutoutClearanceMm }
        : {}),
      ...(args.ventPattern !== undefined ? { ventPattern: args.ventPattern as VentPattern } : {}),
      ...(args.ventPitchMm !== undefined ? { ventPitchMm: args.ventPitchMm } : {}),
      ...(args.ventSizeMm !== undefined ? { ventSizeMm: args.ventSizeMm } : {}),
      ...(args.ventMarginMm !== undefined ? { ventMarginMm: args.ventMarginMm } : {}),
      ...(args.ventFaces !== undefined ? { ventFaces: args.ventFaces as VentFace } : {}),
      ...(args.snapFit !== undefined ? { snapFit: args.snapFit } : {}),
      ...(args.snapCount !== undefined ? { snapCount: args.snapCount } : {}),
    };
    const spec = generateEnclosure(features, params);
    const mesh = meshEnclosure(spec);
    const previewSvg = previewEnclosureSvg(spec);
    if (args.action === "preview") {
      return ok("Enclosure preview — not applied.", {
        ...resultPayload(
          project,
          spec,
          checkEnclosureAlignment(spec, features),
          args.name,
          features,
        ),
        previewOnly: true,
        meshes: { base: mesh.baseStl, lid: mesh.lidStl },
      });
    }
    const files = filesJson(project, args.name);
    await writeJson(files.paths.spec, spec);
    await writeAtomic(files.paths.stl, mesh.baseStl);
    await writeAtomic(files.paths.lidStl, mesh.lidStl);
    await writeAtomic(files.paths.step, mesh.step);
    await writeAtomic(files.paths.preview, previewSvg);
    const alignment = checkEnclosureAlignment(spec, features);
    let appliedToCad = false;
    let cadObjects: string[] = [];
    let cadError: string | undefined;
    if (args.applyToCad && ctx.services.cad) {
      try {
        cadObjects = await applyEnclosureToCad(ctx.services.cad, project.dir, spec);
        appliedToCad = true;
      } catch (e) {
        cadError = e instanceof Error ? e.message : String(e);
      }
    }
    const payload = {
      ...resultPayload(project, spec, alignment, args.name, features, true),
      generated: true,
      appliedToCad,
      cadObjects,
      ...(cadError ? { cadError } : {}),
    };
    const extra = appliedToCad
      ? " Mirrored primitives into model.FCStd."
      : ctx.services.cad
        ? cadError
          ? ` FreeCAD update failed: ${cadError}`
          : ""
        : " FreeCAD not running; STL/STEP are still printable.";
    return ok(`${enclosureSummary(spec, alignment)}${extra}\n${fileTable(payload)}`, payload);
  },
});

function summarizeFeatures(features: Awaited<ReturnType<typeof loadFeatures>>) {
  return {
    pcbRevision: features.pcbRevision,
    outlineMm: { width: features.outline.widthMm, height: features.outline.heightMm },
    geometry: {
      outline: features.outline,
      holes: features.holes,
      parts: [...features.tallParts, ...features.connectors],
      connectors: features.connectors,
    },
    thicknessMm: features.thicknessMm,
    holes: features.holes.length,
    connectors: features.connectors.map((c) => ({ ref: c.ref, edge: c.edge, x: c.x, y: c.y })),
    tallParts: features.tallParts.slice(0, 8).map((p) => ({ ref: p.ref, heightMm: p.heightMm })),
    warnings: features.warnings,
  };
}

function resultPayload(
  project: ProjectHandle,
  spec: EnclosureSpec,
  alignment: AlignmentReport,
  name: string,
  features: Awaited<ReturnType<typeof loadFeatures>>,
  includePreviewSvg = false,
) {
  const files = filesJson(project, name);
  return {
    exists: true,
    spec: files.spec,
    stl: files.stl,
    lidStl: files.lidStl,
    step: files.step,
    preview: files.preview,
    ...(includePreviewSvg ? { previewSvg: previewEnclosureSvg(spec) } : {}),
    pcbRevision: spec.pcbRevision,
    alignment,
    board: summarizeFeatures(features),
    params: spec.params,
    cutouts: spec.cutouts,
    standoffs: spec.standoffs.length,
    vents: (spec.vents ?? []).length,
    clips: (spec.clips ?? []).length,
    outerMm: {
      width: spec.outer.maxX - spec.outer.minX,
      depth: spec.outer.maxY - spec.outer.minY,
      height: spec.outer.z1,
    },
    warnings: spec.warnings,
  };
}

function fileTable(payload: {
  spec: string;
  stl: string;
  lidStl: string;
  step: string;
  preview: string;
}): string {
  return table([
    { file: payload.spec, what: "parametric spec keyed to the board hash" },
    { file: payload.stl, what: "printable base (walls, floor, standoffs, clips)" },
    { file: payload.lidStl, what: "printable lid (vents and snap slots)" },
    { file: payload.step, what: "STEP assembly of the same solids, standoffs bored" },
    { file: payload.preview, what: "SVG plan + isometric preview" },
  ]);
}

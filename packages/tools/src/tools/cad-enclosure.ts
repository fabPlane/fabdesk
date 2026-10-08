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
  meshEnclosure,
  type AlignmentReport,
  type EnclosureParams,
  type EnclosureSpec,
} from "@fabdesk/kicad/enclosure";
import { PROJECT_FILES, projectRelative, readJsonOrNull, writeAtomic, writeJson } from "../fs";
import { defineTool, ToolError, type ProjectHandle } from "../registry";
import type { CadService } from "../services";
import { ok, p, requireBoard, table } from "./common";

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
  return isEnclosureSpec(raw) ? raw : null;
}

function placement(x: number, y: number, z: number) {
  return { $type: "Placement", base: [x, y, z], rotation: [0, 0, 0, 1] };
}

async function applyEnclosureToCad(cad: CadService, dir: string, spec: EnclosureSpec): Promise<string[]> {
  const model = await cad.model(dir);
  const stale = model.objects.filter((o) => o.name.startsWith("Enclosure") || o.label.startsWith("Enclosure"));
  for (const o of stale) await cad.removeObject(dir, o.name, true);
  const group = await cad.addObject(dir, { type: "App::DocumentObjectGroup", name: "Enclosure", label: "Enclosure" });
  const created = [group.name];
  for (const solid of spec.solids) {
    const dx = solid.max.x - solid.min.x;
    const dy = solid.max.y - solid.min.y;
    const dz = solid.max.z - solid.min.z;
    if (solid.kind === "cylinder" && solid.radiusMm) {
      const added = await cad.addObject(dir, {
        type: "Part::Cylinder",
        name: solid.name,
        label: solid.name,
        group: group.name,
        properties: {
          Radius: solid.radiusMm,
          Height: dz,
          Placement: placement((solid.min.x + solid.max.x) / 2, (solid.min.y + solid.max.y) / 2, solid.min.z),
        },
      });
      created.push(added.name);
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
  };
  return {
    spec: projectRelative(project.dir, paths.spec),
    stl: projectRelative(project.dir, paths.stl),
    lidStl: projectRelative(project.dir, paths.lidStl),
    step: projectRelative(project.dir, paths.step),
    paths,
  };
}

export const cad_enclosure = defineTool({
  name: "cad_enclosure",
  toolset: "cad",
  title: "Generate a board-synced enclosure",
  description:
    "Generate a printable two-piece enclosure from board.kicad_pcb (Edge.Cuts outline, NPTH / mounting holes, edge connectors, tall parts). Cutouts and standoffs stay keyed to the board hash: regenerate after a board change and run the alignment check. Writes enclosure.json plus exports/<name>.stl, <name>-lid.stl and <name>.step. FreeCAD is optional — when the CAD bridge is up, the same primitives are mirrored into model.FCStd.",
  inputSchema: {
    action: z
      .enum(["generate", "status", "check"])
      .default("generate")
      .describe("generate writes the case; status reports sync; check compares cutouts to the current board"),
    wallMm: z.number().positive().max(20).optional(),
    clearanceMm: z.number().nonnegative().max(20).optional(),
    floorMm: z.number().positive().max(20).optional(),
    lidMm: z.number().positive().max(20).optional(),
    standoffMm: z.number().nonnegative().max(30).optional(),
    headroomMm: z.number().nonnegative().max(40).optional(),
    cutoutClearanceMm: z.number().nonnegative().max(5).optional(),
    applyToCad: z
      .boolean()
      .default(true)
      .describe("When the FabPlane CAD bridge is running, also update model.FCStd"),
    name: ENCLOSURE_NAME,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    const project = ctx.requireProject();
    const features = await loadFeatures(project);
    if (args.action === "status" || args.action === "check") {
      const spec = await loadSpec(project);
      if (!spec) {
        if (args.action === "check") throw new ToolError("no enclosure.json; run cad_enclosure generate", "precondition");
        return ok(
          `No enclosure yet. Board ${features.outline.widthMm}×${features.outline.heightMm} mm, ${features.holes.length} hole(s), ${features.connectors.length} edge connector(s).`,
          {
            exists: false,
            features: summarizeFeatures(features),
          },
        );
      }
      const alignment = checkEnclosureAlignment(spec, features);
      const payload = resultPayload(project, spec, alignment, args.name, features);
      if (args.action === "check" && !alignment.ok)
        return ok(enclosureSummary(spec, alignment), payload, { isError: true });
      return ok(enclosureSummary(spec, alignment), payload);
    }

    const params: Partial<EnclosureParams> = {
      ...(args.wallMm !== undefined ? { wallMm: args.wallMm } : {}),
      ...(args.clearanceMm !== undefined ? { clearanceMm: args.clearanceMm } : {}),
      ...(args.floorMm !== undefined ? { floorMm: args.floorMm } : {}),
      ...(args.lidMm !== undefined ? { lidMm: args.lidMm } : {}),
      ...(args.standoffMm !== undefined ? { standoffMm: args.standoffMm } : {}),
      ...(args.headroomMm !== undefined ? { headroomMm: args.headroomMm } : {}),
      ...(args.cutoutClearanceMm !== undefined ? { cutoutClearanceMm: args.cutoutClearanceMm } : {}),
    };
    const spec = generateEnclosure(features, params);
    const mesh = meshEnclosure(spec);
    const files = filesJson(project, args.name);
    await writeJson(files.paths.spec, spec);
    await writeAtomic(files.paths.stl, mesh.baseStl);
    await writeAtomic(files.paths.lidStl, mesh.lidStl);
    await writeAtomic(files.paths.step, mesh.step);
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
      ...resultPayload(project, spec, alignment, args.name, features),
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
    outlineMm: { width: features.outline.widthMm, height: features.outline.heightMm },
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
) {
  const files = filesJson(project, name);
  return {
    exists: true,
    spec: files.spec,
    stl: files.stl,
    lidStl: files.lidStl,
    step: files.step,
    pcbRevision: spec.pcbRevision,
    alignment,
    board: summarizeFeatures(features),
    cutouts: spec.cutouts,
    standoffs: spec.standoffs.length,
    outerMm: {
      width: spec.outer.maxX - spec.outer.minX,
      depth: spec.outer.maxY - spec.outer.minY,
      height: spec.outer.z1,
    },
    warnings: spec.warnings,
  };
}

function fileTable(payload: { spec: string; stl: string; lidStl: string; step: string }): string {
  return table([
    { file: payload.spec, what: "parametric spec keyed to the board hash" },
    { file: payload.stl, what: "printable base (walls, floor, standoffs)" },
    { file: payload.lidStl, what: "printable lid" },
    { file: payload.step, what: "STEP assembly of the same boxes" },
  ]);
}


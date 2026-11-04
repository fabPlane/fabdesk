import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rm, stat } from "node:fs/promises";
import { join, extname, isAbsolute } from "node:path";
import { z } from "zod/v4";
import { zipSync, strToU8 } from "fflate";
import {
  MechanicalDesignSchema,
  MECHANICAL_DESIGN_PATH,
  openingContour,
  type MechanicalDesign,
  type MechanicalFitReport,
} from "@fabdesk/protocol";
import { extractBoardFeatures } from "@fabdesk/kicad/board-features";
import {
  checkMechanicalFit,
  enclosureFromDesign,
  boardVolumes,
  boxesOverlap,
  type FitBoard,
} from "@fabdesk/kicad/mechanical-fit";
import { joinedEnclosure, auditStl, enclosureFitSamples } from "@fabdesk/kicad/enclosure-solid";
import { readStlTriangles, ShellSurface, withShellSurfaceReview } from "@fabdesk/kicad/shell-fit";
import { defineTool, ToolError, type ToolContext } from "../registry";
import { jailPath, readJsonIfPresent, writeAtomic, writeJson } from "../fs";
import { ok } from "./common";
import { native_edit_transaction } from "./native-edit";
import { detailedEnclosureFit } from "./enclosure-detailed-fit";
import { bundleEnclosureModels } from "./enclosure-model-bundle";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const MAX_MODEL_PREVIEW_BYTES = 50 * 1024 * 1024;

/** Tessellate a copy in its own bridge session, without opening or saving the project's model. */
async function modelPreview(ctx: ToolContext, sourcePath: string | undefined) {
  if (!sourcePath || isAbsolute(sourcePath) || !/\.(step|stp)$/i.test(sourcePath))
    throw new ToolError("Choose a project-relative STEP (.step or .stp) file.", "invalid_args");
  const dir = ctx.requireProject().dir;
  const source = await jailPath(dir, sourcePath);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new ToolError("The STEP file could not be found.", "not_found");
  if (info.size > MAX_MODEL_PREVIEW_BYTES)
    throw new ToolError("STEP imports are limited to 50 MB.", "invalid_args");
  const cad = ctx.services.cad;
  if (
    !cad ||
    !(await cad
      .status()
      .then((s) => s.reachable)
      .catch(() => false))
  )
    throw new ToolError(
      "Viewing STEP files requires the FreeCAD bridge. Connect FreeCAD in Settings → CAD, or import an STL, OBJ or GLB file.",
      "unavailable",
    );
  const bytes = await readFile(source);
  if (bytes.length > MAX_MODEL_PREVIEW_BYTES)
    throw new ToolError("STEP imports are limited to 50 MB.", "invalid_args");
  const scratch = await jailPath(dir, `.fabdesk/model-preview/${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    const input = join(scratch, "source.step"),
      output = join(scratch, "preview.stl");
    await writeAtomic(input, bytes);
    const plan = JSON.stringify({ input, output, maxBytes: MAX_MODEL_PREVIEW_BYTES });
    const result = await cad.python(
      scratch,
      `import json, os
import Part, MeshPart
p = json.loads(${JSON.stringify(plan)})
# Part.read returns a standalone shape; no project document objects are added or changed.
shape = Part.read(p['input'])
if shape.isNull() or len(shape.Faces) == 0: raise ValueError('The STEP file contains no surfaces to display.')
mesh = MeshPart.meshFromShape(Shape=shape, LinearDeflection=0.1, AngularDeflection=0.2, Relative=False)
if mesh.CountFacets == 0: raise ValueError('The STEP file produced no visible triangles.')
if 84 + mesh.CountFacets * 50 > p['maxBytes']: raise ValueError('The STEP preview exceeds 50 MB. Simplify the model before importing it.')
mesh.write(p['output'], 'STL')
if os.path.getsize(p['output']) > p['maxBytes']: raise ValueError('The STEP preview exceeds 50 MB.')
`,
      "exec",
    );
    if (result.exception)
      throw new ToolError(`STEP preview failed: ${result.exception}`, "precondition");
    const meshInfo = await stat(output).catch(() => null);
    if (!meshInfo?.isFile())
      throw new ToolError("FreeCAD did not produce a STEP preview.", "precondition");
    if (meshInfo.size > MAX_MODEL_PREVIEW_BYTES)
      throw new ToolError("The STEP preview exceeds 50 MB. Simplify the model.", "precondition");
    const mesh = await readFile(output);
    // Mesh.write(..., 'STL') produces binary STL. Check its bounds and coordinates, not
    // watertightness: open shells are legitimate imports for viewing and measurement.
    const count = mesh.length >= 84 ? mesh.readUInt32LE(80) : 0;
    if (!count || mesh.length > MAX_MODEL_PREVIEW_BYTES || 84 + count * 50 !== mesh.length)
      throw new ToolError("FreeCAD produced an unreadable STEP preview.", "precondition");
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 12; j++) {
        const value = mesh.readFloatLE(84 + i * 50 + j * 4);
        if (!Number.isFinite(value) || Math.abs(value) > 1e9)
          throw new ToolError("The STEP preview contains invalid coordinates.", "precondition");
      }
    }
    return ok("STEP model preview", { mesh: mesh.toString("base64"), format: "stl" });
  } finally {
    // Releasing before deleting is required on Windows, where the session owns model.FCStd.
    await cad.release(scratch).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}
// Repeated placement checks reuse the parsed surface; bound retained mesh memory.
const shellSurfaces = new Map<string, ShellSurface>();
function reviewSurface(
  report: MechanicalFitReport,
  design: MechanicalDesign,
  boards: FitBoard[],
  bytes: Uint8Array,
  transform?: NonNullable<MechanicalDesign["source"]>,
) {
  try {
    const key = sha(bytes) + JSON.stringify(transform ?? null);
    let surface = shellSurfaces.get(key);
    if (!surface) {
      surface = new ShellSurface(readStlTriangles(bytes), transform);
      shellSurfaces.set(key, surface);
      while (shellSurfaces.size > 2) shellSurfaces.delete(shellSurfaces.keys().next().value!);
    }
    return withShellSurfaceReview(report, design, boards, surface);
  } catch (error) {
    return {
      ...report,
      issues: [
        ...report.issues.filter((i) => i.code !== "import-coverage"),
        {
          code: "import-coverage",
          severity: "review" as const,
          message: `STL surface checks unavailable: ${error instanceof Error ? error.message : "Could not read the surface."}`,
        },
      ],
    };
  }
}
const coordinate = z.number().finite().min(-10000).max(10000);
const point = z.object({ x: coordinate, y: coordinate });
const editSchema = z.object({
  outline: z.array(point).min(3).max(100).optional(),
  footprints: z
    .array(
      z.object({
        reference: z.string().min(1),
        position: point,
        rotation: z.number().finite().optional(),
      }),
    )
    .max(500)
    .optional(),
  holes: z
    .array(point.extend({ diameter: z.number().min(0.5).max(20) }))
    .max(100)
    .optional(),
});
// Serialize this workflow's mutations; native edits retain the PCB bridge's own revision checks.
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
async function snapshot(dir: string, design: MechanicalDesign) {
  const boards: FitBoard[] = [],
    files: Record<string, Uint8Array> = {};
  for (const placement of design.boards) {
    if (!placement.path.endsWith(".kicad_pcb"))
      throw new ToolError("Choose a .kicad_pcb file", "invalid_args");
    const bytes = await readFile(await jailPath(dir, placement.path));
    files[placement.path] = bytes;
    boards.push({ placement, features: extractBoardFeatures(bytes.toString("utf8")) });
  }
  const modelBundle = await bundleEnclosureModels(dir, files);
  let sourceHash: string | null = null;
  let report = checkMechanicalFit(design, boards);
  if (design.mode === "imported" && design.source) {
    const bytes = await readFile(await jailPath(dir, design.source.path));
    if (bytes.length > 50 * 1024 * 1024)
      throw new ToolError("Enclosure imports are limited to 50 MB", "invalid_args");
    sourceHash = sha(bytes);
    if (extname(design.source.path).toLowerCase() === ".stl")
      report = reviewSurface(report, design, boards, bytes, design.source);
  }
  return {
    boards,
    files,
    modelBundle,
    report,
    sourceRevision: sourceHash,
    revision: sha(
      JSON.stringify({
        design,
        boards: report.boardRevisions,
        sourceHash,
        models: modelBundle.revision,
      }),
    ),
  };
}

/** Trusted numeric plan + jailed paths, never user-authored Python. Original shell is preserved. */
export function importedShellScript(
  design: MechanicalDesign,
  input: string,
  output: string,
): string {
  const data = JSON.stringify({
    design,
    input,
    output,
    contours: design.openings.map((o) => openingContour(o.width, o.height, o.shape)),
  });
  return `import json, math, os
import FreeCAD as App, Part, Mesh
p = json.loads(${JSON.stringify(data)})
d = p['design']; s = d['space']; src = d['source']
if p['input'].lower().endswith('.stl'):
    m = Mesh.Mesh(p['input'])
    if not m.isSolid(): raise ValueError('The STL must be closed and watertight. Repair the mesh first.')
    shell = Part.Shape(); shell.makeShapeFromMesh(m.Topology, 0.01)
    shape = Part.makeSolid(shell)
else:
    shape = Part.read(p['input'])
if not shape.isValid() or len(shape.Solids) == 0: raise ValueError('Import a valid solid enclosure.')
matrix = App.Matrix(); matrix.scale(src['scale'], src['scale'], src['scale'])
shape = shape.transformGeometry(matrix)
# Match the viewer's XYZ Euler convention (Rz first, then Ry, then Rx).
for axis, angle in [((0,0,1),src['rotation'][2]),((0,1,0),src['rotation'][1]),((1,0,0),src['rotation'][0])]:
    shape.rotate(App.Vector(0,0,0),App.Vector(*axis),angle)
shape.translate(App.Vector(*src['position']))
b = shape.BoundBox
if s['x']-s['wall'] < b.XMin-0.01 or s['x']+s['width']+s['wall'] > b.XMax+0.01 or s['y']-s['wall'] < b.YMin-0.01 or s['y']+s['depth']+s['wall'] > b.YMax+0.01 or s['floor'] < b.ZMin or s['floor']+s['height'] > b.ZMax+0.01:
    raise ValueError('The requested interior exceeds the imported case. Resize the case or reduce the interior first.')
def box(x,y,z,w,h,t): return Part.makeBox(w,h,t,App.Vector(x,y,z))
# Carve usable space while retaining material in protected obstacle volumes.
cavity = box(s['x'],s['y'],s['floor'],s['width'],s['depth'],s['height'])
for o in d['obstacles']:
    cavity = cavity.cut(box(o['x'],o['y'],o['z'],o['width'],o['depth'],o['height']))
shape = shape.cut(cavity)
for m in d['mounts']:
    base = App.Vector(m['x'],m['y'],s['floor']-0.01)
    stand = Part.makeCylinder(m['outer']/2,m['height']+0.01,base).cut(Part.makeCylinder(m['diameter']/2,m['height']+0.02,base))
    shape = shape.fuse(stand)
for o, contour in zip(d['openings'],p['contours']):
    w = o['wall']
    if w in ['minX','maxX']:
        x = b.XMin-1 if w == 'minX' else s['x']+s['width']-1
        t = s['x']-b.XMin+2 if w == 'minX' else b.XMax-s['x']-s['width']+2
        pts = [App.Vector(x,o['offset']+u,o['z']+o['height']/2+v) for u,v in contour]
        direction = App.Vector(t,0,0)
    else:
        y = b.YMin-1 if w == 'minY' else s['y']+s['depth']-1
        t = s['y']-b.YMin+2 if w == 'minY' else b.YMax-s['y']-s['depth']+2
        pts = [App.Vector(o['offset']+u,y,o['z']+o['height']/2+v) for u,v in contour]
        direction = App.Vector(0,t,0)
    cutter = Part.Face(Part.makePolygon(pts+[pts[0]])).extrude(direction)
    shape = shape.cut(cutter)
shape = shape.removeSplitter()
if not shape.isValid() or shape.Volume <= 0: raise ValueError('The modified case is not a valid solid. Original file preserved.')
shape.exportStl(os.path.join(p['output'],'case.stl'))
shape.exportStep(os.path.join(p['output'],'case.step'))
print('Enclosure modification complete')`;
}
async function meshes(ctx: ToolContext, design: MechanicalDesign, boards: FitBoard[]) {
  if (design.mode === "generated") {
    const spec = enclosureFromDesign(design, boards);
    const result = await joinedEnclosure(spec);
    return {
      base: strToU8(result.baseStl),
      lid: strToU8(result.lidStl),
      step: strToU8(result.step),
      validation: result.validation,
      lidPrint: strToU8(result.lidPrintStl),
    };
  }
  const dir = ctx.requireProject().dir,
    cad = ctx.services.cad;
  if (!cad || !(await cad.status()).reachable)
    throw new ToolError(
      "Modifying an imported enclosure requires the FreeCAD bridge. Connect FreeCAD in Settings → CAD, or choose New enclosure to generate one locally.",
      "unavailable",
    );
  const source = design.source!;
  if (![".stl", ".step", ".stp"].includes(extname(source.path).toLowerCase()))
    throw new ToolError(
      "Case editing supports closed STL or solid STEP files. Export this model as STL or STEP first.",
      "invalid_args",
    );
  const output = await jailPath(dir, `.fabdesk/case-preview/${randomUUID()}`);
  await mkdir(output, { recursive: true });
  try {
    const result = await cad.python(
      dir,
      importedShellScript(design, await jailPath(dir, source.path), output),
      "exec",
    );
    if (result.exception) throw new ToolError(result.exception, "precondition");
    const base = new Uint8Array(await readFile(join(output, "case.stl")));
    const checked = await auditStl(base);
    return {
      base,
      lid: null,
      step: new Uint8Array(await readFile(join(output, "case.step"))),
      validation: {
        engine: "manifold-3d 3.5.4",
        base: checked,
        lid: null,
        physicalFitVerified: false,
      },
      lidPrint: null,
    };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

export const cad_fit = defineTool({
  name: "cad_fit",
  toolset: "cad",
  title: "Design enclosure space and edit PCB fit",
  description:
    "Save confirmed interior dimensions, board placements, obstacles, mounts and openings; check conservative clearance envelopes; preview/build a case; apply native PCB outline, mounting-hole and component edits; export a revision-matched design ZIP. model_preview displays a project-relative STEP sourcePath using an isolated FreeCAD session, without changing the original or project CAD model. Imported STL/STEP modification uses FreeCAD and preserves the original. Fit checks are not a fabrication certification.",
  inputSchema: {
    action: z.enum([
      "status",
      "model_preview",
      "save",
      "check",
      "preview_shape",
      "preview",
      "build",
      "edit_board",
      "export",
    ]),
    design: MechanicalDesignSchema.optional(),
    sourcePath: z.string().min(1).max(4096).optional(),
    expectedRevision: z.string().length(64).optional(),
    expectedDesignRevision: z.string().length(64).nullable().optional(),
    expectedPcbRevision: z.string().length(64).optional(),
    edit: editSchema.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) =>
    locked(ctx.requireProject().dir, async () => {
      const dir = ctx.requireProject().dir;
      if (args.action === "model_preview") return modelPreview(ctx, args.sourcePath);
      const designPath = await jailPath(dir, MECHANICAL_DESIGN_PATH);
      const saved = await readJsonIfPresent<unknown>(designPath);
      const designRevision = saved === null ? null : sha(JSON.stringify(saved));
      if (args.action === "status") {
        const pcb = await readFile(await jailPath(dir, "board.kicad_pcb"), "utf8").catch(
          () => null,
        );
        const pcbReady = await ctx.services.design
          .status()
          .then((s) => s.ok)
          .catch(() => false);
        const cadReady = ctx.services.cad
          ? await ctx.services.cad
              .status()
              .then((s) => s.reachable)
              .catch(() => false)
          : false;
        return ok("Enclosure design", {
          design: saved,
          designRevision,
          capabilities: { pcb: pcbReady, cad: cadReady },
          board: pcb ? extractBoardFeatures(pcb) : null,
        });
      }
      const design = MechanicalDesignSchema.parse(args.design ?? saved);
      if (args.action === "save") {
        if (
          args.expectedDesignRevision === undefined ||
          args.expectedDesignRevision !== designRevision
        )
          throw new ToolError(
            "The enclosure settings changed. Reload before saving.",
            "precondition",
          );
        await writeJson(designPath, design);
        return ok("Enclosure settings saved", {
          design,
          designRevision: sha(JSON.stringify(design)),
        });
      }
      const snap = await snapshot(dir, design);
      if (args.action === "check")
        return ok("Fit review", {
          sourceRevision: snap.sourceRevision,
          report: snap.report,
          revision: snap.revision,
          boards: snap.boards,
        });
      if (args.action === "edit_board") {
        if (!design.confirmed)
          throw new ToolError(
            "Confirm interior dimensions before editing the PCB.",
            "precondition",
          );
        if (!args.edit || !args.expectedPcbRevision)
          throw new ToolError("Review the current PCB before applying edits.", "precondition");
        // Only the canonical PCB is edited. Other imported boards remain unmodified.
        const b = snap.boards.find((b) => b.placement.path === "board.kicad_pcb");
        if (!b || b.features.pcbRevision !== args.expectedPcbRevision)
          throw new ToolError("PCB changed. Reload and review your edit.", "precondition");
        const edit = args.edit;
        if (
          [!!edit.outline, !!edit.footprints?.length, !!edit.holes?.length].filter(Boolean).length >
          1
        )
          throw new ToolError(
            "Apply outline, component and hole changes separately so each edit checks the current PCB.",
            "invalid_args",
          );
        const assertVolumesFit = (planned: FitBoard["features"], names: Set<string>) => {
          const candidateBoard = { placement: b.placement, features: planned };
          const candidate = checkMechanicalFit(design, [candidateBoard]);
          const conflicts = candidate.issues.filter(
            (i) => i.severity === "error" && i.regions?.some((r) => names.has(r.name)),
          );
          if (conflicts.length)
            throw new ToolError(conflicts.map((i) => i.message).join("\n"), "precondition");
          const editedVolumes = boardVolumes(candidateBoard).filter((v) => names.has(v.name));
          for (const other of snap.boards) {
            if (other.placement.path === b.placement.path) continue;
            if (
              editedVolumes.some((a) =>
                boardVolumes(other).some((c) =>
                  boxesOverlap(a, c, design.space.clearance + 2 * (design.fitAllowance ?? 0)),
                ),
              )
            )
              throw new ToolError(
                `The edit would overlap ${other.placement.path} or its required clearance. Adjust the board placements first.`,
                "precondition",
              );
          }
        };
        if (edit.footprints?.length) {
          const planned = structuredClone(b.features);
          for (const move of edit.footprints) {
            const part = planned.components?.find((p) => p.ref === move.reference);
            if (!part) throw new ToolError(`Unknown component: ${move.reference}`, "invalid_args");
            if (move.rotation !== undefined)
              throw new ToolError(
                "Use native PCB rotation tools to rotate components; this control changes their position only.",
                "invalid_args",
              );
            const dx = move.position.x - part.x,
              dy = move.position.y - part.y;
            part.x += dx;
            part.y += dy;
            part.bounds = {
              minX: part.bounds.minX + dx,
              maxX: part.bounds.maxX + dx,
              minY: part.bounds.minY + dy,
              maxY: part.bounds.maxY + dy,
            };
            const outline = planned.outline;
            if (
              part.x < outline.minX ||
              part.x > outline.maxX ||
              part.y < outline.minY ||
              part.y > outline.maxY
            )
              throw new ToolError(
                `${move.reference} would move outside the PCB bounds. Use the PCB editor to review intentional overhangs.`,
                "precondition",
              );
          }
          const moved = new Set(edit.footprints.map((p) => p.reference));
          const parts = boardVolumes({ placement: b.placement, features: planned }).slice(1);
          for (const part of parts.filter((p) => moved.has(p.name)))
            if (parts.some((other) => other !== part && boxesOverlap(part, other)))
              throw new ToolError(
                `${part.name} would overlap another component envelope. Choose a clear position or review the real shapes in the PCB editor.`,
                "precondition",
              );
          assertVolumesFit(planned, moved);
        }
        if (!edit.outline && !edit.footprints?.length && !edit.holes?.length)
          throw new ToolError("Choose an outline, component or hole edit first.", "invalid_args");
        const holes = edit.holes ?? [];
        if (
          holes.length &&
          (!b.features.outline.closed ||
            b.features.warnings.some((w) => w.startsWith("Non-rectangular Edge.Cuts")))
        )
          throw new ToolError(
            "Use Advanced PCB editing to add holes to an open or non-rectangular outline. Its rectangular preview cannot prove that a hole is inside the board.",
            "precondition",
          );
        for (const [index, h] of holes.entries()) {
          if (
            holes
              .slice(0, index)
              .some((p) => Math.hypot(p.x - h.x, p.y - h.y) < (p.diameter + h.diameter) / 2)
          )
            throw new ToolError("The requested mounting holes overlap each other.", "invalid_args");
          const o = b.features.outline,
            r = h.diameter / 2;
          if (h.x - r <= o.minX || h.x + r >= o.maxX || h.y - r <= o.minY || h.y + r >= o.maxY)
            throw new ToolError(
              "The hole must be completely inside the current PCB outline.",
              "invalid_args",
            );
          if (
            b.features.holes.some(
              (p) => Math.hypot(p.x - h.x, p.y - h.y) < (p.diameterMm + h.diameter) / 2,
            )
          )
            throw new ToolError("The new hole overlaps an existing hole.", "invalid_args");
          if (
            b.features.components?.some(
              (p) =>
                h.x + r > p.bounds.minX &&
                h.x - r < p.bounds.maxX &&
                h.y + r > p.bounds.minY &&
                h.y - r < p.bounds.maxY,
            )
          )
            throw new ToolError(
              "The hole overlaps a component envelope. Move it to a clear area.",
              "invalid_args",
            );
        }
        let deleteItemIds: string[] = [];
        if (edit.outline) {
          const o = {
            minX: Math.min(...edit.outline.map((p) => p.x)),
            minY: Math.min(...edit.outline.map((p) => p.y)),
            maxX: Math.max(...edit.outline.map((p) => p.x)),
            maxY: Math.max(...edit.outline.map((p) => p.y)),
          };
          // This UI edits rectangular boundaries; reject ambiguous polygons and internal contours.
          if (
            edit.outline.length !== 4 ||
            new Set(edit.outline.map((p) => `${p.x},${p.y}`)).size !== 4 ||
            edit.outline.some((p, i) => {
              const q = edit.outline![(i + 1) % 4]!;
              return p.x !== q.x && p.y !== q.y;
            }) ||
            edit.outline.some(
              (p) => ![o.minX, o.maxX].includes(p.x) || ![o.minY, o.maxY].includes(p.y),
            ) ||
            o.maxX <= o.minX ||
            o.maxY <= o.minY
          )
            throw new ToolError(
              "Outline sizing requires a positive rectangular boundary.",
              "invalid_args",
            );
          if (
            b.features.components?.some(
              (p) =>
                p.bounds.minX < o.minX ||
                p.bounds.maxX > o.maxX ||
                p.bounds.minY < o.minY ||
                p.bounds.maxY > o.maxY,
            )
          )
            throw new ToolError(
              "The new outline would cut through a component. Reposition components first.",
              "precondition",
            );
          if (
            b.features.holes.some(
              (h) =>
                h.x - h.diameterMm / 2 <= o.minX ||
                h.x + h.diameterMm / 2 >= o.maxX ||
                h.y - h.diameterMm / 2 <= o.minY ||
                h.y + h.diameterMm / 2 >= o.maxY,
            )
          )
            throw new ToolError(
              "The new outline would cut through an existing mounting hole. Reposition it in the PCB editor first.",
              "precondition",
            );
          assertVolumesFit(
            {
              ...b.features,
              outline: {
                ...b.features.outline,
                ...o,
                widthMm: o.maxX - o.minX,
                heightMm: o.maxY - o.minY,
                closed: true,
              },
            },
            new Set(["PCB"]),
          );
          const geometry = await ctx.services.design.inspectBoardGeometry(dir);
          if (!geometry.revisionStable)
            throw new ToolError("PCB is changing. Try again after it is saved.", "precondition");
          const edges = geometry.graphics.filter(
            (g) => g["layer"] === 47 || g["layer"] === "Edge.Cuts",
          );
          const boundary = edges.filter((g) => g["kind"] !== "circle");
          if (!boundary.length)
            throw new ToolError(
              "The PCB bridge did not return the current outline. Reload the board before replacing it.",
              "precondition",
            );
          if (
            boundary.some(
              (g) =>
                !["segment", "rectangle"].includes(String(g["kind"])) ||
                typeof g["id"] !== "string",
            )
          )
            throw new ToolError(
              "This outline needs Advanced PCB editing; its boundary could not be identified safely.",
              "precondition",
            );
          // Interior non-circular cutouts must not silently disappear when the outer boundary changes.
          const old = b.features.outline;
          const inside = (p: unknown) => {
            const q = p as { x?: number; y?: number } | undefined;
            return (
              q &&
              typeof q.x === "number" &&
              typeof q.y === "number" &&
              q.x > old.minX + 0.01 &&
              q.x < old.maxX - 0.01 &&
              q.y > old.minY + 0.01 &&
              q.y < old.maxY - 0.01
            );
          };
          if (boundary.some((g) => inside(g["start"]) && inside(g["end"])))
            throw new ToolError(
              "An internal cutout or curved boundary needs Advanced PCB editing. No geometry was changed.",
              "precondition",
            );
          deleteItemIds = boundary.map((g) => String(g["id"]));
        }
        const graphics = [
          ...(edit.holes?.map((h) => ({
            kind: "circle" as const,
            layer: "Edge.Cuts",
            center: { x: h.x, y: h.y },
            radiusPoint: { x: h.x + h.diameter / 2, y: h.y },
            strokeWidth: 0.05,
            filled: false,
          })) ?? []),
          ...(edit.outline
            ? edit.outline.map((p, i) => ({
                kind: "segment" as const,
                layer: "Edge.Cuts",
                start: p,
                end: edit.outline![(i + 1) % edit.outline!.length]!,
                strokeWidth: 0.05,
              }))
            : []),
        ];
        return native_edit_transaction.handler(
          {
            mode: "apply",
            expectedPcbRevision: args.expectedPcbRevision,
            ...(edit.footprints ? { footprints: edit.footprints } : {}),
            ...(graphics.length
              ? { geometry: { graphics, ...(deleteItemIds.length ? { deleteItemIds } : {}) } }
              : {}),
          },
          ctx,
        );
      }
      if (!design.confirmed)
        throw new ToolError("Confirm dimensions and units first.", "precondition");
      const previewing = args.action === "preview" || args.action === "preview_shape";
      const verificationPending = args.action === "preview_shape";
      if (verificationPending && design.mode !== "generated")
        throw new ToolError("Fast shape previews support generated cases only.", "invalid_args");
      if (!previewing && (!args.expectedRevision || args.expectedRevision !== snap.revision))
        throw new ToolError(
          "Design or PCB changed. Preview again before applying or exporting.",
          "precondition",
        );
      if (
        !previewing &&
        saved !== null &&
        sha(JSON.stringify(saved)) !== sha(JSON.stringify(design))
      )
        throw new ToolError(
          "Saved enclosure settings differ from this preview. Save and preview again before exporting.",
          "precondition",
        );
      if (!previewing && snap.report.status === "blocked")
        throw new ToolError(
          snap.report.issues
            .filter((i) => i.severity === "error")
            .map((i) => i.message)
            .join("\n"),
          "precondition",
        );
      const built = await meshes(ctx, design, snap.boards);
      // A carved case differs from its original shell: review the result in world coordinates.
      let finalReport =
        design.mode === "imported"
          ? reviewSurface(checkMechanicalFit(design, snap.boards), design, snap.boards, built.base)
          : snap.report;
      if (verificationPending) {
        finalReport = {
          ...finalReport,
          issues: [
            ...finalReport.issues,
            {
              code: "verification-pending",
              severity: "review",
              message: "Shape preview only. Complete the model and fit checks before exporting.",
            },
          ],
        };
      } else
        finalReport = await detailedEnclosureFit(
          ctx,
          design,
          snap.boards,
          built.base,
          built.lid,
          finalReport,
        );
      if (built.validation)
        finalReport.geometry = {
          closed: true,
          baseParts: built.validation.base.components,
          lidParts: built.validation.lid?.components ?? 0,
          engine: built.validation.engine,
        };
      if (!previewing && finalReport.status === "blocked")
        throw new ToolError(
          finalReport.issues
            .filter((i) => i.severity === "error")
            .map((i) => i.message)
            .join("\n"),
          "precondition",
        );
      if ((await snapshot(dir, design)).revision !== snap.revision)
        throw new ToolError(
          "A source file changed during generation. Preview again.",
          "precondition",
        );
      if (previewing)
        return ok("Preview only — no project designs changed", {
          sourceRevision: snap.sourceRevision,
          ...(verificationPending ? { verificationPending: true } : { revision: snap.revision }),
          report: finalReport,
          boards: snap.boards,
          meshes: {
            base: Buffer.from(built.base).toString("base64"),
            lid: built.lid ? Buffer.from(built.lid).toString("base64") : null,
          },
        });
      const destination = `exports/mechanical-${snap.revision.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
      const outputs: Record<string, Uint8Array> = {
        "case.stl": built.base,
        "case.step": built.step,
        ...(built.lid ? { "lid.stl": built.lid } : {}),
        ...(built.lidPrint ? { "lid-print.stl": built.lidPrint } : {}),
        "PRINT-AND-FIT.txt": strToU8(
          [
            "FABDESK ENCLOSURE — PHYSICAL CHECK REQUIRED",
            `Design revision: ${snap.revision}`,
            "case.stl and case.step use assembly coordinates. Print the base flat on its floor.",
            "lid-print.stl is flipped with the outside face at Z=0, so the lip/holders point upward. lid.stl retains assembly coordinates.",
            "Import into your slicer in millimetres. Check bed size, wall layers, overhangs and support settings for your printer/material.",
            "Closed, joined geometry has been checked by software. Printing, strength and physical fit have NOT been verified.",
            "boards/ contains portable project-local model links. source-boards/ preserves original files when model links were rewritten; circuit geometry is unchanged.",
            "See model-dependencies.json for packaged files and unresolved/external library models that must still be installed. Missing dependencies are not proof of fit.",
            "[ ] Print a small pilot-hole / connector-fit sample before the full case.",
            "[ ] Fit every board with power disconnected; confirm all underside parts and solder joints clear the supports.",
            "[ ] Fit the actual plugs/cards; check insertion, removal and cable bends.",
            "[ ] Check lid screw engagement; do not force screws or let them reach the PCB.",
            "[ ] Check lid closing, board retention, cooling and fastener access.",
            "Printer/material: __________  Result/issues: __________  Checked by/date: __________",
          ].join("\n"),
        ),
        "enclosure-design.json": strToU8(JSON.stringify(design, null, 2)),
        "fit-review.json": strToU8(JSON.stringify(finalReport, null, 2)),
        ...(built.validation
          ? { "geometry-validation.json": strToU8(JSON.stringify(built.validation, null, 2)) }
          : {}),
      };
      Object.assign(outputs, snap.modelBundle.files);
      outputs["model-dependencies.json"] = strToU8(
        JSON.stringify(snap.modelBundle.dependencies, null, 2),
      );
      for (const [path, text] of Object.entries(await enclosureFitSamples(design, snap.boards)))
        outputs[path] = strToU8(text);
      outputs["manifest.json"] = strToU8(
        JSON.stringify(
          {
            version: 1,
            revision: snap.revision,
            units: "mm",
            coordinates: "PCB XY with Z up; use board placements in enclosure-design.json",
            createdAt: new Date().toISOString(),
            files: Object.fromEntries(Object.entries(outputs).map(([p, b]) => [p, sha(b)])),
            reviewRequired: true,
            electricalDrcRun: false,
            sourceBoardRevisions: snap.report.boardRevisions,
          },
          null,
          2,
        ),
      );
      if ((await snapshot(dir, design)).revision !== snap.revision)
        throw new ToolError(
          "A PCB, enclosure source or project model changed during export. Preview again before exporting.",
          "precondition",
        );
      // Publish immutable snapshots. A partial write can never replace a previous export.
      for (const [name, bytes] of Object.entries(outputs))
        await writeAtomic(await jailPath(dir, `${destination}/${name}`), bytes);
      const archive = `${destination}.zip`;
      await writeAtomic(await jailPath(dir, archive), zipSync(outputs));
      return ok(
        "Matched enclosure and PCB snapshot exported. Review fit notes and run electrical DRC before fabrication.",
        {
          revision: snap.revision,
          report: finalReport,
          stl: `${destination}/case.stl`,
          lidStl: built.lid ? `${destination}/lid.stl` : null,
          step: `${destination}/case.step`,
          archive,
        },
      );
    }),
});

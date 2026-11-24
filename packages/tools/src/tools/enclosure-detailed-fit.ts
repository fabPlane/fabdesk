import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MechanicalDesign, MechanicalFitReport } from "@fabdesk/protocol";
import { measureGlb, readSavedBoardModels } from "@fabdesk/kicad";
import { solidKernel, solidFromTriangles, type Manifold } from "@fabdesk/kicad/enclosure-solid";
import { readStlTriangles } from "@fabdesk/kicad/shell-fit";
import type { FitBoard } from "@fabdesk/kicad/mechanical-fit";
import type { ToolContext } from "../registry";
import { jailPath } from "../fs";
import { displayCoverage } from "./pcb-display";
import { sampleVerticalAssembly } from "./enclosure-assembly";
import { boundsSeparation } from "./enclosure-bounds";
import { exportEnclosureBoards } from "./enclosure-exports";

/** Native board artwork can be planar. Never classify a named component as artwork. */
export function isPlanarBoardLayer(
  root: ReturnType<typeof measureGlb>["roots"][number],
  board: FitBoard,
  references: Set<string>,
) {
  const r = root.bounds,
    f = board.features,
    o = f.outline;
  return (
    !!r &&
    !references.has(root.name) &&
    r.maxZ - r.minZ < 1e-5 &&
    (Math.abs(r.minZ) < 0.1 || Math.abs(r.minZ - f.thicknessMm) < 0.1) &&
    r.minX >= o.minX - 0.1 &&
    r.maxX <= o.maxX + 0.1 &&
    r.minY >= o.minY - 0.1 &&
    r.maxY <= o.maxY + 0.1
  );
}

/** Fresh native export + solid intersections. Missing/unclosed models remain explicit review items. */
export async function detailedEnclosureFit(
  ctx: ToolContext,
  d: MechanicalDesign,
  boards: FitBoard[],
  base: Uint8Array,
  lid: Uint8Array | null,
  original: MechanicalFitReport,
) {
  const report: MechanicalFitReport = { ...original, issues: [...original.issues], modelGaps: [] };
  const note = (code: string, message: string, severity: "error" | "review" = "review") =>
    report.issues.push({ code, message, severity });
  if (!d.detailedFit) {
    if (d.assemblyCheck)
      note("assembly-unavailable", "Enable actual 3D model checks to inspect the assembly path.");
    return report;
  }
  const cli = await ctx.services.kicad.resolveCli(ctx.signal);
  if (!cli) {
    note(
      "detailed-unavailable",
      "Detailed fit needs KiCad's native 3D exporter. No detailed check was performed.",
    );
    return report;
  }
  const dir = ctx.requireProject().dir,
    scratch = await jailPath(dir, `.fabdesk/detailed-fit/${randomUUID()}`);
  const k = await solidKernel(),
    owned: Manifold[] = [];
  await mkdir(scratch, { recursive: true });
  const own = (s: Manifold) => {
    owned.push(s);
    return s;
  };
  let checked = 0,
    total = 0;
  try {
    const exports = await exportEnclosureBoards(
      boards,
      async (b, index) => {
        const board = await jailPath(dir, b.placement.path);
        const output = join(scratch, `${index}-${randomUUID()}.glb`);
        await ctx.services.kicad.exportGlb(cli, {
          board,
          output,
          mechanical: true,
          signal: ctx.signal,
        });
        return { board, output };
      },
      ctx.signal,
    );
    const shell = own(solidFromTriangles(k, readStlTriangles(base)));
    const cover = lid ? own(solidFromTriangles(k, readStlTriangles(lid))) : null;
    const obstacles = d.obstacles.map((o) => ({
      path: o.name,
      solid: own(own(k.Manifold.cube([o.width, o.depth, o.height])).translate([o.x, o.y, o.z])),
    }));
    const assembled: Array<{ path: string; solid: Manifold }> = [];
    for (const [index, b] of boards.entries()) {
      ctx.signal?.throwIfAborted();
      const temporary: Manifold[] = [];
      const part = (solid: Manifold) => {
        temporary.push(solid);
        return solid;
      };
      try {
        const exported = exports[index]!;
        if (exported.status === "rejected") throw exported.reason;
        const { board, output } = exported.value;
        const bytes = await readFile(output);
        if (bytes.length > 50 * 1024 * 1024)
          throw new Error("model exceeds the 50 MB detailed-fit limit");
        const source = await readFile(board, "utf8"),
          references = new Set(readSavedBoardModels(source).flatMap((f) => (f.ref ? [f.ref] : []))),
          measured = measureGlb(bytes, { triangles: true }),
          coverage = displayCoverage(source, measured.roots);
        report.modelGaps!.push({ boardPath: b.placement.path, parts: coverage.details });
        if (coverage.missing.length)
          note(
            "detailed-missing",
            `${b.placement.path}: missing 3D bodies for ${coverage.missing.join(", ")}. These parts were not checked as solids. PCB model quality lists each part and its repair action.`,
          );
        const parts: Manifold[] = [];
        const openModels: string[] = [];
        let planarLayers = 0,
          boardTriangles = 0;
        for (const root of measured.roots) {
          if (!root.triangles?.length) continue;
          // Artwork is not a closed physical body. Do not spend the solid budget
          // or build three native copies of a surface that cannot be intersected.
          if (isPlanarBoardLayer(root, b, references)) {
            planarLayers++;
            continue;
          }
          boardTriangles += root.triangles.length / 9;
          if (boardTriangles > 500_000 || total + boardTriangles > 1_500_000)
            throw new Error(
              "detailed-fit solid budget exceeded (500,000 per board / 1,500,000 assembly triangles); split the assembly or simplify models",
            );
          try {
            const native = part(solidFromTriangles(k, root.triangles));
            const rotated = part(native.rotate([0, 0, b.placement.rotation]));
            const placed = part(rotated.translate([b.placement.x, b.placement.y, b.placement.z]));
            if (placed.volume() <= 0) throw new Error("non-positive solid volume");
            parts.push(placed);
          } catch {
            if (isPlanarBoardLayer(root, b, references)) planarLayers++;
            else openModels.push(root.name);
          }
        }
        if (openModels.length)
          note(
            "detailed-open",
            `${b.placement.path}: ${openModels.length} model surfaces (${openModels.join(", ")}) could not be checked as closed solids. Review the source 3D models.`,
          );
        if (planarLayers)
          note(
            "detailed-layers",
            `${b.placement.path}: ${planarLayers} unnamed planar surfaces near the PCB faces were excluded from solid intersections. These are consistent with board artwork layers; solder thickness and surface contact still require physical review.`,
          );
        if (!parts.length) throw new Error("no closed board/component models available");
        const solid = own(k.Manifold.union(parts));
        const solidBounds = solid.boundingBox();
        const intersecting = new Set<Manifold>();
        for (const [label, other] of [
          ["case", shell],
          ["lid", cover],
          ...assembled.map((a) => [a.path, a.solid]),
          ...obstacles.map((a) => [a.path, a.solid]),
        ] as Array<[string, Manifold | null]>) {
          if (!other) continue;
          if (boundsSeparation(solidBounds, other.boundingBox()) > 0) continue;
          const intersection = solid.intersect(other);
          try {
            if (intersection.volume() > 0.01) {
              intersecting.add(other);
              const bounds = intersection.boundingBox();
              report.issues.push({
                code: "detailed-collision",
                severity: "error",
                message: `${b.placement.path}: actual 3D geometry intersects ${label} (${intersection.volume().toFixed(2)} mm³).`,
                regions: [
                  {
                    name: "3D collision",
                    x: bounds.min[0],
                    y: bounds.min[1],
                    z: bounds.min[2],
                    width: bounds.max[0] - bounds.min[0],
                    depth: bounds.max[1] - bounds.min[1],
                    height: bounds.max[2] - bounds.min[2],
                  },
                ],
              });
            }
          } finally {
            intersection.delete();
          }
        }
        // Support surfaces intentionally touch their PCB, so enforce exact minimum
        // separation only between independent boards and reserved obstacles.
        for (const other of [...assembled, ...obstacles]) {
          const requiredGap = d.space.clearance + 2 * (d.fitAllowance ?? 0);
          if (boundsSeparation(solidBounds, other.solid.boundingBox()) >= requiredGap) continue;
          const gap = solid.minGap(other.solid, requiredGap);
          if (!intersecting.has(other.solid) && gap < requiredGap - 1e-4)
            note(
              "detailed-clearance",
              `${b.placement.path}: only ${gap.toFixed(2)} mm to ${other.path}; ${requiredGap} mm clearance including fit allowance is required.`,
              "error",
            );
        }
        assembled.push({ path: b.placement.path, solid });
        total += boardTriangles;
        checked += parts.length;
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        note(
          "detailed-unavailable",
          `${b.placement.path}: detailed fit incomplete — ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        for (const solid of temporary.reverse()) solid.delete();
      }
    }
    if (d.assemblyCheck) {
      const motions = [
        ...assembled.map((a) => ({
          ...a,
          barriers: [
            { path: "case", solid: shell },
            ...obstacles,
            ...assembled.filter((other) => other !== a),
          ],
        })),
        ...(cover
          ? [
              {
                path: "lid",
                solid: cover,
                barriers: [{ path: "case", solid: shell }, ...obstacles, ...assembled],
              },
            ]
          : []),
      ];
      for (const motion of motions) {
        const result = sampleVerticalAssembly(motion.solid, motion.barriers, ctx.signal);
        if (result.obstruction) {
          const hit = result.obstruction,
            b = hit.bounds;
          report.issues.push({
            code: "assembly-obstruction",
            severity: "review",
            message: `${motion.path}: straight-up removal intersects ${hit.path} at ${hit.offset.toFixed(2)} mm lift (${hit.volume.toFixed(2)} mm³). Straight-down installation along that path is obstructed. Review assembly order, angled insertion or the case opening. Other boards were held in their final positions.`,
            regions: [
              {
                name: "Sampled assembly obstruction",
                x: b.min[0],
                y: b.min[1],
                z: b.min[2],
                width: b.max[0] - b.min[0],
                depth: b.max[1] - b.min[1],
                height: b.max[2] - b.min[2],
              },
            ],
          });
        } else
          note(
            "assembly-sampled",
            `${motion.path}: no obstruction at 12 sampled positions over ${result.distance.toFixed(2)} mm of straight-up removal. This reverses downward installation; gaps between samples, missing models, cables, tools and strength are not verified.`,
          );
      }
      if (assembled.length !== boards.length)
        note(
          "assembly-unavailable",
          "Some board geometry was unavailable; assembly checks cover only the loaded bodies.",
        );
    }
    note(
      "detailed-coverage",
      `Checked ${checked} closed native bodies against case, lid, other boards and reserved obstacles. Minimum gaps between independent boards and obstacles were checked. Missing/open models, support contacts, cable routing and physical fit still need review.`,
    );
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    note(
      "detailed-unavailable",
      `Detailed solid checking unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const solid of owned.reverse()) solid.delete();
    await rm(scratch, { recursive: true, force: true });
  }
  report.status = report.issues.some((i) => i.severity === "error") ? "blocked" : "review";
  return report;
}

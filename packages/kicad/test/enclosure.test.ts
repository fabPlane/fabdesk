import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBoardFeatures } from "../src/board-features";
import {
  checkEnclosureAlignment,
  generateEnclosure,
  isEnclosureSpec,
  meshEnclosure,
  writeBoxesStep,
} from "../src/enclosure";

const fixture = readFileSync(join(import.meta.dir, "fixtures/enclosure/board.kicad_pcb"), "utf8");

describe("generateEnclosure", () => {
  test("builds a clamshell whose cutouts and standoffs sit on the board features", () => {
    const features = extractBoardFeatures(fixture);
    const spec = generateEnclosure(features, {}, new Date("2026-10-08T00:00:00.000Z"));
    expect(isEnclosureSpec(spec)).toBe(true);
    expect(spec.contract.name).toBe("fabdesk.enclosure");
    expect(spec.pcbRevision).toBe(features.pcbRevision);
    expect(spec.outer.maxX - spec.outer.minX).toBeCloseTo(50 + 2 * 1 + 2 * 2, 4);
    expect(spec.outer.maxY - spec.outer.minY).toBeCloseTo(30 + 2 * 1 + 2 * 2, 4);
    expect(spec.cutouts.map((c) => c.ref).sort()).toEqual(["J1", "J2"]);
    const usb = spec.cutouts.find((c) => c.ref === "J1")!;
    expect(usb.edge).toBe("minY");
    expect(usb.center.x).toBe(25);
    expect(usb.widthMm).toBeGreaterThan(features.connectors[0]!.widthMm);
    expect(spec.standoffs).toHaveLength(2);
    expect(spec.standoffs.some((s) => s.x === 4 && s.y === 4)).toBe(true);
    expect(spec.solids.some((s) => s.role === "floor")).toBe(true);
    expect(spec.solids.some((s) => s.role === "lid")).toBe(true);
    expect(spec.solids.filter((s) => s.role === "wall").length).toBeGreaterThanOrEqual(4);
    const aligned = checkEnclosureAlignment(spec, features);
    expect(aligned.ok).toBe(true);
    expect(aligned.stale).toBe(false);
    expect(aligned.issues).toEqual([]);
  });

  test("flags a moved connector and a changed board hash", () => {
    const features = extractBoardFeatures(fixture);
    const spec = generateEnclosure(features);
    const moved = structuredClone(features);
    const j1 = moved.connectors.find((c) => c.ref === "J1")!;
    j1.x = 31;
    j1.y = 0;
    const report = checkEnclosureAlignment(spec, moved);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "moved-cutout" && i.ref === "J1")).toBe(true);

    const staleBoard = extractBoardFeatures(fixture.replace("(at 25 0 0)", "(at 31 0 0)"));
    const stale = checkEnclosureAlignment(spec, staleBoard);
    expect(stale.stale).toBe(true);
    expect(stale.issues.some((i) => i.code === "stale-board")).toBe(true);
  });

  test("regenerating after a connector move realigns the cutout", () => {
    const before = extractBoardFeatures(fixture);
    const after = extractBoardFeatures(fixture.replace("(at 25 0 0)", "(at 31 0 0)"));
    expect(checkEnclosureAlignment(generateEnclosure(before), after).ok).toBe(false);
    const refreshed = generateEnclosure(after);
    const usb = refreshed.cutouts.find((c) => c.ref === "J1")!;
    expect(usb.center.x).toBe(31);
    expect(checkEnclosureAlignment(refreshed, after).ok).toBe(true);
  });
});

describe("meshEnclosure", () => {
  test("writes ASCII STL for base and lid plus a STEP assembly", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture));
    const mesh = meshEnclosure(spec);
    expect(mesh.baseStl).toStartWith("solid fabplane_enclosure_base");
    expect(mesh.baseStl).toContain("endsolid fabplane_enclosure_base");
    expect(mesh.lidStl).toContain("solid fabplane_enclosure_lid");
    expect((mesh.baseStl.match(/facet normal/g) ?? []).length).toBeGreaterThan(20);
    expect(mesh.step).toStartWith("ISO-10303-21;");
    expect(mesh.step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN'))");
    expect(mesh.step).toContain("MANIFOLD_SOLID_BREP('EnclosureFloor'");
    expect(mesh.step).toContain("MANIFOLD_SOLID_BREP('EnclosureLid'");
    expect(mesh.step).toContain("END-ISO-10303-21;");
  });

  test("STEP keeps every standoff as a tube with its screw bore", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture));
    const { step } = meshEnclosure(spec);
    const standoffs = spec.solids.filter((s) => s.role === "standoff");
    expect(standoffs).toHaveLength(2);
    for (const s of standoffs) expect(step).toContain(`MANIFOLD_SOLID_BREP('${s.name}'`);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)?.length).toBe(spec.solids.length);
    expect(step.match(/CYLINDRICAL_SURFACE/g)?.length).toBe(2 * standoffs.length);
    const radii = [...step.matchAll(/CYLINDRICAL_SURFACE\('',#\d+,([\d.]+)\)/g)].map((m) => Number(m[1]));
    for (const st of spec.standoffs) {
      expect(radii).toContain(st.outerDiameterMm / 2);
      expect(radii).toContain(st.innerDiameterMm / 2);
    }
    expect(step).toContain(`CARTESIAN_POINT('',(4,4,`);
  });

  test("writeBoxesStep emits an annular tube", () => {
    const step = writeBoxesStep([], [{ name: "T", cx: 1, cy: 2, z0: 0, z1: 5, innerRadiusMm: 1, outerRadiusMm: 3 }]);
    expect(step.match(/CLOSED_SHELL/g)?.length).toBe(1);
    expect(step.match(/ADVANCED_FACE/g)?.length).toBe(4);
    expect(step.match(/CIRCLE\(/g)?.length).toBe(4);
    expect(step).toContain("CYLINDRICAL_SURFACE('',#");
    expect(step).toContain(",3)");
    expect(step.match(/FACE_BOUND\(/g)?.length).toBe(2);
  });

  test("writeBoxesStep emits one closed shell per box", () => {
    const step = writeBoxesStep([
      { name: "A", min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
      { name: "B", min: { x: 4, y: 0, z: 0 }, max: { x: 5, y: 1, z: 1 } },
    ]);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)?.length).toBe(2);
    expect(step.match(/CLOSED_SHELL/g)?.length).toBe(2);
    expect(step).toContain("CARTESIAN_POINT('',(0,0,0))");
    expect(step).toContain("CARTESIAN_POINT('',(1,2,3))");
  });
});

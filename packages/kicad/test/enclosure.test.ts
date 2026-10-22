import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBoardFeatures } from "../src/board-features";
import {
  checkEnclosureAlignment,
  generateEnclosure,
  isEnclosureSpec,
  normalizeEnclosureSpec,
  meshEnclosure,
  punchRects,
  writeBoxesStep,
} from "../src/enclosure";
import { previewEnclosureSvg } from "../src/enclosure-preview";

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
    const dx = 6;
    j1.x = 31;
    j1.y = 0;
    j1.bounds = { ...j1.bounds, minX: j1.bounds.minX + dx, maxX: j1.bounds.maxX + dx };
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

  test("centres a pin-1-origin header cutout on the body, not the origin", () => {
    const board = `(kicad_pcb (version 20260831) (general (thickness 1.6))
      (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts"))
      (footprint "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
        (layer "F.Cu") (at 10 0 90)
        (property "Reference" "J3")
        (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1))
        (pad "2" thru_hole circle (at 0 2.54) (size 1.7 1.7) (drill 1))
        (pad "3" thru_hole circle (at 0 5.08) (size 1.7 1.7) (drill 1))
        (pad "4" thru_hole circle (at 0 7.62) (size 1.7 1.7) (drill 1))))`;
    const features = extractBoardFeatures(board);
    const spec = generateEnclosure(features);
    const cut = spec.cutouts.find((c) => c.ref === "J3")!;
    const bodyMid = (features.connectors[0]!.bounds.minX + features.connectors[0]!.bounds.maxX) / 2;
    expect(cut.center.x).toBeCloseTo(bodyMid, 3);
    expect(cut.center.x).not.toBeCloseTo(10, 0);
    expect(checkEnclosureAlignment(spec, features).ok).toBe(true);
  });

  test("punches a window at the cutout height instead of a floor-to-lid slot", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture));
    const usb = spec.cutouts.find((c) => c.ref === "J1")!;
    const zLo = usb.center.z - usb.heightMm / 2 + 0.05;
    const zHi = usb.center.z + usb.heightMm / 2 - 0.05;
    const walls = spec.solids.filter((s) => s.role === "wall");
    const covers = (x: number, y: number, z: number) =>
      walls.some((s) => x >= s.min.x && x <= s.max.x && y >= s.min.y && y <= s.max.y && z >= s.min.z && z <= s.max.z);
    const wallY = (spec.outer.minY + spec.inner.minY) / 2;
    expect(covers(usb.center.x, wallY, usb.center.z)).toBe(false);
    expect(covers(usb.center.x, wallY, zLo)).toBe(false);
    expect(covers(usb.center.x, wallY, zHi)).toBe(false);
    expect(covers(usb.center.x, wallY, spec.inner.z0 + 0.1)).toBe(true);
    expect(covers(usb.center.x, wallY, spec.inner.z1 - 0.1)).toBe(true);
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

describe("enclosure v2", () => {
  test("outline offset grows the case independently of clearance", () => {
    const features = extractBoardFeatures(fixture);
    const tight = generateEnclosure(features, { clearanceMm: 1, outlineOffsetMm: 0 });
    const offset = generateEnclosure(features, { clearanceMm: 1, outlineOffsetMm: 3 });
    const roomy = generateEnclosure(features, { clearanceMm: 4, outlineOffsetMm: 0 });
    expect(offset.outer.maxX - offset.outer.minX).toBeCloseTo((tight.outer.maxX - tight.outer.minX) + 6, 4);
    expect(offset.inner.minX).toBeCloseTo(features.outline.minX - 4, 4);
    expect(roomy.inner.minX).toBeCloseTo(features.outline.minX - 4, 4);
    expect(offset.params.outlineOffsetMm).toBe(3);
    expect(offset.params.clearanceMm).toBe(1);
  });

  test("grid vents punch the lid and survive STL/STEP export", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture), {
      ventPattern: "grid",
      ventFaces: "lid",
      ventPitchMm: 8,
      ventSizeMm: 2.5,
      ventMarginMm: 8,
    });
    expect(spec.vents.length).toBeGreaterThan(3);
    expect(spec.vents.every((v) => v.face === "lid")).toBe(true);
    expect(spec.solids.filter((s) => s.role === "lid").length).toBeGreaterThan(1);
    const mesh = meshEnclosure(spec);
    expect(mesh.lidStl).toContain("solid fabplane_enclosure_lid");
    expect((mesh.lidStl.match(/facet normal/g) ?? []).length).toBeGreaterThan(40);
    expect(mesh.step).toContain("ISO-10303-21;");
    expect(mesh.step).toContain("MANIFOLD_SOLID_BREP('EnclosureLid");
  });

  test("honeycomb and slot vents plus wall faces produce openings", () => {
    const honeycomb = generateEnclosure(extractBoardFeatures(fixture), {
      ventPattern: "honeycomb",
      ventFaces: "lid",
      ventPitchMm: 7,
      ventSizeMm: 2,
      ventMarginMm: 7,
    });
    const slots = generateEnclosure(extractBoardFeatures(fixture), {
      ventPattern: "slots",
      ventFaces: "both",
      ventPitchMm: 8,
      ventSizeMm: 2,
      ventMarginMm: 8,
    });
    expect(honeycomb.vents.length).toBeGreaterThan(2);
    expect(slots.vents.some((v) => v.face === "lid")).toBe(true);
    expect(slots.vents.some((v) => v.face === "wall")).toBe(true);
    expect(slots.solids.filter((s) => s.role === "wall").length).toBeGreaterThan(4);
  });

  test("snap-fit clips add through-lid hooks and appear in the mesh", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture), { snapFit: true, snapCount: 2 });
    expect(spec.clips.length).toBe(4);
    expect(spec.solids.filter((s) => s.role === "clip").length).toBeGreaterThanOrEqual(8);
    expect(spec.solids.some((s) => s.name.startsWith("EnclosureClip_"))).toBe(true);
    expect(spec.solids.some((s) => s.name.startsWith("EnclosureClipHook_"))).toBe(true);
    const mesh = meshEnclosure(spec);
    expect(mesh.baseStl).toContain("facet normal");
    expect(mesh.step).toContain("MANIFOLD_SOLID_BREP('EnclosureClip_");
    expect(mesh.step.match(/MANIFOLD_SOLID_BREP/g)?.length).toBe(spec.solids.length);
  });

  test("preview SVG shows offset, vents and snap-fits", () => {
    const spec = generateEnclosure(extractBoardFeatures(fixture), {
      outlineOffsetMm: 2,
      clearanceMm: 1,
      ventPattern: "grid",
      ventFaces: "lid",
      snapFit: true,
      snapCount: 2,
      ventMarginMm: 8,
      ventPitchMm: 8,
    });
    const svg = previewEnclosureSvg(spec);
    expect(svg).toContain("data-testid=\"enclosure-preview-svg\"");
    expect(svg).toContain("offset 2 mm");
    expect(svg).toContain("clearance 1 mm");
    expect(svg).toContain("data-layer=\"vent\"");
    expect(svg).toContain("data-layer=\"clip\"");
    expect(svg).toContain("data-view=\"iso\"");
  });

  test("wall vents stay mid-cavity, skip clip stations, and differ by pattern", () => {
    const features = extractBoardFeatures(fixture);
    const slots = generateEnclosure(features, {
      ventPattern: "slots",
      ventFaces: "walls",
      snapFit: true,
      snapCount: 2,
      ventPitchMm: 6,
      ventSizeMm: 2.5,
      ventMarginMm: 6,
    });
    const grid = generateEnclosure(features, {
      ventPattern: "grid",
      ventFaces: "walls",
      snapFit: true,
      snapCount: 2,
      ventPitchMm: 6,
      ventSizeMm: 2.5,
      ventMarginMm: 6,
    });
    const wallSlots = slots.vents.filter((v) => v.face === "wall");
    expect(wallSlots.length).toBeGreaterThan(0);
    for (const v of wallSlots) {
      expect(v.max.z - v.min.z).toBeLessThan(slots.inner.z1 - slots.inner.z0 - 0.5);
    }
    for (const clip of slots.clips) {
      const hit = wallSlots.some((v) => {
        if (v.edge !== clip.edge) return false;
        const mid = clip.edge === "minX" || clip.edge === "maxX" ? (v.min.y + v.max.y) / 2 : (v.min.x + v.max.x) / 2;
        const pos = clip.edge === "minX" || clip.edge === "maxX" ? clip.y : clip.x;
        return Math.abs(mid - pos) < clip.widthMm / 2 + 1;
      });
      expect(hit).toBe(false);
    }
    expect(grid.vents.filter((v) => v.face === "wall").length).toBeGreaterThan(wallSlots.length);
  });

  test("snap stems stay off the board envelope and skip connector openings", () => {
    const features = extractBoardFeatures(fixture);
    const spec = generateEnclosure(features, { snapFit: true, snapCount: 2, clearanceMm: 1, snapDepthMm: 1.4 });
    const boardTop = 2 + 3 + 1.6;
    for (const clip of spec.solids.filter((s) => s.name.startsWith("EnclosureClip_") && !s.name.includes("Hook") && !s.name.includes("Lead"))) {
      const inward =
        clip.max.y - spec.inner.minY < 3
          ? clip.max.y - spec.inner.minY
          : spec.inner.maxY - clip.min.y < 3
            ? spec.inner.maxY - clip.min.y
            : Math.min(clip.max.x - spec.inner.minX, spec.inner.maxX - clip.min.x);
      expect(inward).toBeLessThanOrEqual(0.7);
      expect(clip.min.z).toBeGreaterThanOrEqual(boardTop - 0.05);
    }
    const usb = spec.cutouts.find((c) => c.ref === "J1")!;
    expect(spec.clips.some((c) => c.edge === usb.edge && Math.abs(c.x - usb.center.x) < usb.widthMm / 2)).toBe(false);
  });

  test("normalizes a version-1 spec so status text has v2 defaults", () => {
    const v1 = generateEnclosure(extractBoardFeatures(fixture));
    const raw = {
      ...v1,
      contract: { name: "fabdesk.enclosure", version: "1.0.0" },
      params: { wallMm: 2, clearanceMm: 1, floorMm: 2, lidMm: 2, standoffMm: 3, headroomMm: 1.5, cutoutClearanceMm: 0.4, lipMm: 1 },
    };
    delete (raw as { vents?: unknown }).vents;
    delete (raw as { clips?: unknown }).clips;
    const normalized = normalizeEnclosureSpec(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.params.outlineOffsetMm).toBe(0);
    expect(normalized!.params.ventPattern).toBe("none");
    expect(normalized!.vents).toEqual([]);
    const text = [
      `Offset ${normalized!.params.outlineOffsetMm} mm + clearance ${normalized!.params.clearanceMm} mm`,
    ].join("");
    expect(text).not.toContain("undefined");
  });

  test("punchRects leaves a frame around a hole", () => {
    const pieces = punchRects({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, [{ minX: 3, minY: 3, maxX: 7, maxY: 7 }]);
    expect(pieces.length).toBe(4);
    const area = pieces.reduce((sum, p) => sum + (p.maxX - p.minX) * (p.maxY - p.minY), 0);
    expect(area).toBeCloseTo(100 - 16, 6);
  });
});

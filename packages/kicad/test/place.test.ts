import { describe, expect, test } from "bun:test";
import { placeFootprints, readFootprintPlacements, stackedFootprints } from "../src/place";

const v10 = `(kicad_pcb
	(version 20260831)
	(footprint "Package_SO:SOIC-16"
		(layer "F.Cu")
		(transform
			(translate 6 27)
			(rotate 0)
			(scale 1 1)
		)
		(property "Reference" "U1"
			(at 0 -5.5 0)
		)
		(pad "1" smd roundrect
			(at -2.475 -4.445)
		)
	)
	(footprint "Connector:Header"
		(layer "F.Cu")
		(transform
			(translate -5 -6)
			(rotate 90)
			(scale 1 1)
		)
		(property "Reference" "J2 \\"quoted\\""
			(at 0 0 0)
		)
	)
	(gr_line (start 0 0) (end 60 0))
)`;

describe("placeFootprints", () => {
  test("moves the footprint's transform and nothing inside it", () => {
    const r = placeFootprints(v10, [{ ref: "U1", x: 30, y: 12.5, rotation: 90 }]);
    expect(r.moved).toEqual([{ ref: "U1", x: 30, y: 12.5, rotation: 90 }]);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("(translate 30 12.5)\n\t\t\t(rotate 90)");
    // Child positions stay relative; their angles are absolute in the file and turn with the part.
    expect(r.text).toContain('(pad "1" smd roundrect\n\t\t\t(at -2.475 -4.445 90)');
    expect(r.text).toContain('(property "Reference" "U1"\n\t\t\t(at 0 -5.5 90)');
    // The other footprint is left alone.
    expect(r.text).toContain("(translate -5 -6)\n\t\t\t(rotate 90)");
  });

  test("keeps the rotation when none is given and reports unknown references", () => {
    const r = placeFootprints(v10, [
      { ref: 'J2 "quoted"', x: 1, y: 2 },
      { ref: "R9", x: 0, y: 0 },
    ]);
    expect(r.moved).toEqual([{ ref: 'J2 "quoted"', x: 1, y: 2, rotation: 90 }]);
    expect(r.missing).toEqual(["R9"]);
    expect(r.text).toContain("(translate 1 2)\n\t\t\t(rotate 90)");
    // No rotation change: child angles are left alone.
    expect(r.text).toContain('(property "Reference" "J2 \\"quoted\\""\n\t\t\t(at 0 0 0)');
  });

  test("rotating back normalises child angles into 0-359", () => {
    const r = placeFootprints(v10, [{ ref: 'J2 "quoted"', x: 1, y: 2, rotation: 0 }]);
    expect(r.text).toContain("(rotate 0)");
    expect(r.text).toContain('(property "Reference" "J2 \\"quoted\\""\n\t\t\t(at 0 0 270)');
  });

  test("legacy (at x y r) boards move but refuse a rotation change", () => {
    const legacy = `(kicad_pcb (footprint "R" (layer "F.Cu") (at 1 2 45) (fp_text reference "R1" (at 0 0 45)) (pad "1" smd rect (at -1 0 45))))`;
    const r = placeFootprints(legacy, [{ ref: "R1", x: 10, y: 20 }]);
    expect(r.text).toContain(
      '(footprint "R" (layer "F.Cu") (at 10 20 45) (fp_text reference "R1" (at 0 0 45))',
    );
    expect(() => placeFootprints(legacy, [{ ref: "R1", x: 10, y: 20, rotation: 0 }])).toThrow(
      /rotation/,
    );
  });
});

describe("readFootprintPlacements", () => {
  test("reads the v10 transform, the legacy at form and the layer", () => {
    const legacy = `(kicad_pcb
	(footprint "R" (layer "B.Cu") (at 1.5 -2 180)
		(property "Reference" "R9" (at 0 0 0))
	)
)`;
    expect(readFootprintPlacements(v10)).toEqual([
      { ref: "U1", x: 6, y: 27, rotation: 0, layer: "F.Cu" },
      { ref: 'J2 "quoted"', x: -5, y: -6, rotation: 90, layer: "F.Cu" },
    ]);
    expect(readFootprintPlacements(legacy)).toEqual([
      { ref: "R9", x: 1.5, y: -2, rotation: 180, layer: "B.Cu" },
    ]);
  });

  test("a placement written by placeFootprints reads back", () => {
    const moved = placeFootprints(v10, [{ ref: "U1", x: 30, y: 12.5, rotation: 90 }]).text;
    expect(readFootprintPlacements(moved)[0]).toEqual({
      ref: "U1",
      x: 30,
      y: 12.5,
      rotation: 90,
      layer: "F.Cu",
    });
  });
});

describe("stackedFootprints", () => {
  test("groups footprints that share an origin on the same side", () => {
    const at = (ref: string, x: number, y: number, layer = "F.Cu") => ({
      ref,
      x,
      y,
      rotation: 0,
      layer,
    });
    expect(
      stackedFootprints([
        at("C1", 0, 0),
        at("C2", 0, 0),
        at("R1", 5, 5),
        at("C3", 0, 0),
        at("R2", 0, 0, "B.Cu"),
      ]),
    ).toEqual([["C1", "C2", "C3"]]);
    expect(stackedFootprints([at("C1", 0, 0), at("R1", 5, 5)])).toEqual([]);
  });
});

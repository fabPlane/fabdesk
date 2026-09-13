import { describe, expect, test } from "bun:test";
import { placeFootprints } from "../src/place";

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
    // Children stay relative and untouched.
    expect(r.text).toContain('(pad "1" smd roundrect\n\t\t\t(at -2.475 -4.445)');
    expect(r.text).toContain('(property "Reference" "U1"\n\t\t\t(at 0 -5.5 0)');
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

/**
 * The toolkit's add_courtyards.py (main 066fea8), ported (board_route courtyards). Parity against the script itself:
 * test/parity-courtyards.ts (C6, cm5, vme).
 */
import { describe, expect, test } from "bun:test";
import { addCourtyards, padBox, unionOutline } from "../src/layout/courtyards";

/** A footprint in KiCad's `(at x y r)` spelling; `rot` is the footprint rotation. */
const fp = (ref: string, inner: string, side = "F", rot = 0) =>
  `  (footprint "lib:${ref}"\n    (layer "${side}.Cu")\n    (at 10 10${rot ? ` ${rot}` : ""})\n    (property "Reference" "${ref}")\n${inner}\n  )\n`;
/** The same in KiCad 10's `(transform (translate ..) (rotate ..))` spelling. */
const fpT = (ref: string, inner: string, rot: number) =>
  `  (footprint "lib:${ref}"\n    (transform\n      (translate 10 10)\n      (rotate ${rot})\n      (scale 1 1))\n    (layer "F.Cu")\n    (property "Reference" "${ref}"\n      (at 0 0 ${rot}))\n${inner}\n  )\n`;
/** `rot` is the pad angle as KiCad stores it: absolute, footprint rotation included. */
const pad = (n: string, x: number, y: number, w: number, h: number, rot = 0) => `    (pad "${n}" smd rect (at ${x} ${y}${rot ? ` ${rot}` : ""}) (size ${w} ${h}) (layers "F.Cu"))`;
const board = (...fps: string[]) => `(kicad_pcb\n${fps.join("")})\n`;

describe("addCourtyards", () => {
  test("a footprint with pads and no courtyard gets pad extent + margin on its side's CrtYd layer", () => {
    const r = addCourtyards(board(fp("SW1", [pad("1", -1, 0, 1, 2), pad("2", 1, 0, 1, 2)].join("\n"), "B")));
    expect(r.added).toEqual({ SW1: [3.5, 2.5, "B.CrtYd"] });
    expect(r.text).toContain('(fp_rect (start -1.750 -1.250) (end 1.750 1.250) (stroke (width 0.05) (type solid)) (fill no) (layer "B.CrtYd")');
  });
  test("a pad turned 90 degrees in its footprint swaps its sides; one off the axes counts as a circle of its larger size", () => {
    expect(addCourtyards(board(fp("R1", pad("1", 0, 0, 2, 1, 90)))).added["R1"]).toEqual([1.5, 2.5, "F.CrtYd"]);
    expect(addCourtyards(board(fp("R2", pad("1", 0, 0, 2, 1, 45)))).added["R2"]).toEqual([2.5, 2.5, "F.CrtYd"]);
  });
  test("pad angles are absolute: on a 90-degree footprint a pad stored at 90 is unturned in its own frame (C18_J101)", () => {
    // pads 0.25 x 1.0 along X at 0.4 mm pitch, the footprint turned 90: KiCad stores each pad at 90
    const pads = [-0.4, 0, 0.4].map((x, i) => pad(String(i + 1), x, 0, 0.25, 1.0, 90)).join("\n");
    const r = addCourtyards(board(fp("J101", pads, "F", 90)));
    // x: -0.525..0.525 + 0.25, y: -0.5..0.5 + 0.25 (the old reading swapped the pads: 1.0 wide, 0.25 tall)
    expect(r.added["J101"]).toEqual([1.55, 1.5, "F.CrtYd"]);
    expect(padBox(fp("J101", pads, "F", 90))).toEqual([-0.525, -0.5, 0.525, 0.5]);
  });
  test("270 and -90 degree footprints: the relative angle is taken with Python's modulo (never negative)", () => {
    // footprint 270, pad stored at 0: relative -270 -> 90 (JS % gave -90, read as off-axis)
    expect(padBox(fp("U1", pad("1", 0, 0, 2, 1, 0), "F", 270))).toEqual([-0.5, -1, 0.5, 1]);
    // footprint 270, pad stored at 90: relative -180 -> 0, sizes stand
    expect(padBox(fp("U2", pad("1", 0, 0, 2, 1, 90), "F", 270))).toEqual([-1, -0.5, 1, 0.5]);
    // footprint -90, pad stored at -90: relative 0
    expect(padBox(fp("U3", pad("1", 0, 0, 2, 1, -90), "F", -90))).toEqual([-1, -0.5, 1, 0.5]);
    // footprint 180, pad stored at 180: relative 0; at 270: relative 90
    expect(padBox(fp("U4", pad("1", 0, 0, 2, 1, 180), "F", 180))).toEqual([-1, -0.5, 1, 0.5]);
    expect(padBox(fp("U5", pad("1", 0, 0, 2, 1, 270), "F", 180))).toEqual([-0.5, -1, 0.5, 1]);
  });
  test("the transform spelling (KiCad 10) reads the footprint rotation from (rotate)", () => {
    expect(padBox(fpT("J1", pad("1", 0, 0, 2, 1, 90), 90))).toEqual([-1, -0.5, 1, 0.5]);
    expect(padBox(fpT("J2", pad("1", 0, 0, 2, 1, 0), 90))).toEqual([-0.5, -1, 0.5, 1]);
  });
  test("parts that have a courtyard or no pads are left alone; inverted courtyard rectangles are reordered", () => {
    const has = fp("C1", `${pad("1", 0, 0, 1, 1)}\n    (fp_rect (start 1 1) (end -1 -1) (layer "F.CrtYd"))`);
    const logo = fp("LOGO1", '    (fp_text user "x" (at 0 0))');
    const r = addCourtyards(board(has, logo));
    expect(r.added).toEqual({});
    expect(r.inverted_rects_fixed).toBe(1);
    expect(r.text).toContain("(fp_rect (start -1 -1) (end 1 1)");
  });
  test("halo replaces the part's own-side courtyard with the pad extent (pads as circles) + haloMm", () => {
    const u = fp("U1", `${pad("1", -1, 0, 0.5, 1)}\n${pad("2", 1, 0, 0.5, 1)}\n    (fp_rect (start -2 -2) (end 2 2) (layer "F.CrtYd"))`);
    const r = addCourtyards(board(u), { halo: ["U1"], haloMm: 0.8 });
    expect(r.halos).toEqual({ U1: [4.6, 2.6] }); // pads as circles r 0.5: x -1.5..1.5, + 0.8 each side
    expect(r.text).not.toContain("(start -2 -2)");
    expect(r.text.match(/F\.CrtYd/g)).toHaveLength(1);
  });
});

describe("addCourtyards refit", () => {
  const conn = (rot: number) =>
    fp("J1", [[-4.5, -1.5], [4.5, -1.5], [-4.5, 1.5], [4.5, 1.5]].map(([x, y], i) => pad(String(i + 1), x!, y!, 1, 0.5, rot)).join("\n") + '\n    (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "old"))', "F", rot);
  const other = fp("C9", `${pad("1", 0, 0, 1, 1)}\n    (fp_rect (start 1 1) (end -1 -1) (layer "F.CrtYd"))`);

  test("pads only: the own-side courtyard becomes pads + margin; other footprints and inverted rects stay as they are", () => {
    const r = addCourtyards(board(conn(90), fp("R7", pad("1", 0, 0, 1, 1)), other), { refit: ["J1"] });
    expect(r.refitted["J1"]).toEqual({ pads: [-5, -1.75, 5, 1.75], courtyard: [[-5.25, -2], [5.25, -2], [5.25, 2], [-5.25, 2]] });
    expect(r.text).not.toContain('(uuid "old")');
    expect(r.text).toContain('(fp_rect (start -5.250 -2.000) (end 5.250 2.000) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd")');
    expect(r.added).toEqual({});
    expect(r.inverted_rects_fixed).toBe(0);
    expect(r.text).toContain("(fp_rect (start 1 1) (end -1 -1)"); // C9 untouched
    expect(r.text.match(/CrtYd/g)).toHaveLength(2); // R7 gets none in refit mode
  });
  test("a body longer than the pads in one axis and shorter in the other gives a 12-corner union outline (fp_poly)", () => {
    const pads = [-4.75, 4.75].map((x, i) => pad(String(i + 1), x, 0, 0.5, 2)).join("\n"); // box -5..5 x -1..1
    const r = addCourtyards(board(fp("U9", pads)), { refit: ["U9"], bodies: { _doc: "comment", U9: { size: [4, 6], source: "datasheet" } } });
    expect(r.refitted["U9"]!.body).toEqual([-2, -3, 2, 3]);
    expect(r.refitted["U9"]!.source).toBe("datasheet");
    expect(r.refitted["U9"]!.courtyard).toEqual([
      [-5.25, -1.25], [-2.25, -1.25], [-2.25, -3.25], [2.25, -3.25], [2.25, -1.25], [5.25, -1.25],
      [5.25, 1.25], [2.25, 1.25], [2.25, 3.25], [-2.25, 3.25], [-2.25, 1.25], [-5.25, 1.25],
    ]);
    expect(r.text).toContain("(fp_poly (pts (xy -5.250 -1.250) (xy -2.250 -1.250) (xy -2.250 -3.250)");
    expect(r.text).toContain('(fp_rect (start -2.000 -3.000) (end 2.000 3.000) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab")');
  });
  test("a body that encloses the pads gives a rectangle; refitting again keeps one body rect and one courtyard", () => {
    const once = addCourtyards(board(conn(90)), { refit: ["J1"], bodies: { J1: { size: [12.3, 3.75], center: [0, 0] } } });
    expect(once.refitted["J1"]!.courtyard).toEqual([[-6.4, -2.125], [6.4, -2.125], [6.4, 2.125], [-6.4, 2.125]]);
    const twice = addCourtyards(once.text, { refit: ["J1"], bodies: { J1: { size: [12.3, 3.75] } } });
    expect(twice.text.match(/"F\.Fab"/g)).toHaveLength(1);
    expect(twice.text.match(/"F\.CrtYd"/g)).toHaveLength(1);
  });
  test("a back-side footprint: courtyard on B.CrtYd, body on B.Fab", () => {
    const r = addCourtyards(board(fp("Q1", pad("1", 0, 0, 1, 1), "B")), { refit: ["Q1"], bodies: { Q1: { size: [2, 2] } } });
    expect(r.text).toContain('(layer "B.Fab")');
    expect(r.text).toContain('(layer "B.CrtYd")');
  });
  test("an unknown reference, a part without pads or a body without a size is refused", () => {
    expect(() => addCourtyards(board(conn(0)), { refit: ["NOPE"] })).toThrow(/no footprint NOPE/);
    expect(() => addCourtyards(board(fp("LOGO1", '    (fp_text user "x" (at 0 0))')), { refit: ["LOGO1"] })).toThrow(/no pads/);
    expect(() => addCourtyards(board(conn(0)), { refit: ["J1"], bodies: { J1: { center: [0, 0] } } })).toThrow(/size/);
  });
});

describe("unionOutline", () => {
  test("one rectangle gives its four corners; two apart are not one region", () => {
    expect(unionOutline([[0, 0, 2, 1]])).toEqual([[0, 0], [2, 0], [2, 1], [0, 1]]);
    expect(() => unionOutline([[0, 0, 1, 1], [2, 2, 3, 3]])).toThrow(/not one region/);
  });
  test("an L of two rectangles gives six corners", () => {
    expect(unionOutline([[0, 0, 4, 1], [0, 0, 1, 3]])).toEqual([[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]]);
  });
});

/** The toolkit's add_courtyards.py, ported (board_route courtyards): parity on cm5 / vme / jetson was byte-identical. */
import { describe, expect, test } from "bun:test";
import { addCourtyards } from "../src/layout/courtyards";

const fp = (ref: string, inner: string, side = "F") =>
  `  (footprint "lib:${ref}"\n    (layer "${side}.Cu")\n    (property "Reference" "${ref}")\n${inner}\n  )\n`;
const pad = (n: string, x: number, y: number, w: number, h: number, rot = 0) => `    (pad "${n}" smd rect (at ${x} ${y}${rot ? ` ${rot}` : ""}) (size ${w} ${h}) (layers "F.Cu"))`;
const board = (...fps: string[]) => `(kicad_pcb\n${fps.join("")})\n`;

describe("addCourtyards", () => {
  test("a footprint with pads and no courtyard gets pad extent + margin on its side's CrtYd layer", () => {
    const r = addCourtyards(board(fp("SW1", [pad("1", -1, 0, 1, 2), pad("2", 1, 0, 1, 2)].join("\n"), "B")));
    expect(r.added).toEqual({ SW1: [3.5, 2.5, "B.CrtYd"] });
    expect(r.text).toContain('(fp_rect (start -1.750 -1.250) (end 1.750 1.250) (stroke (width 0.05) (type solid)) (fill no) (layer "B.CrtYd")');
  });
  test("a pad at 90 degrees swaps its sides; one off the axes counts as a circle of its larger size", () => {
    expect(addCourtyards(board(fp("R1", pad("1", 0, 0, 2, 1, 90)))).added["R1"]).toEqual([1.5, 2.5, "F.CrtYd"]);
    expect(addCourtyards(board(fp("R2", pad("1", 0, 0, 2, 1, 45)))).added["R2"]).toEqual([2.5, 2.5, "F.CrtYd"]);
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

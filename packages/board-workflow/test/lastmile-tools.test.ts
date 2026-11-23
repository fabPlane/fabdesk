/**
 * Last-mile tools on fixtures: connected-path length (net_path_measure), the view's DRC markers and layer filter,
 * the return-path audit's declared pair nets, and the cut / region actions.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastmile as L, parseBoard } from "../src/index";
import type { LayoutHost } from "../src/layout/ctx";

const fp = (ref: string, x: number, y: number, pad: string, layers = '"F.Cu"', shape = "smd") =>
  `\n (footprint "x" (layer "F.Cu") (at ${x} ${y}) (property "Reference" "${ref}") (pad "1" ${shape} rect (at 0 0) (size 0.5 0.5) (layers ${layers}) (net "${pad}")))`;
const seg = (x0: number, y0: number, x1: number, y1: number, net = "SIG", layer = "F.Cu", w = 0.2) => `\n (segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width ${w}) (layer "${layer}") (net "${net}"))`;
const via = (x: number, y: number, net = "SIG") => `\n (via (at ${x} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}"))`;
const board = (body: string) => `(kicad_pcb (version 20241229)\n (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))\n (gr_rect (start -2 -5) (end 12 5) (layer "Edge.Cuts"))${body}\n)`;
const STACK = ["F.Cu", "B.Cu"];
const two = fp("U1", 0, 0, "SIG") + fp("U2", 10, 0, "SIG");

describe("net_path_measure (connected path)", () => {
  test("a tail off the path counts in the segment sum, not in the path", () => {
    const b = parseBoard(board(two + seg(0, 0, 5, 0) + seg(5, 0, 10, 0) + seg(5, 0, 5, 3)));
    const r = L.measureNetPath(b, "SIG", STACK);
    expect(r.pads).toEqual(["U1.1", "U2.1"]);
    expect(r.connected_path_mm).toBeCloseTo(10, 12);
    expect(r.all_segments_mm).toBeCloseTo(13, 12);
  });
  test("crossing segments join where they cross; a T join off the centreline joins its true end", () => {
    // the path runs 0,0 -> 4,-1 -> crossing ... the X makes a shorter route through its crossing point
    const x = board(two + seg(0, 0, 6, 2) + seg(4, 2, 10, 0) + seg(0, 0, 4, 2, "SIG", "F.Cu", 0.01));
    const r = L.measureNetPath(parseBoard(x), "SIG", STACK);
    // 0,0 -> crossing (5,5/3 on both lines) -> 10,0
    const cross: [number, number] = [5, 5 / 3];
    expect(r.connected_path_mm).toBeCloseTo(Math.hypot(...cross) + Math.hypot(10 - cross[0], cross[1]), 9);
    const t = board(two + seg(0, 0, 5, 0) + seg(5, 0.05, 10, 0.05));
    expect(L.measureNetPath(parseBoard(t), "SIG", STACK).connected_path_mm).toBeCloseTo(5 + 0.05 + 5, 9);
  });
  test("layers join only at vias (and plated pads); without the via the pads are not connected", () => {
    const withVia = board(two + seg(0, 0, 3, 0) + via(3, 0) + seg(3, 0, 7, 0, "SIG", "B.Cu") + via(7, 0) + seg(7, 0, 10, 0));
    expect(L.measureNetPath(parseBoard(withVia), "SIG", STACK).connected_path_mm).toBeCloseTo(10, 12);
    const noVia = board(two + seg(0, 0, 3, 0) + via(3, 0) + seg(3, 0, 7, 0, "SIG", "B.Cu") + seg(7, 0, 10, 0));
    const r = L.measureNetPath(parseBoard(noVia), "SIG", STACK);
    expect(r.connected_path_mm).toBeNull();
    expect(r.all_segments_mm).toBeCloseTo(10, 12);
    const th = board(fp("U1", 0, 0, "SIG", '"*.Cu"', "thru_hole") + fp("U2", 10, 0, "SIG") + seg(0, 0, 10, 0, "SIG", "B.Cu"));
    expect(L.measureNetPath(parseBoard(th), "SIG", STACK).connected_path_mm).toBeNull(); // U2 is an F.Cu pad
  });
  test("a net without two pads is refused by name; endpoints pick two of more", () => {
    const three = board(two + fp("TP1", 5, 2, "SIG") + seg(0, 0, 10, 0) + seg(5, 0, 5, 2));
    expect(() => L.measureNetPath(parseBoard(three), "SIG", STACK)).toThrow("SIG: expected 2 pads, got 3");
    expect(L.measureNetPath(parseBoard(three), "SIG", STACK, ["U1.1", "TP1.1"]).connected_path_mm).toBeCloseTo(7, 12);
  });
  test("pair report: connected-path mismatch beside the segment-sum mismatch", () => {
    const pb = board(fp("U1", 0, 0, "P") + fp("U2", 10, 0, "P") + fp("U3", 0, 1, "N") + fp("U4", 10, 1, "N") + seg(0, 0, 10, 0, "P") + seg(4, 0, 4, 2, "P") + seg(0, 1, 10, 1, "N"));
    const rows = L.measurePairPaths(parseBoard(pb), [{ p: "P", n: "N" }], STACK);
    expect(rows[0]!.mismatch_mm).toBeCloseTo(0, 12);
    expect(rows[0]!.segment_mismatch_mm).toBeCloseTo(2, 12);
    expect(L.pairPathLines(rows)[0]).toBe("  P / N: P 10.000 (segments 12.000), N 10.000 (segments 10.000); mismatch 0.000 mm (segment sums 2.000)");
    const lone = L.measurePairPaths(parseBoard(board(two)), [{ p: "SIG", n: "X" }], STACK);
    expect(lone[0]!.mismatch_mm).toBeNull();
    expect(L.pairPathLines(lone)[0]).toContain("X not measured (expected 2 pads, got 0)");
  });
  test("GEOS segment rules: end-to-end collinear touch is a point, overlap and zero length are not", () => {
    expect(L.segmentIntersection([0, 0], [1, 0], [1, 0], [2, 0])).toEqual([1, 0]);
    expect(L.segmentIntersection([0, 0], [2, 0], [1, 0], [3, 0])).toBeNull();
    expect(L.segmentIntersection([1, 1], [1, 1], [0, 0], [2, 2])).toBeNull();
    expect(L.segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0])).toEqual([1, 1]);
    expect(L.segmentIntersection([0, 0], [2, 0], [1, 0], [1, 5])).toEqual([1, 0]);
    expect(L.orientation([0, 0], [1, 1], [0.1 + 0.2, 0.30000000000000004])).toBe(0);
    expect(L.project([0, 0], [4, 0], [5, 3])).toBe(4);
    expect(L.interpolate([0, 0], [4, 0], 1)).toEqual([1, 0]);
  });
});

describe("view: DRC markers, layers", () => {
  const b = parseBoard(board(two + seg(0, 0, 5, 0) + seg(5, 0, 10, 0, "SIG", "B.Cu") + via(5, 0)));
  test("unconnected items as the toolkit draws them: a line through the items, a dot at each, the net's short name at the first", () => {
    const drc: L.ViewDrc = {
      unconnected: [{ items: [{ description: "Pad 1 [a74::USB_DP] of U1", pos: { x: 0, y: 0 } }, { description: "Track [a74::USB_DP] on F.Cu", pos: { x: 5, y: 1 } }] }],
      violations: [{ type: "clearance", items: [{ description: "x", pos: { x: 2, y: 2 } }] }],
    };
    const svg = L.renderBoardSvg(b, { window: [-2, -5, 12, 5], drc });
    expect(svg).toContain('<polyline class="drc-open" points="0,0 5,1"');
    expect(svg.match(/class="drc-open-end"/g)).toHaveLength(2);
    expect(svg).toContain('fill="purple">USB_DP</text>');
    expect(svg).toContain('class="drc-violation"');
    expect(svg).toContain("<title>clearance</title>");
    // a DRC report replaces the plain open lines
    expect(L.renderBoardSvg(b, { window: [-2, -5, 12, 5], drc, opens: [{ net: "Q", a: [1, 1], b: [2, 2] }] })).not.toContain(">Q<");
  });
  test("layers filters the tracks drawn (pads and vias stay); the legend names the layers", () => {
    const all = L.renderBoardSvg(b, { window: [-2, -5, 12, 5] });
    const front = L.renderBoardSvg(b, { window: [-2, -5, 12, 5], layers: ["F.Cu"] });
    const tracks = (s: string) => (s.match(/<line [^>]*stroke-linecap="round"/g) ?? []).length;
    expect(tracks(all)).toBe(2);
    expect(tracks(front)).toBe(1);
    expect(front).toContain('stroke="#d62728"');
    expect(front).not.toContain(">B.Cu</text>");
    expect(all).toContain(">B.Cu</text>");
    expect(front.match(/<circle/g)?.length ?? 0).toBe(all.match(/<circle/g)?.length ?? 0);
  });
});

describe("validate: the return-path audit names every declared pair net", () => {
  test("declaredPairNets: every pair net of every class, sorted, once", () => {
    const acc = { net_classes: { classes: { USB: { pairs: [["a74::USB_DP", "a74::USB_DM"]] }, LVDS: { pairs: [["c18::LCD_RX0+", "c18::LCD_RX0-"], ["a74::USB_DP", "a74::USB_DM"]] }, PWR: {} } } };
    expect(L.declaredPairNets(acc)).toEqual(["a74::USB_DM", "a74::USB_DP", "c18::LCD_RX0+", "c18::LCD_RX0-"]);
  });
  test("tmPairAudit runs return-paths with --nets (not --diff-pairs) and counts WARN lines", async () => {
    const d = await mkdtemp(join(tmpdir(), "tm-audit-"));
    try {
      const calls: string[][] = [];
      const host = {
        tools: { tracemaker: "/x/tracemaker", krt: null, kicadCli: "" },
        spawn: async (cmd: string[], o: { log: string }) => {
          calls.push(cmd);
          await Bun.write(o.log, cmd[1] === "return-paths" ? "A  x  WARN\n    warning: far\nB  y\n" : "pairs\n");
          return { code: 0, wallS: 0 };
        },
      } as unknown as LayoutHost;
      const r = await L.tmPairAudit(host, join(d, "C6.kicad_pcb"), d, ["N1", "N2"]);
      expect(calls[1]).toEqual(["/x/tracemaker", "return-paths", join(d, "C6.kicad_pcb"), "--nets", "N1,N2"]);
      expect(r?.returnPathWarnings).toBe(1);
      expect(await readFile(join(d, "tm-return-paths.txt"), "utf8")).toContain("WARN");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("cut and region actions (route_region's rip, --escape, route)", () => {
  test("cut is a rip-only step; region:BOX!escape is cut, escape, after-cut in route_region's order", () => {
    expect(L.stepsFor("cut:1,2,3,4")).toEqual([{ type: "cut", cut: { boxes: [[1, 2, 3, 4]] } }]);
    expect(L.stepsFor("cut:opens~1.5")[0]!.cut).toEqual({ boxes: [], aroundOpens: 1.5 });
    expect(L.stepsFor("region:1,2,3,4;opens!escape")[0]!.cut).toEqual({ boxes: [[1, 2, 3, 4]], aroundOpens: 1.0 });
    expect(L.stepsFor("cut:1,2,3,4;5,6,7,8")[0]!.cut!.boxes).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(L.stepsFor("region:1,2,3,4!escape").map((s) => s.planName ?? s.type)).toEqual(["cut", "escape", "after-cut"]);
    expect(L.stepsFor("region:1,2,3,4!escape")[1]!.escape).toEqual({ maxStub: 0.9, clearance: 0.1 });
    expect(L.stepsFor("region:1,2,3,4").map((s) => s.planName ?? s.type)).toEqual(["cut", "after-cut"]);
    expect(L.stepsFor("cut:1,2,3,4+escape+route").map((s) => s.planName ?? s.type)).toEqual(["cut", "escape", "after-cut"]);
    expect(() => L.stepsFor("cut:1,2,3")).toThrow("a box is X0,Y0,X1,Y1");
    expect(() => L.stepsFor("cut")).toThrow("give a box");
    expect(() => L.stepsFor("region:1,2,3,x!escape")).toThrow("'x' is not a number");
  });
});

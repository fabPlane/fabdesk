/** The power ports: power_escape, power_planes, pour_opens (toolkit tools/*.py), as library calls, last-mile steps and route-pipeline steps. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoard, kid, kids, parseSexpr, type Acceptance } from "../src/index";
import { prepareRouteBase } from "../src/layout/index";
import { checkPlanesPlan, fnmatch, label, layerOf, mst, powerEscape, powerPlanes, pourOpens, rects, PlanesError } from "../src/power/index";

const pad = (num: string, x: number, y: number, w: number, h: number, net: string, side = "F") =>
  `(pad "${num}" smd rect (at ${x} ${y}) (size ${w} ${h}) (layers "${side}.Cu" "${side}.Paste" "${side}.Mask") (net "${net}"))`;
const fp = (ref: string, x: number, y: number, pads: string[], rot = 0) =>
  `\n  (footprint "QFN" (layer "F.Cu") (at ${x} ${y} ${rot}) (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS")) ${pads.join(" ")})`;
const board = (body: string, outline: [number, number, number, number] = [0, 0, 20, 10]) =>
  `(kicad_pcb (version 20250114) (generator "test")\n  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))${body}\n  (gr_rect (start ${outline[0]} ${outline[1]}) (end ${outline[2]} ${outline[3]}) (layer "Edge.Cuts"))\n)\n`;

const acceptance = (classes: Acceptance["net_classes"]["classes"], native = false): Acceptance =>
  ({
    schema: "TEST",
    manufacturing_rules: {
      adopted: { min_track_width: 0.1, min_clearance: 0.1, default_class: { track_width: 0.2, clearance: 0.15, via_diameter: 0.5, via_drill: 0.25 } },
      scoped_rules: [],
      basis: "",
      native_project_rules: native,
      native_project_rules_basis: "",
    },
    stack_policy: { copper_layers: ["F.Cu", "In1.Cu", "B.Cu"], plane_layers: [], ground_net: "GND", via_spans: { through: ["F.Cu", "B.Cu"] } },
    net_classes: { tap_rule: "", tap_pads: {}, neck_allowance: "", class_clearance: 0.15, router_width_rules: { neck_floor_mm: 0.1 }, classes },
  }) as unknown as Acceptance;

/** An 8-pin part at (10, 5): pins 1-4 down the left at 0.5 mm pitch, 5-8 down the right; pins 1 and 2 are VIN. */
const qfn = (nets = ["VIN", "VIN", "A", "B", "C", "D", "E", "F"]) =>
  fp("U1", 10, 5, nets.map((n, i) => pad(String(i + 1), i < 4 ? -1.5 : 1.5, -0.75 + (i % 4) * 0.5, 0.6, 0.25, n)));
const segs = (text: string) => kids(parseSexpr(text), "segment");

describe("power_escape", () => {
  const acc = acceptance({ PWR_600: { track_width: 0.6, inner_track_width: 0.6, nets: ["VIN"] } });
  test("bridges adjacent same-net pins and stubs them outward within 1 mm of the pad, at pad width", () => {
    const r = powerEscape(board(qfn()), acc, { uuid: () => "u" });
    expect(r.stats).toEqual({ bridges: 1, stubs: 2, stubs_blocked: 0 });
    const bridge = r.segments.find((s) => s.kind === "bridge")!;
    expect(bridge.a).toEqual([8.5, 4.25]);
    expect(bridge.b).toEqual([8.5, 4.75]);
    expect(bridge.w).toBe(0.25);
    // pin 1 sits left of the part centre: its stub runs -x, 0.3 + 0.9 capped to 1.0 mm from the centre
    const stub = r.segments.find((s) => s.kind === "stub" && s.a[1] === 4.25)!;
    expect(stub.b).toEqual([7.5, 4.25]);
    const written = segs(r.text);
    expect(written).toHaveLength(3);
    expect(kid(written[0]!, "net")![1]).toBe("VIN");
    expect(kid(written[0]!, "width")![1]).toBe("0.2500");
  });
  test("a stub that would pass too near another net's track is blocked; pins near the class width get none", () => {
    const blocker = `\n  (segment (start 7.8 3) (end 7.8 6) (width 0.2) (layer "F.Cu") (net "X") (uuid "t"))`;
    const r = powerEscape(board(qfn() + blocker), acc);
    expect(r.stats.stubs_blocked).toBe(2);
    expect(r.stats.bridges).toBe(1);
    const wide = acceptance({ PWR_300: { track_width: 0.45, nets: ["VIN"] } });
    expect(powerEscape(board(qfn()), wide).stats).toEqual({ bridges: 0, stubs: 0, stubs_blocked: 0 });
  });
  test("parts with fewer than 6 pads, and through-hole pins, are left alone", () => {
    const small = fp("U2", 10, 5, [pad("1", -0.5, 0, 0.25, 0.6, "VIN"), pad("2", 0, 0, 0.25, 0.6, "VIN")]);
    const r = powerEscape(board(small), acc);
    expect(r.stats).toEqual({ bridges: 0, stubs: 0, stubs_blocked: 0 });
    expect(r.text).toBe(board(small));
  });
});

describe("power_planes", () => {
  // VIN pads at the left, V5 at the right, GND fills the rest; a second VIN cluster far right makes a corridor
  const body = fp("J1", 2, 5, [pad("1", 0, 0, 1, 1, "VIN"), pad("2", 0, 1, 1, 1, "GND")]) + fp("J2", 12, 5, [pad("1", 0, 0, 1, 1, "V5")]) + fp("J3", 18.5, 8.5, [pad("1", 0, 0, 1, 1, "VIN")]);
  const plan = { layer: "In1.Cu", cell_mm: 0.5, reach_mm: 4, fill_net: "GND", nets: [{ net: "VIN", weight: 1 }, { net: "V5", weight: 1 }] };
  test("cells go to the nearest plan net within reach, pieces are joined, one zone per net plus the fill", () => {
    const r = powerPlanes(board(body), plan, { uuid: () => "z" });
    expect(r.record.zones).toBe(3);
    expect(r.record.box).toEqual([0.5, 0.5, 19.5, 9.5]);
    expect(r.record.corridors).toBe(1);
    expect(r.record.nets["VIN"]!.pieces).toBe(1);
    expect(r.record.nets["V5"]!.area_mm2).toBeGreaterThan(0);
    const zones = kids(parseSexpr(r.text), "zone");
    expect(zones.map((z) => [kid(z, "net")![1], kid(z, "priority")![1]])).toEqual([["VIN", "3"], ["V5", "2"], ["GND", "0"]]);
    expect(kid(zones[0]!, "name")![1]).toBe("power_planes In1.Cu power plane VIN");
    expect(kids(zones[2]!, "polygon")).toHaveLength(1);
  });
  test("named stale zones are removed first; a missing name, a net without pads, a bad plan are refused by name", () => {
    const stale = `\n  (zone (net "GND") (layer "In1.Cu") (uuid "s") (name "old guard") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))`;
    const r = powerPlanes(board(body + stale), { ...plan, remove_zone_names: ["old guard"] });
    expect(r.text).not.toContain("old guard");
    expect(() => powerPlanes(board(body), { ...plan, remove_zone_names: ["nope"] })).toThrow(/no zone named "nope"/);
    expect(() => powerPlanes(board(body), { ...plan, nets: [{ net: "NOPE" }] })).toThrow(/net NOPE has no pads/);
    expect(() => checkPlanesPlan({ layer: "F.Cu", nets: [{ net: "A" }] })).toThrow(PlanesError);
    expect(() => checkPlanesPlan({ layer: "In2.Cu", nets: [] })).toThrow(/nets must be/);
  });
  test("grid helpers: raster-order labels, Kruskal with stable ties, row rectangles", () => {
    // two blobs; the first in raster order is label 1
    const m = Uint8Array.from([0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0]);
    const { lab, n } = label(m, 4, 3);
    expect(n).toBe(2);
    expect(lab[1]).toBe(1);
    expect(lab[3]).toBe(2);
    // equal weights: the first edges in row-major order win
    expect(mst([[0, 1, 1], [1, 0, 1], [1, 1, 0]])).toEqual([[0, 1], [0, 2]]);
    expect(rects(Uint8Array.from([1, 1, 1, 1]), 2, 2, 0, 0, 0.5)).toEqual([[0, 0, 1, 1]]);
  });
});

describe("pour_opens", () => {
  const acc = acceptance({ PWR_500: { track_width: 0.5, nets: ["VIN"] } });
  const open = (net: string, a: string, b: string, ax = 1, bx = 5) => ({ items: [{ description: `Pad 1 [${net}] of U1 ${a}`, pos: { x: ax, y: 2 } }, { description: `Track [${net}] ${b}`, pos: { x: bx, y: 3 } }] });
  test("a zone on the outer layer both ends share, class width as min thickness, margin round the ends", () => {
    const r = pourOpens(board(""), acc, [open("VIN", "on F.Cu", "on F.Cu - B.Cu"), open("SIG", "on F.Cu", "on F.Cu")], { uuid: () => "p" });
    expect(r.made).toEqual([{ net: "VIN", layer: "F.Cu", box: [-0.5, 0.5, 6.5, 4.5], min_thickness: 0.5 }]);
    const z = kids(parseSexpr(r.text), "zone")[0]!;
    expect(kid(z, "min_thickness")![1]).toBe("0.500");
    expect(kid(z, "name")![1]).toBe("pour_opens VIN");
  });
  test("ends on different sides are skipped; globs add nets at 0.3 mm x scale", () => {
    const r = pourOpens(board(""), acc, [open("VIN", "on F.Cu", "on B.Cu"), open("SIG_1", "on B.Cu", "on F.Cu - B.Cu")], { nets: ["SIG_?"], minWidthScale: 0.5, margin: 1 });
    expect(r.made).toEqual([{ net: "VIN", skipped: "endpoints share no outer layer" }, { net: "SIG_1", layer: "B.Cu", box: [0, 1, 6, 4], min_thickness: 0.15 }]);
  });
  test("fnmatch and the layer parser follow the script", () => {
    expect(fnmatch("+3V3", "*3V3")).toBe(true);
    expect(fnmatch("GND", "[!G]ND")).toBe(false);
    expect(fnmatch("a.b", "a?b")).toBe(true);
    expect(fnmatch("ab", "a.b")).toBe(false);
    expect(fnmatch("[x", "[x")).toBe(true);
    expect([...layerOf("Via [GND] on B.Cu - F.Cu")].sort()).toEqual(["B.Cu", "F.Cu"]);
    expect([...layerOf("Zone [GND] on In1.Cu")]).toEqual([]);
  });
});

describe("route pipeline pre-routing steps", () => {
  test("plan.planes (relative to the plan root) then plan.escape on the base board", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-base-"));
    await writeFile(join(dir, "b.kicad_pcb"), board(qfn() + fp("J1", 2, 5, [pad("1", 0, 0, 1, 1, "VIN")])));
    await writeFile(join(dir, "planes.json"), JSON.stringify({ layer: "In1.Cu", fill_net: "GND", nets: [{ net: "VIN" }] }));
    const acc = acceptance({ PWR_600: { track_width: 0.6, nets: ["VIN"] } });
    const log = await prepareRouteBase(dir, "b", acc, { planes: "planes.json", escape: { max_stub: 0.5 } }, dir);
    expect(log["planes"]).toMatchObject({ layer: "In1.Cu", zones: 2 });
    expect(log["escape"]).toMatchObject({ bridges: 1 });
    const text = await readFile(join(dir, "b.kicad_pcb"), "utf8");
    expect(kids(parseSexpr(text), "zone")).toHaveLength(2);
    expect(parseBoard(text).segments.length).toBe(3);
  });
});

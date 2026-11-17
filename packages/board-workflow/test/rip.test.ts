import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastmile as L, removeSpans, type Requirements } from "../src/index";
import * as R from "../src/lastmile/rip";
import { fpT, seg } from "./edit-fixture";

const tmp: string[] = [];
const mk = async () => {
  const d = await mkdtemp(join(tmpdir(), "rip-"));
  tmp.push(d);
  return d;
};
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const pads = (sig: string): Array<[string, string, number, number]> => [
  ["1", sig, 0, 0],
  ["2", "PWR", 0, 2],
  ["3", "DP", 0, 4],
  ["4", "DN", 0, 4.5],
];
const via = (x: number, y: number, net: string) => `\n\t(via (at ${x} ${y}) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "via-${x}-${y}"))`;
const BOARD = `(kicad_pcb (version 20261025) (generator "pcbnew") (generator_version "10.99")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	${fpT("A1", 10, 10, pads("SIG"))}
	${fpT("B1", 30, 10, pads("SIG"))}
	${fpT("G1", 20, 20, [["1", "GND", 0, 0]])}
	${seg(10, 10, 20, 10, "SIG")}
	${seg(20, 10, 30, 10, "SIG")}
	${seg(10, 12, 30, 12, "PWR")}
	${seg(10, 14, 30, 14, "DP")}
	${seg(10, 14.5, 16, 14.5, "DN")}
	${seg(16, 14.5, 16, 18, "DN")}
	${seg(16, 18, 24, 18, "DN")}
	${seg(24, 18, 24, 14.5, "DN")}
	${seg(24, 14.5, 30, 14.5, "DN")}
	${seg(20, 20, 20, 22, "GND")}${via(20, 22, "GND")}
)
`;

const ACC = {
  schema: "FABDESK_ACCEPTANCE_V1",
  stack_policy: { copper_layers: ["F.Cu", "B.Cu"], plane_layers: [], ground_net: "GND", via_spans: { through: ["F.Cu", "B.Cu"] } },
  net_classes: {
    tap_rule: "",
    tap_pads: {},
    neck_allowance: "1.0 mm",
    class_clearance: 0.1,
    router_width_rules: { neck_floor_mm: 0.1 },
    classes: {
      PWR_500: { source_class: "PWR", track_width: 0.5, inner_track_width: 0.3, nets: ["PWR"], current_max_A: 1 },
      USB90: { source_class: "USB", track_width: 0.2, diff_pair_width: 0.2, diff_pair_gap: 0.3, pairs: [["DP", "DN"]], coupling_applies_from_mm: 7.0 },
    },
  },
};
const req = { acceptance: ACC, circuit: { components: [], basis: "" }, mechanical: { units: "mm", anchors: [], basis: "" }, heights: { entries: [], basis: "" } } as unknown as Requirements;
const ctx = R.ripContext(req);

const item = (desc: string, x: number, y: number) => ({ description: desc, pos: { x, y } });
const drc = (o: { violations?: L.DrcRun["violations"]; opens?: Array<[string, number, number, number, number]> } = {}): L.DrcRun => ({
  violations: o.violations ?? [],
  unconnected: (o.opens ?? []).map(([net, x0, y0, x1, y1]) => ({ items: [item(`Pad 1 [${net}] of A1 on F.Cu`, x0, y0), item(`Pad 1 [${net}] of B1 on F.Cu`, x1, y1)] })),
  parity: 0,
});
const viol = (rule: string, ...items: Array<{ description: string; pos: { x: number; y: number } }>) => ({ rule, severity: "error", description: rule, items });
const acceptance = (failing: string[] = []) => ({ results: { A8_pairs: { pass: !failing.length, detail: Object.fromEntries(failing.map((n) => [n, {}])) } } });

const rip = (args: string[], d: L.DrcRun = drc(), failing: string[] = [], spareDrc?: L.DrcRun) =>
  R.ripBoard(BOARD, R.parseRipArgs(args), { drc: d, acceptance: acceptance(failing), ...(spareDrc ? { spareDrc } : {}) }, ctx);
const removedNets = (r: ReturnType<typeof rip>) => r.removedItems.map((i) => `${i.net}:${i.pts.flat().join(",")}`);

describe("parseRipArgs", () => {
  test("every rip_items option", () => {
    expect(R.parseRipArgs(["--around-opens", "1.0", "--spare-pairs"])).toEqual({ window: [], aroundOpens: 1, sparePairs: true });
    expect(R.parseRipArgs(["--a8", "short", "--around-ripped", "1.0", "--spare-pairs"])).toEqual({ window: [], a8: "short", aroundRipped: 1, sparePairs: true });
    expect(R.parseRipArgs(["--a8", "--a7"])).toEqual({ window: [], a8: "all", a7: true });
    expect(R.parseRipArgs(["--a8-uncoupled", "", "--rip-pad-stubs"])).toEqual({ window: [], a8Uncoupled: "", ripPadStubs: true });
    expect(R.parseRipArgs(["--a8-uncoupled"])).toEqual({ window: [], a8Uncoupled: "" });
    expect(R.parseRipArgs(["--window", "-1", "2", "3.5", "4", "--window", "0", "0", "1", "1", "--nets", "SIG*,!X", "--no-prune"])).toEqual({
      window: [[-1, 2, 3.5, 4], [0, 0, 1, 1]],
      nets: "SIG*,!X",
      noPrune: true,
    });
    expect(R.parseRipArgs(["--drc", L.SHORTS, "--spare-open-nets", "/x"])).toEqual({ window: [], drc: L.SHORTS, spareOpenNets: "/x" });
    expect(R.parseRipArgs(["--around-opens=2"])).toEqual({ window: [], aroundOpens: 2 });
  });
  test("refuses what argparse refuses", () => {
    expect(() => R.parseRipArgs(["--a8", "medium"])).toThrow(/invalid choice/);
    expect(() => R.parseRipArgs(["--window", "1", "2", "3"])).toThrow(/4 arguments/);
    expect(() => R.parseRipArgs(["--around-opens", "x"])).toThrow(/invalid float/);
    expect(() => R.parseRipArgs(["--drc"])).toThrow(/expected one argument/);
    expect(() => R.parseRipArgs(["--bogus"])).toThrow(/unrecognized/);
  });
});

describe("helpers", () => {
  test("fnmatch patterns with '!' exclusions", () => {
    expect(R.matchNets("SIG1", ["SIG*"])).toBe(true);
    expect(R.matchNets("SIG1", ["SIG*", "!SIG1"])).toBe(false);
    expect(R.matchNets("PWR", ["!SIG*"])).toBe(true);
    expect(R.matchNets("a.b", ["a?b"])).toBe(true);
    expect(R.matchNets("axb", ["a.b"])).toBe(false);
    expect(R.matchNets("c18::LCD_RX1+", ["c18::LCD_RX[0-9]+"])).toBe(true);
    expect(R.matchNets("A3", ["A[!0-2]"])).toBe(true);
    expect(R.matchNets("A1", ["A[!0-2]"])).toBe(false);
    expect(R.matchNets("anything", null)).toBe(true);
  });
  test("cutSpans is removeSpans in one pass", () => {
    const spans = R.ripItems(BOARD).filter((_, i) => i % 3 !== 1).map((i) => i.span);
    expect(R.cutSpans(BOARD, spans)).toBe(removeSpans(BOARD, spans));
    const t = "(a\n  (x 1)  \t(y 2) (z 3)\n\t(w 4))";
    const sp = [...["(x", "(y", "(w"].map((k) => ({ start: t.indexOf(k), end: t.indexOf(")", t.indexOf(k)) + 1 }))];
    expect(R.cutSpans(t, sp)).toBe(removeSpans(t, sp));
  });
  test("Python float repr", () => {
    expect(["1.0", "-2.5", "0.0", "1e-05", "123.456", "1e+16", "-0.0"]).toEqual([1, -2.5, 0, 0.00001, 123.456, 1e16, -0].map(R.pyFloatRepr));
  });
  test("items: segments, then vias, then arcs, with pts and layer", () => {
    const its = R.ripItems(BOARD);
    expect(its.length).toBe(11);
    expect(its.at(-1)).toMatchObject({ kind: "via", net: "GND", pts: [[20, 22]], layer: null, uuid: "via-20-22" });
    expect(its[0]).toMatchObject({ kind: "segment", net: "SIG", pts: [[10, 10], [20, 10]], layer: "F.Cu" });
  });
});

describe("selections", () => {
  test("--drc: every item named at a finding's position; reasons count each selection", () => {
    const d = drc({
      violations: [
        viol("shorting_items", item("Track [SIG] on F.Cu, length 10 mm", 20, 10), item("Track [PWR] on F.Cu, length 20 mm", 10, 12)),
        viol("clearance", item("Track [SIG] on F.Cu, length 10 mm", 20.001, 10)),
        viol("track_width", item("Track [DP] on F.Cu, length 20 mm", 10, 14)),
      ],
    });
    const r = rip(["--drc", L.SHORTS], d);
    expect(r.record.removed).toBe(3);
    expect(r.record.by_reason).toEqual({ shorting_items: 3, clearance: 2 });
    expect(r.record.nets).toEqual(["PWR", "SIG"]);
    expect(r.record.pruned).toBe(0);
    expect(R.ripItems(r.text).filter((i) => i.net === "SIG" || i.net === "PWR")).toEqual([]);
    expect(R.ripItems(r.text).filter((i) => i.net === "DP").length).toBe(1);
  });
  test("--drc --spare-pairs keeps the pair side; --spare-open-nets keeps the new route", () => {
    const d = drc({ violations: [viol("shorting_items", item("Track [DP] on F.Cu, length 20 mm", 30, 14), item("Track [SIG] on F.Cu, length 10 mm", 30, 10))] });
    expect(removedNets(rip(["--drc", L.SHORTS, "--spare-pairs"], d))).toEqual(["SIG:20,10,30,10"]);
    expect(removedNets(rip(["--drc", L.SHORTS], d)).sort()).toEqual(["DP:10,14,30,14", "SIG:20,10,30,10"]);
    const spare = drc({ opens: [["SIG", 10, 10, 30, 10]] });
    expect(removedNets(rip(["--drc", L.SHORTS, "--spare-open-nets", "start"], d, [], spare))).toEqual(["DP:10,14,30,14"]);
    expect(() => rip(["--drc", L.SHORTS, "--spare-open-nets", "start"], d)).toThrow(/DRC run/);
  });
  test("--drc: a via finding takes vias only, a track finding the item on its layer", () => {
    const d = drc({ violations: [viol("clearance", item("Via [GND] on F.Cu - B.Cu", 20, 22)), viol("clearance", item("Track [SIG] on B.Cu, length 10 mm", 20, 10))] });
    const r = rip(["--drc", "clearance"], d);
    expect(r.removedItems.map((i) => i.kind)).toEqual(["via"]);
    // GND has no zone here: the stub from the pad to the via now ends in the air and is pruned
    expect(r.record.pruned).toBe(1);
  });
  test("--a7: power segments below class width outside the neck allowance", () => {
    const r = rip(["--a7"]);
    expect(removedNets(r)).toEqual(["PWR:10,12,30,12"]);
    expect(r.record.by_reason).toEqual({ a7: 1 });
  });
  test("--a8 all / long / short and --around-ripped", () => {
    expect(rip(["--a8"], drc(), ["DP", "DN"]).record).toMatchObject({ removed: 6, by_reason: { a8: 6 }, nets: ["DN", "DP"], open_before: ["DN", "DP"] });
    expect(rip(["--a8", "long"], drc(), ["DP", "DN"]).record.removed).toBe(6);
    expect(rip(["--a8", "short"], drc(), ["DP", "DN"]).record).toMatchObject({ removed: 0, open_before: [] });
    const r = rip(["--a8", "long", "--around-ripped", "1.0", "--spare-pairs"], drc(), ["DP", "DN"]);
    expect(r.record.windows).toEqual([
      [9, 13.5, 11, 15.5],
      [29, 13.5, 31, 15.5],
      [9, 13, 11, 15],
      [29, 13, 31, 15],
    ]);
    expect(r.record.by_reason).toEqual({ a8: 6 }); // the windows round the pads hold only pair copper, which --spare-pairs keeps
    const r2 = rip(["--a8", "long", "--around-ripped", "2.6"], drc(), ["DP", "DN"]);
    expect(r2.record.by_reason).toEqual({ a8: 6, window: 4 }); // three pair items again (counted twice) and PWR (one end in a box)
    expect(r2.record.nets).toEqual(["DN", "DP", "PWR"]);
  });
  test("--a8-uncoupled cuts the uncoupled detour and keeps the stubs; the nets are not pruned", () => {
    const r = rip(["--a8-uncoupled", ""], drc(), ["DN"]);
    expect(removedNets(r)).toEqual(["DN:16,14.5,16,18", "DN:16,18,24,18", "DN:24,18,24,14.5"]);
    expect(r.record).toMatchObject({ removed: 3, pruned: 0, by_reason: { "a8-uncoupled": 3 }, open_before: ["DN", "DP"] });
    expect(rip(["--a8-uncoupled", "^X"], drc(), ["DN"]).record).toMatchObject({ removed: 0, open_before: [] });
    expect(rip(["--a8-uncoupled", "--rip-pad-stubs"], drc(), ["DN"]).record.removed).toBe(3);
  });
  test("--window and --around-opens: the ground net is never cut; dangling copper is pruned on the cut nets", () => {
    const W = ["--window", "15.9", "15", "24.1", "23", "--window", "19", "9", "21", "11"];
    const r = rip(W);
    expect(removedNets(r).sort()).toEqual(["DN:16,14.5,16,18", "DN:16,18,24,18", "DN:24,18,24,14.5", "SIG:10,10,20,10", "SIG:20,10,30,10"]);
    expect(r.record.pruned).toBe(2); // the two DN stubs left hanging; SIG has nothing left; GND (in the box) is not cut
    expect(rip([...W, "--no-prune"]).record.pruned).toBe(0);
    expect(rip([...W, "--spare-pairs"]).record.nets).toEqual(["SIG"]);
    expect(rip([...W, "--nets", "!SIG"]).record.nets).toEqual(["DN"]);
    const o = rip(["--around-opens", "0.5"], drc({ opens: [["SIG", 30, 10, 5, 5]] }));
    expect(removedNets(o)).toEqual(["SIG:20,10,30,10"]);
    expect(o.record).toMatchObject({ pruned: 1, open_before: ["SIG"], windows: [[29.5, 9.5, 30.5, 10.5], [4.5, 4.5, 5.5, 5.5]] });
  });
});

describe("rip.json and the step", () => {
  test("rip.json is Python's json.dumps(indent=1)", () => {
    const s = R.ripJson({ src: "/a/é", removed: 2, by_reason: { window: 2 }, pruned: 0, nets: ["A"], windows: [[1, 2.5, 3, 4]], open_before: [] });
    expect(s).toBe('{\n "src": "/a/\\u00e9",\n "removed": 2,\n "by_reason": {\n  "window": 2\n },\n "pruned": 0,\n "nets": [\n  "A"\n ],\n "windows": [\n  [\n   1.0,\n   2.5,\n   3.0,\n   4.0\n  ]\n ],\n "open_before": []\n}\n');
  });
  test("ripStep reads the scored folder and writes the copy, the board and rip.json", async () => {
    const cur = await mk();
    await writeFile(join(cur, "board.kicad_pcb"), BOARD);
    await writeFile(join(cur, "board.kicad_pro"), "{}");
    await expect(R.ripStep({ cur, out: join(cur, "..", "never"), pcb: "board.kicad_pcb", args: ["--a7"], req })).rejects.toThrow(/drc-run\.json is missing/);
    await mkdir(join(cur, ".lastmile"));
    await writeFile(join(cur, ".lastmile", "drc-run.json"), JSON.stringify(drc({ opens: [["SIG", 30, 10, 5, 5]] })));
    await expect(R.ripStep({ cur, out: join(cur, "..", "never"), pcb: "board.kicad_pcb", args: ["--a7"], req })).rejects.toThrow(/acceptance\.json is missing/);
    await writeFile(join(cur, ".lastmile", "acceptance.json"), JSON.stringify(acceptance()));
    const out = join(await mk(), "ripped");
    const rec = await R.ripStep({ cur, out, pcb: "board.kicad_pcb", args: ["--a7"], req });
    expect(rec).toEqual({ src: cur, removed: 1, by_reason: { a7: 1 }, pruned: 0, nets: ["PWR"], windows: [], open_before: ["SIG"] });
    expect((await readdir(out)).sort()).toEqual(["board.kicad_pcb", "board.kicad_pro", "rip.json"]);
    expect(JSON.parse(await readFile(join(out, "rip.json"), "utf8"))).toEqual(rec);
    expect(await readFile(join(out, "board.kicad_pcb"), "utf8")).not.toContain('(net "PWR") (uuid "sg-');
    await expect(R.ripStep({ cur, out, pcb: "board.kicad_pcb", args: ["--a7"], req })).rejects.toThrow(/exists/);
  });
});

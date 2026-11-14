/**
 * Pour splits (fabdesk): a router candidate whose new tracks cross the pour of a net it left open is named on the try
 * line and retried once with the layers in question kept out of reach (`~avoid`); the retry's layer option reaches the
 * expanded KRT arguments. The jetson reroute (2026-11-14) is the case: `opens` closed the 4 TPM nets and islanded a
 * /Power/USBPD2_HV pad; the plan that worked left In4.Cu out and put F/B at cost 10.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastmile as L, layout } from "../src/index";

const dirs: string[] = [];
const mk = async () => {
  const d = await mkdtemp(join(tmpdir(), "bw-pours-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const seg = (x0: number, y0: number, x1: number, y1: number, layer: string, net: string, u: string) =>
  `\n\t(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.2) (layer "${layer}") (net "${net}") (uuid "${u}"))`;
const zone = (net: string, layers: string, pts: Array<[number, number]>, extra = "") =>
  `\n\t(zone\n\t\t(net "${net}")\n\t\t(${layers})\n\t\t(uuid "z-${net}")${extra}\n\t\t(polygon\n\t\t\t(pts ${pts.map(([x, y]) => `(xy ${x} ${y})`).join(" ")})\n\t\t)\n\t\t(filled_polygon\n\t\t\t(layer "B.Cu")\n\t\t\t(pts (xy 900 900) (xy 901 900) (xy 901 901))\n\t\t)\n\t)`;
const sq = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * F.Cu, In1.Cu, In2.Cu, B.Cu. PWR pours B.Cu (0..20 x 0..10); PLANE pours In1.Cu, which carries 2 mm of track (plane-like);
 * BIG pours In2.Cu, a signal layer with 40 mm of track; a keepout covers everything. `;; open=` names the open nets for
 * the fake scorer.
 */
const board = (open: string, copper = "") =>
  `(kicad_pcb (version 20250114) ;; open=${open}\n\t(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))` +
  seg(-30, 40, 10, 40, "In2.Cu", "OTHER", "o1") +
  seg(-30, 41, -28, 41, "In1.Cu", "OTHER", "o2") +
  seg(0, 5, 3, 5, "B.Cu", "PWR", "p1") +
  zone("PWR", `layer "B.Cu"`, sq(0, 0, 20, 10)) +
  zone("PLANE", `layer "In1.Cu"`, sq(-10, -10, 30, 30)) +
  zone("BIG", `layer "In2.Cu"`, sq(-10, -10, 30, 30)) +
  zone("", `layers "F.Cu" "B.Cu"`, sq(-50, -50, 50, 50), `\n\t\t(keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))`) +
  copper +
  "\n)\n";

describe("pours", () => {
  test("boardPours reads zones with a net (outline, not fill; keepouts left out; *.Cu and legacy net_name)", () => {
    const pours = L.boardPours(board("SIG"), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
    expect(pours.map((p) => [p.net, p.layers])).toEqual([
      ["PWR", ["B.Cu"]],
      ["PLANE", ["In1.Cu"]],
      ["BIG", ["In2.Cu"]],
    ]);
    expect(pours[0]!.outlines).toEqual([sq(0, 0, 20, 10)]);
    expect(pours[0]!.box).toEqual([0, 0, 20, 10]);
    const legacy = `(kicad_pcb\n\t(zone (net 3) (net_name "GND") (layers *.Cu) (uuid "u") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))\n)`;
    expect(L.boardPours(legacy, ["F.Cu", "B.Cu"]).map((p) => [p.net, p.layers])).toEqual([["GND", ["F.Cu", "B.Cu"]]]);
  });

  test("pourSplits: a fresh open whose pour another net's new track crosses, with the layers; not its own copper, not a miss", () => {
    const pours = L.boardPours(board("SIG"), ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
    const tracks = L.tracksOf([
      `(segment (start 5 -5) (end 5 15) (width 0.2) (layer "B.Cu") (net "SIG") (uuid "a"))`, // crosses PWR's outline, no end inside
      `(segment (start 6 6) (end 7 6) (width 0.2) (layer "B.Cu") (net "PWR") (uuid "b"))`, // PWR's own
      `(segment (start 30 30) (end 31 31) (width 0.2) (layer "B.Cu") (net "SIG") (uuid "c"))`, // outside
      `(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "d"))`, // F.Cu: PWR has no pour there
      `(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "v"))`, // vias are not tracks
    ]);
    expect(tracks).toHaveLength(4);
    expect(L.pourSplits(pours, tracks, ["PWR", "NOPOUR"])).toEqual([{ net: "PWR", layers: ["B.Cu"] }]);
    expect(L.pourSplits(pours, tracks.slice(1), ["PWR"])).toEqual([]);
    expect(L.splitLine([{ net: "/Power/USBPD2_HV", layers: ["B.Cu"] }, { net: "+5V", layers: ["In4.Cu"] }])).toBe("split a pour: /Power/USBPD2_HV on B.Cu; +5V on In4.Cu");
  });

  test("avoidLayersFor: the split layers, outer layers with pours near the new tracks, plane-like inner ones; routingLayers limits it", () => {
    const text = board("SIG");
    const copper = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];
    const pours = L.boardPours(text, copper);
    const trackLength = L.trackLengthByLayer(L.tracksOf(layout.copperItems(text, ["segment"]).map(({ span }) => text.slice(...span))));
    expect(trackLength.get("In2.Cu")).toBe(40);
    const newTracks = L.tracksOf([`(segment (start 5 -5) (end 5 15) (width 0.2) (layer "B.Cu") (net "SIG") (uuid "a"))`]);
    const o = { splits: [{ net: "PWR", layers: ["B.Cu"] }], pours, newTracks, trackLength, openBefore: new Set(["SIG"]), copperLayers: copper };
    // In1.Cu: PLANE's pour and 2 mm of track against In2.Cu's 40 (under a quarter); In2.Cu: a pour too, but a signal layer
    expect(L.avoidLayersFor(o)).toEqual(["In1.Cu", "B.Cu"]);
    expect(L.avoidLayersFor({ ...o, routingLayers: ["F.Cu", "In2.Cu", "B.Cu"] })).toEqual(["B.Cu"]);
    // a pour of a net that is open on the start board is not one to keep whole
    expect(L.avoidLayersFor({ ...o, openBefore: new Set(["SIG", "PLANE"]) })).toEqual(["B.Cu"]);
  });

  test("avoidLayerArgs: inner left out with its cost, outer costed (at least 10), a stage keeps an inner layer, no --layers unchanged", () => {
    const opens = ["--layers", "F.Cu", "In2.Cu", "In4.Cu", "In5.Cu", "In7.Cu", "B.Cu", "--neckdown-length", "0.9", "--grid-step", "0.05", "--keep-input-copper", "--nets", "@open-before"];
    // jetson: the agent's tpm-preserve-planes.json, from the expanded `opens` stage
    const r = layout.avoidLayerArgs(opens, ["F.Cu", "In4.Cu", "B.Cu"]);
    expect(r.args).toEqual(["--layers", "F.Cu", "In2.Cu", "In5.Cu", "In7.Cu", "B.Cu", "--layer-costs", "10", "1", "1", "1", "10", "--neckdown-length", "0.9", "--grid-step", "0.05", "--keep-input-copper", "--nets", "@open-before"]);
    expect([r.removed, r.costed]).toEqual([["In4.Cu"], ["F.Cu", "B.Cu"]]);
    // an existing cost list is edited in place; a higher cost stays, a forbidden (negative) one too
    const pairs = ["--nets", "@pairs=USB", "--layers", "F.Cu", "In2.Cu", "In5.Cu", "B.Cu", "--layer-costs", "20", "1", "-1", "5", "--track-width", "0.2"];
    expect(layout.avoidLayerArgs(pairs, ["F.Cu", "In2.Cu", "B.Cu", "In5.Cu"]).args).toEqual(
      // every inner layer avoided: costed instead of left out (a stage keeps an inner layer)
      ["--nets", "@pairs=USB", "--layers", "F.Cu", "In2.Cu", "In5.Cu", "B.Cu", "--layer-costs", "20", "10", "-1", "10", "--track-width", "0.2"],
    );
    expect(layout.avoidLayerArgs(pairs, ["In2.Cu"]).args).toEqual(["--nets", "@pairs=USB", "--layers", "F.Cu", "In5.Cu", "B.Cu", "--layer-costs", "20", "-1", "5", "--track-width", "0.2"]);
    expect(layout.avoidLayerArgs(["--nets", "*"], ["B.Cu"]).args).toEqual(["--nets", "*"]);
    expect(layout.avoidLayerArgs(opens, ["In3.Cu"]).args).toEqual(opens); // a layer the stage does not route on
  });
});

/** Open nets named by `;; open=A,B` in the board file. */
const scorer: L.Scorer = {
  async score(dir, pcb) {
    const text = await readFile(join(dir, pcb), "utf8");
    const nets = (/;; open=([^\s]*)/.exec(text)?.[1] ?? "").split(",").filter(Boolean);
    return {
      figures: { open: nets.length, drc: {}, a7: 0, a7_mm: 0, a8: 0, pairs_todo: 0, pairs: {} },
      opens: nets.map((net) => ({ net, a: [0, 0], b: [1, 1] })),
      summary: {},
      pairsOverSkewLimit: 0,
      parityChecked: false,
      a8: { toReroute: [], failing: [] },
    };
  },
};

/** `opens` crosses PWR's pour on B.Cu and leaves PWR open; its retry (avoidLayers set) routes on In2.Cu. */
function engine(o: { split: string; retry: string; seen: L.Step[] }): L.StepEngine {
  return {
    async run(step, input) {
      o.seen.push(step);
      await mkdir(input.out, { recursive: true });
      await writeFile(join(input.out, input.pcb), step.avoidLayers ? o.retry : o.split);
      return { dir: input.out };
    },
  };
}

async function project(text: string) {
  const d = await mk();
  await writeFile(join(d, "board.kicad_pcb"), text);
  await writeFile(join(d, "board.kicad_pro"), "{}");
  return d;
}

const CROSS = seg(5, -5, 5, 15, "B.Cu", "SIG", "n1");
const INNER = seg(5, -5, 5, 15, "In2.Cu", "SIG", "n2");

describe("bench: a candidate that splits a pour", () => {
  test("is named on its line and retried with the layers kept out of reach; the retry passes on its own and is accepted", async () => {
    const src = await project(board("SIG"));
    const seen: L.Step[] = [];
    const { bench } = await L.Bench.create(join(await mk(), "ws"), src, "board.kicad_pcb", { scorer, engine: engine({ split: board("PWR", CROSS), retry: board("", INNER), seen }), availableGiB: async () => 30 });
    const r = await bench.try(["opens"]);
    const by = Object.fromEntries(r.candidates.map((c) => [c.name, c]));
    expect(Object.keys(by)).toEqual(["opens~avoid:In1.Cu,B.Cu", "opens"]);
    expect(by["opens"]!.pourSplits).toEqual([{ net: "PWR", layers: ["B.Cu"] }]);
    expect(by["opens~avoid:In1.Cu,B.Cu"]!.avoidFrom).toEqual({ name: "opens", layers: ["In1.Cu", "B.Cu"] });
    expect(by["opens~avoid:In1.Cu,B.Cu"]!.pourSplits).toEqual([]);
    // the retry is the same step with the option set
    expect(seen.map((s) => [s.planName, s.avoidLayers ?? null])).toEqual([
      ["finish-opens", null],
      ["finish-opens", ["In1.Cu", "B.Cu"]],
    ]);
    const text = r.lines.join("\n");
    expect(text).toContain("NEW open PWR; split a pour: PWR on B.Cu");
    expect(text).toContain("retry of opens with In1.Cu, B.Cu kept out of reach");
    expect(r.accepted).toBe("opens~avoid:In1.Cu,B.Cu");
    expect(bench.figures.open).toBe(0);
    expect(bench.state.log!.at(-1)!.results.find((x) => x.name === "opens")!["pour_splits"]).toEqual([{ net: "PWR", layers: ["B.Cu"] }]);
  });

  test("passing candidates that split a pour rank after those that split none, even with fewer opens; alone, one is still accepted", async () => {
    const start = board("SIG,A,B");
    // the router closes all three and islands PWR (open 1); the retry closes SIG only (open 2) and splits nothing
    const split = board("PWR", CROSS);
    const retry = board("A,B", INNER);
    const src = await project(start);
    const { bench } = await L.Bench.create(join(await mk(), "ws"), src, "board.kicad_pcb", { scorer, engine: engine({ split, retry, seen: [] }), availableGiB: async () => 30 });
    const r = await bench.try(["opens"]);
    expect(r.accepted).toBe("opens~avoid:In1.Cu,B.Cu");
    expect(bench.figures.open).toBe(2);
    expect(r.lines.find((l) => l.trimStart().startsWith("opens "))).toContain("passes gate (ranked after those that split no pour)");
    // noAvoid: no retry; the split candidate is the only one that passes, and the toolkit's gate takes it
    const src2 = await project(start);
    const { bench: b2 } = await L.Bench.create(join(await mk(), "ws"), src2, "board.kicad_pcb", { scorer, engine: engine({ split, retry, seen: [] }), availableGiB: async () => 30 });
    const r2 = await b2.try(["opens"], { noAvoid: true });
    expect(r2.candidates.map((c) => c.name)).toEqual(["opens"]);
    expect(r2.accepted).toBe("opens");
    expect(r2.lines.join("\n")).toContain("split a pour: PWR on B.Cu");
  });

  test("a fill candidate's split is named but not retried (another router has no layer option); a NEW open without a pour is no split", async () => {
    const seen: L.Step[] = [];
    const src = await project(board("SIG"));
    const { bench } = await L.Bench.create(join(await mk(), "ws"), src, "board.kicad_pcb", { scorer, engine: engine({ split: board("PWR", CROSS), retry: "", seen }), availableGiB: async () => 30 });
    const r = await bench.try(["fill:freerouting"], { noAccept: true });
    expect(r.candidates.map((c) => c.name)).toEqual(["fill:freerouting"]);
    expect(r.candidates[0]!.pourSplits).toEqual([{ net: "PWR", layers: ["B.Cu"] }]);
    // OTHER has no pour: a fresh open, not a split, and no retry
    const src2 = await project(board("SIG"));
    const { bench: b2 } = await L.Bench.create(join(await mk(), "ws"), src2, "board.kicad_pcb", { scorer, engine: engine({ split: board("OTHER", CROSS), retry: "", seen: [] }), availableGiB: async () => 30 });
    const r2 = await b2.try(["opens"], { noAccept: true });
    expect(r2.candidates.map((c) => c.name)).toEqual(["opens"]);
    expect(r2.candidates[0]!.pourSplits).toEqual([]);
    expect(r2.lines.join("\n")).toContain("NEW open OTHER");
    expect(r2.lines.join("\n")).not.toContain("split a pour");
  });
});

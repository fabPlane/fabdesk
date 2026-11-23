import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoard, type Requirements } from "../src/index";
import { cutCopper, fitStep, groundNet, NudgeError, nudgeContext, nudgeStep, planNudge, seatParts, type NudgeBoardContext } from "../src/lastmile/nudge";
import { fpT, seg } from "./edit-fixture";

const tmp: string[] = [];
const mk = async () => {
  const d = await mkdtemp(join(tmpdir(), "nudge-"));
  tmp.push(d);
  return d;
};
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const keepout = (x0: number, y0: number, x1: number, y1: number, footprints: "allowed" | "not_allowed", name = "KO") => `
	(zone (layer "F.Cu") (uuid "ko-${name}") (name "${name}") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)
		(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints ${footprints}))
		(placement (enabled no) (sheetname ""))
		(polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`;
const via = (x: number, y: number, net: string) => `\n\t(via (at ${x} ${y}) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "v-${x}-${y}"))`;
const tht = (ref: string, x: number, y: number) => `
	(footprint "Lib:TP" (layer "F.Cu") (uuid "fp-${ref}") (transform (translate ${x} ${y}) (rotate 0) (scale 1 1))
		(property "Reference" "${ref}" (at 0 -1 0) (layer "F.SilkS") (uuid "pr-${ref}"))
		(pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 1) (layers "*.Cu") (net "MECH") (uuid "pad-${ref}")))`;

const board = (extra = "") => `(kicad_pcb (version 20261025) (generator "pcbnew") (generator_version "10.99")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
	${fpT("J1", 5, 5, [["1", "VIN", 0, 0], ["2", "GND", 1.5, 0]], { box: [-1, -1, 3, 1] })}
	${fpT("U1", 30, 20, [["1", "VIN", -1, 0], ["2", "SIG", 1, 0], ["3", "GND", 0, 1]], { box: [-2, -2, 2, 2] })}
	${fpT("R1", 20, 10, [["1", "SIG", -0.5, 0], ["2", "DP", 0.5, 0]])}
	${fpT("R2", 20, 14, [["1", "DN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C1", 40, 10, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("B1", 40, 30, [["1", "SIG", -0.5, 0], ["2", "GND", 0.5, 0]], { side: "B" })}
	${seg(19.5, 10, 10, 10, "SIG")}
	${seg(10, 10, 10, 20, "SIG")}
	${seg(20.5, 10, 25, 10, "DP")}
	${seg(19.5, 14, 25, 14, "DN")}
	${seg(25, 14, 26, 15, "DN")}
	${seg(39.5, 10, 31, 19, "VIN")}${extra}
)`;

const req = (o: { anchors?: string[]; pairs?: Array<[string, string]>; ground?: string; schema?: string } = {}) =>
  ({
    acceptance: {
      schema: o.schema ?? "FLOW_ACCEPTANCE_V1",
      stack_policy: o.ground === undefined ? {} : { ground_net: o.ground },
      net_classes: { classes: { USB: { pairs: o.pairs ?? [["DP", "DN"]] }, PWR_X: { nets: ["VIN"] } } },
    },
    mechanical: { anchors: (o.anchors ?? ["J1"]).map((reference) => ({ reference, at: ["0", "0"], rotation: ["0"], layer: "F.Cu" })) },
  }) as unknown as Requirements;

const ctx = (r = req({ ground: "GND" })): NudgeBoardContext => nudgeContext(r);

describe("nudge context from the requirements", () => {
  test("ground net: stack policy, else IO_GND for the C6 schema, else GND", () => {
    expect(groundNet(req({ ground: "AGND" }).acceptance)).toBe("AGND");
    expect(groundNet(req({ schema: "C6_ACCEPTANCE_V1" }).acceptance)).toBe("IO_GND");
    expect(groundNet(req().acceptance)).toBe("GND");
  });
  test("fixed parts are the mechanical anchors; pairs from the net classes", () => {
    const c = ctx();
    expect(c.fixed("J1")).toBe(true);
    expect(c.fixed("R1")).toBe(false);
    expect(c.pairs).toEqual([["DP", "DN"]]);
  });
});

describe("pose search", () => {
  test("a free point is taken as is (ring 0), record as the toolkit", () => {
    const r = seatParts(board(), { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [15, 30], radius: 2.5 }] }, ctx());
    expect(r.moves).toEqual([{ ref: "R1", from: [20, 10, 0], to: [15, 30, 0], mate_distance_mm: r.moves[0]!.mate_distance_mm }]);
    expect(parseBoard(r.text).footprints.get("R1")).toMatchObject({ x: 15, y: 30, rot: 0 });
    // mate cost: R1.1 (SIG) to the nearest other SIG pad, R1.2 (DP) has no mate
    const sig = Math.min(Math.hypot(14.5 - 31, 30 - 20), Math.hypot(14.5 - 39.5, 0));
    expect(r.moves[0]!.mate_distance_mm).toBeCloseTo(sig, 2);
  });
  test("an occupied target: the first ring with a legal pose, clear of the neighbour by the clearance", () => {
    const r = seatParts(board(), { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: "C1", radius: 4 }] }, ctx());
    const [x, y] = r.moves[0]!.to;
    const d = Math.hypot(x - 40, y - 10);
    // C1 courtyard [-1,1]x[-0.6,0.6]; R1 the same: legal from 2.2 mm in x or 1.4 mm in y
    expect(d).toBeGreaterThanOrEqual(1.4 - 1e-9);
    expect(d).toBeLessThan(1.6);
    expect(Math.abs(y - 10) >= 1.4 - 1e-9 || Math.abs(x - 40) >= 2.2 - 1e-9).toBe(true);
  });
  test("REF.PAD target, and B-side parts do not block an F-side part", () => {
    const r = seatParts(board(), { moves: [{ ref: "R1", near: "B1.1", radius: 1 }] }, ctx());
    expect(r.moves[0]!.to).toEqual([39.5, 30, 0]);
  });
  test("rotations: the one with the shorter pad-to-mate distance wins", () => {
    // R1 next to U1 at (30, 24): pin 1 (SIG) wants to be near U1.2 (31, 20)
    const r = seatParts(board(), { moves: [{ ref: "R1", near: [31, 25], radius: 1, rotations: [0, 90, 180, 270] }] }, ctx());
    expect(r.moves[0]!.to[2]).toBe(270); // pin 1 at local (-0.5, 0) -> (0, -0.5) world: toward U1
  });
  test("a fixed part is refused; an unknown part is named", () => {
    expect(() => seatParts(board(), { moves: [{ ref: "J1", near: [30, 30] }] }, ctx())).toThrow("J1: fixed part, not movable");
    expect(() => seatParts(board(), { moves: [{ ref: "X9", near: [30, 30] }] }, ctx())).toThrow("X9: not on the board");
  });
  test("a blocking keepout refuses with what is in the way; an allow-all rule area blocks nothing", () => {
    const ko = keepout(10, 25, 20, 35, "not_allowed");
    expect(() => seatParts(board(ko), { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [15, 30], radius: 2.5 }] }, ctx())).toThrow(
      "R1: no legal pose within 2.5 mm of the target; at the target (courtyard 2.00 x 1.20 mm, gap 0.2) it hits: keepout",
    );
    const r = seatParts(board(keepout(10, 25, 20, 35, "allowed", "BENCH X landing")), { moves: [{ ref: "R1", near: [15, 30], radius: 2.5 }] }, ctx());
    expect(r.moves[0]!.to).toEqual([15, 30, 0]);
  });
  test("drilled pads and the outline edge block; the refusal lists them sorted", () => {
    const b = board(tht("H1", 3, 30));
    expect(() => seatParts(b, { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [3, 30], radius: 0.2 }] }, ctx())).toThrow("it hits: H1, drilled pad");
    expect(() => seatParts(b, { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [0.5, 10], radius: 0.2 }] }, ctx())).toThrow("it hits: outline/edge");
  });
  test("a later move sees an earlier move's new box", () => {
    const r = seatParts(board(), { moves: [{ ref: "R1", near: [15, 30], radius: 2 }, { ref: "R2", near: [15, 30], radius: 3 }] }, ctx());
    expect(r.moves[0]!.to).toEqual([15, 30, 0]);
    expect(r.moves[1]!.to).not.toEqual([15, 30, 0]);
  });
});

describe("copper", () => {
  test("old-pad copper cut, a cut pair goes whole, dangling copper of cut nets pruned", () => {
    const p = planNudge(board(), { moves: [{ ref: "R1", near: [15, 30], radius: 2 }] }, ctx());
    // SIG (19.5,10)-(10,10) and DP (20.5,10)-(25,10) touch the old pads; DN goes with DP (pair); (10,10)-(10,20) dangles
    expect(p.removed).toBe(4);
    expect(p.pruned).toBe(1);
    expect(p.cut_nets).toEqual(["DN", "DP", "SIG"]);
    const b = parseBoard(p.text);
    expect(b.segments.map((s) => s.net)).toEqual(["VIN"]);
  });
  test("other-net copper under the new pads is cut; same-net copper stays", () => {
    const base = board(via(15.5, 30, "GND") + via(14.5, 30, "SIG") + seg(14.5, 30, 14.5, 33, "SIG"));
    const seat = seatParts(base, { moves: [{ ref: "R1", near: [15, 30], radius: 1 }] }, ctx(req({ ground: "GND", pairs: [] })));
    const cu = cutCopper(seat.text, seat.ripBoxes, seat.newPads, []);
    expect(cu.cut_nets).toEqual(["DP", "GND", "SIG"]);
    const vias = parseBoard(cu.text).vias;
    expect(vias.map((v) => [v.x, v.net])).toEqual([[14.5, "SIG"]]);
  });
});

describe("steps", () => {
  const project = async (text: string) => {
    const cur = await mk();
    await writeFile(join(cur, "b.kicad_pcb"), text);
    await writeFile(join(cur, "b.kicad_pro"), "{}");
    await writeFile(join(cur, "score.json"), "{}");
    return cur;
  };
  const clean = async () => [];
  test("nudgeStep writes the folder and nudge.json with the toolkit's fields", async () => {
    const cur = await project(board());
    const out = join(await mk(), "s1");
    const seen: string[] = [];
    const rec = await nudgeStep({
      cur,
      out,
      pcb: "b.kicad_pcb",
      moves: { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [15, 30], radius: 2.5 }] },
      req: req({ ground: "GND" }),
      courtyardDrc: async (b, r) => (seen.push(b, r), [{ rule: "clearance", items: [] }]),
    });
    expect(Object.keys(rec)).toEqual(["moves", "removed", "pruned", "native_courtyard", "cut_nets"]);
    expect(rec.native_courtyard).toEqual({});
    expect(JSON.parse(await readFile(join(out, "nudge.json"), "utf8"))).toEqual(rec);
    expect(JSON.parse(await readFile(join(out, "moves.json"), "utf8")).moves[0].ref).toBe("R1");
    expect(seen).toEqual([join(out, "b.kicad_pcb"), join(out, "placement-drc.json")]);
    expect(parseBoard(await readFile(join(out, "b.kicad_pcb"), "utf8")).footprints.get("R1")).toMatchObject({ x: 15, y: 30 });
    await expect(readFile(join(out, "score.json"), "utf8")).rejects.toThrow();
    await expect(nudgeStep({ cur, out, pcb: "b.kicad_pcb", moves: { moves: [] }, req: req(), courtyardDrc: clean })).rejects.toThrow(`${out} exists`);
  });
  test("a failed courtyard gate throws the toolkit's message after writing the record", async () => {
    const cur = await project(board());
    const out = join(await mk(), "s1");
    const drc = async () => [
      { rule: "courtyards_overlap", items: [{ description: "Footprint R1" }] },
      { rule: "pth_inside_courtyard", items: [] },
      { rule: "courtyards_overlap", items: [] },
    ];
    const err = await nudgeStep({ cur, out, pcb: "b.kicad_pcb", moves: { moves: [{ ref: "R1", near: [15, 30] }] }, req: req(), courtyardDrc: drc }).catch((e) => e);
    expect(err).toBeInstanceOf(NudgeError);
    expect(err.message).toBe("courtyard gate failed: {'courtyards_overlap': 2, 'pth_inside_courtyard': 1}");
    expect(err.record.native_courtyard).toEqual({ courtyards_overlap: 2, pth_inside_courtyard: 1 });
    expect(JSON.parse(await readFile(join(out, "nudge.json"), "utf8")).native_courtyard).toEqual({ courtyards_overlap: 2, pth_inside_courtyard: 1 });
  });
  test("a refused move writes nothing", async () => {
    const cur = await project(board());
    const out = join(await mk(), "s1");
    await expect(nudgeStep({ cur, out, pcb: "b.kicad_pcb", moves: { moves: [{ ref: "J1", near: [15, 30] }] }, req: req(), courtyardDrc: clean })).rejects.toThrow("J1: fixed part, not movable");
    await expect(readFile(join(out, "b.kicad_pcb"))).rejects.toThrow();
  });
  test("fitStep: poses, copper line, window picture; NO FIT names the blocker", async () => {
    const cur = await project(board(keepout(10, 25, 20, 35, "not_allowed")));
    const out = join(await mk(), "fit");
    await mkdir(out);
    await writeFile(join(out, "stale"), "x");
    const ok = await fitStep({
      cur,
      out,
      pcb: "b.kicad_pcb",
      moves: { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [25, 30], radius: 2.5, rotations: [90] }] },
      req: req({ ground: "GND" }),
      courtyardDrc: clean,
      render: async () => new Uint8Array([137, 80, 78, 71]),
    });
    expect(ok.fit).toBe(true);
    expect(ok.lines[0]).toBe("  R1             20.00   10.00     0  ->    25.00   30.00    90   mate " + ok.record!.moves[0]!.mate_distance_mm + " mm");
    expect(ok.lines[1]).toBe("  copper removed 4, cut pairs/nets 3, native courtyard clean");
    expect(ok.box).toEqual([16, 6, 29, 34]);
    expect(ok.png).toBe(join(out, "fit.png"));
    expect(await readFile(join(out, "fit.svg"), "utf8")).toContain(">R1<");
    await expect(readFile(join(out, "stale"))).rejects.toThrow();
    const no = await fitStep({ cur, out, pcb: "b.kicad_pcb", moves: { clearance: 0.2, edge: 0.4, moves: [{ ref: "R1", near: [15, 30], radius: 2.5 }] }, req: req(), courtyardDrc: clean });
    expect(no.fit).toBe(false);
    expect(no.lines).toEqual(["NO FIT: R1: no legal pose within 2.5 mm of the target; at the target (courtyard 2.00 x 1.20 mm, gap 0.2) it hits: keepout"]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastmile as L, parseBoard, type Requirements } from "../src/index";
import * as P from "../src/lastmile/pairops";

const tmp: string[] = [];
const mk = async () => {
  const d = await mkdtemp(join(tmpdir(), "pairops-"));
  tmp.push(d);
  return d;
};
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const stack = ["F.Cu", "B.Cu"];
const req = {
  acceptance: {
    stack_policy: { copper_layers: stack, plane_layers: [], ground_net: "GND", via_spans: { through: ["F.Cu", "B.Cu"] } },
    net_classes: {
      classes: {
        USB: { diff_pair_width: 0.15, diff_pair_gap: 0.2, pairs: [["P", "N"]], neck_min_width_ratio: 1.0, intra_pair_skew_max_mm: 0.5, min_coupled_share: 0.5, coupling_applies_from_mm: 100 },
        PWR5V: { track_width: 0.5, nets: ["+5V"] },
      },
    },
  },
} as unknown as Requirements;
const pairs = L.classesAndPairs(req);
const pr = pairs[0]!;

let uid = 0;
const id = () => `00000000-0000-4000-8000-${String(++uid).padStart(12, "0")}`;
const seg = (a: [number, number], b: [number, number], net: string, layer = "F.Cu", w = 0.15) =>
  `\t(segment (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (width ${w}) (layer "${layer}") (net "${net}") (uuid "${id()}"))`;
const via = (x: number, y: number, net: string, size = 0.4) => `\t(via (at ${x} ${y}) (size ${size}) (drill 0.2) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "${id()}"))`;
const pad = (n: string, x: number, y: number, net: string) => `(pad "${n}" smd rect (at ${x} ${y}) (size 0.3 0.3) (layers "F.Cu") (net "${net}"))`;
const boardText = (parts: string[], pads: string[] = []) =>
  `(kicad_pcb (version 20250114)\n\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal))\n\t(footprint "L:U1" (layer "F.Cu") (at 0 0) (property "Reference" "U1") (property "Value" "x") ${pads.join(" ")})\n${parts.join("\n")}\n)\n`;

const clean: L.DrcFn = async () => ({ violations: [], unconnected: [], parity: 0 });
async function ctxFor(text: string, drc: L.DrcFn = clean, base = new Set<string>()): Promise<P.PassCtx> {
  const dir = await mk();
  const boardFile = join(dir, "board.kicad_pcb");
  await writeFile(boardFile, text);
  return { boardFile, outDir: join(dir, "drc"), base, rounds: 12, drc, signal: new AbortController().signal, req, stack, ground: "GND" };
}
const lenOf = (text: string, net: string) => P.readSegments(text).filter((s) => s.net === net).reduce((t, s) => t + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), 0);

describe("pair ops: text helpers", () => {
  test("readVias: position, net, size, layers as written, span", () => {
    const t = boardText([via(5, 1, "P", 0.45)]);
    const [v] = P.readVias(t);
    expect(v).toMatchObject({ xy: [5, 1], net: "P", size: 0.45, layers: ["F.Cu", "B.Cu"] });
    expect(t.slice(v!.span[0], v!.span[1]).startsWith("(via (at 5 1)")).toBe(true);
  });
  test("offsetPoly mitres corners, project and cutPoly walk the polyline", () => {
    const off = P.offsetPoly([[0, 0], [5, 0], [5, 0], [10, 0], [10, 5]], 1);
    expect(off).toEqual([[0, 1], [9, 1], [9, 5]]);
    const [s, q] = P.project(off, [4, 3]);
    expect(s).toBeCloseTo(4);
    expect(q).toEqual([4, 1]);
    expect(P.cutPoly(off, 2, 11)).toEqual([[2, 1], [9, 1], [9, 3]]);
  });
});

describe("pair ops: vias", () => {
  // P via at (5,0), N via 1.0 mm away; pitch = max(w + gap, size + gap + 0.01) = 0.61
  const T = boardText([seg([0, 0], [5, 0], "P"), seg([0, 1], [5, 1], "N"), via(5, 0, "P"), via(5, 1, "N")]);
  const text = () => T;
  test("options: both, N only, P only; N never moves (the oracle's sign quirk)", () => {
    const t = text();
    const segs = P.readSegments(t);
    const m = parseBoard(t);
    const work = P.viaOptions(segs, P.readVias(t), pr, new P.SoftGrid(segs, m.pads, m.vias, stack), stack);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ pair: "P", d: 1, pitch: 0.61 });
    expect(work[0]!.opts.map((o) => o.mode)).toEqual(["both", "N only", "P only"]);
    expect(work[0]!.opts.map((o) => o.moves.map((x) => [x.v.net, Number(x.q[1].toFixed(6))]))).toEqual([[["P", 0.195]], [], [["P", 0.39]]]);
  });
  test("pass: the via moves, the segment on it is stretched; DRC refusal falls to the next option", async () => {
    const ctx = await ctxFor(text());
    const r = await P.viasPass(text(), pairs, ctx);
    expect(r.rep["applied"]).toEqual([{ pair: "P", d: 1, pitch: 0.61, mode: "both" }]);
    expect(r.text).toContain("(via (at 5 0.195)");
    expect(r.text).toContain("(end 5 0.195)");
    expect(await readFile(ctx.boardFile, "utf8")).toBe(r.text);
    let n = 0;
    const refuseFirst: L.DrcFn = async () => (n++ === 0 ? { violations: [{ rule: "clearance", severity: "error", description: "x", items: [{ description: "Via [P]", pos: { x: 5, y: 0.2 } }] }], unconnected: [], parity: 0 } : { violations: [], unconnected: [], parity: 0 });
    const r2 = await P.viasPass(text(), pairs, await ctxFor(text(), refuseFirst));
    expect(r2.rep["applied"]).toEqual([{ pair: "P", d: 1, pitch: 0.61, mode: "N only" }]);
    expect(r2.rep["rounds"]).toEqual([{ round: 1, active: 1, new_items: 1 }, { round: 2, active: 1, new_items: 0 }]);
    expect(r2.text).toBe(text()); // N only moves nothing: the board as it was
  });
});

describe("pair ops: mirror", () => {
  // P and N between the same two pad areas, 0.9 mm apart (uncoupled): N is rebuilt along P at 0.352
  const pads = [pad("1", 0, 0, "P"), pad("2", 10, 0, "P"), pad("3", 0, 0.9, "N"), pad("4", 10, 0.9, "N")];
  const text = (extra: string[] = []) => boardText([seg([0, 0], [10, 0], "P"), seg([0, 0.9], [10, 0.9], "N"), ...extra], pads);
  test("netChains: one chain per net between fixed ends", () => {
    const t = text();
    const m = parseBoard(t);
    const ch = P.netChains(P.readSegments(t), m.pads, m.vias, "N", stack);
    expect(ch).toHaveLength(1);
    expect(ch[0]!.verts).toEqual([[0, 0.9], [10, 0.9]]);
  });
  test("options: N follows P at the class spacing (trimmed back from P's pads), else P follows N", () => {
    const t = text();
    const segs = P.readSegments(t);
    const m = parseBoard(t);
    const why: string[] = [];
    const w = P.mirrorOptions(segs, m.pads, m.vias, pr, new P.SoftGrid(segs, m.pads, m.vias, stack), stack, why);
    expect(w).toHaveLength(1);
    expect(w[0]!.opts.map((o) => o.follower)).toEqual(["N", "P"]);
    const v = w[0]!.opts[0]!.verts;
    expect(v[0]).toEqual([0, 0.9]);
    expect(v[v.length - 1]).toEqual([10, 0.9]);
    for (const q of v.slice(1, -1)) expect(q[1]).toBeCloseTo(0.352, 6);
  });
  test("a signal track in the way refuses the path; mirror-force may cross it (soft nets)", () => {
    const t = text([seg([5, -1], [5, 0.6], "SIG")]);
    const segs = P.readSegments(t);
    const m = parseBoard(t);
    const grid = new P.SoftGrid(segs, m.pads, m.vias, stack);
    const why: string[] = [];
    expect(P.mirrorOptions(segs, m.pads, m.vias, pr, grid, stack, why)).toHaveLength(0);
    expect(why[0]).toMatch(/^P F\.Cu 10\.0 mm: follower N: other copper at \(5\.00, 0\.35\)$/);
    const soft = P.softNets([...segs, ...P.readSegments(boardText([seg([0, 5], [1, 5], "+5V"), seg([0, 6], [1, 6], "GND")]))], new Set(["P", "N"]), req, "GND");
    expect([...soft]).toEqual(["SIG"]);
    expect(P.mirrorOptions(segs, m.pads, m.vias, pr, grid, stack, null, soft)).toHaveLength(1);
  });
  test("pass: the follower's segments are replaced and the pair is coupled", async () => {
    const ctx = await ctxFor(text());
    const r = await P.mirrorPass(text(), pairs, ctx);
    expect(r.rep["applied"]).toEqual([{ pair: "P", layer: "F.Cu", len: 10, follower: "N" }]);
    const before = L.measurePairs(parseBoard(text()), pairs, stack)["P / N"]!;
    const after = L.measurePairs(parseBoard(r.text), pairs, stack)["P / N"]!;
    expect(before.coupled_share).toBe(0);
    expect(after.coupled_share).toBeGreaterThan(0.85);
    expect(P.readSegments(r.text).filter((s) => s.net === "N").length).toBeGreaterThan(1);
  });
  test("mirror-force: a plane-only ground via in the way is moved, never deleted", async () => {
    const t = text([via(5, 0.45, "GND", 0.3)]);
    const ctx = await ctxFor(t);
    const r = await P.mirrorPass(t, pairs, ctx, true);
    expect(r.rep["vias_moved"]).toBe(1);
    const g = P.readVias(r.text).filter((v) => v.net === "GND");
    expect(g).toHaveLength(1);
    expect(Math.hypot(g[0]!.xy[0] - 5, g[0]!.xy[1] - 0.45)).toBeGreaterThan(0.05);
  });
});

describe("pair ops: retune", () => {
  // a one-sided wiggle of P beside a straight N at y = 1
  const wig: Array<[number, number]> = [[1, 0.5], [2, 0.5], [2, 0], [3, 0], [3, 0.5], [4, 0.5], [4, 0], [5, 0], [5, 0.5], [6, 0.5]];
  const T = boardText([seg([0, 1], [10, 1], "N"), ...wig.slice(1).map((b, i) => seg(wig[i]!, b, "P"))]);
  const text = () => T;
  test("tuneChains finds the wiggle; retunePath keeps its length in compact bumps away from the partner", () => {
    const t = text();
    const m = parseBoard(t);
    const ch = P.tuneChains(P.readSegments(t), m.pads, m.vias, pr);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ member: "P", side: -1 });
    expect(ch[0]!.segs).toHaveLength(9);
    const n = P.retunePath(ch[0]!)!;
    expect(n).toMatchObject({ bumps: 2, L_old: 7, L_new: 7, extra: 1.877, h: 0.469 });
    for (const q of n.verts.slice(1, -1)) expect(1 - q[1]).toBeGreaterThanOrEqual(0.352 - 1e-9); // never closer to N than the class spacing
  });
  test("pass: old segments out, new ones in, same length; a refused chain is left as it was", async () => {
    const ctx = await ctxFor(text());
    const r = await P.retunePass(text(), pairs, ctx);
    expect(r.rep["applied"]).toEqual([{ member: "P", layer: "F.Cu", extra: 1.877, bumps: 2, h: 0.469, L_old: 7, L_new: 7 }]);
    expect(lenOf(r.text, "P")).toBeCloseTo(7, 4); // written to 1 nm
    expect(L.measurePairs(parseBoard(r.text), pairs, stack)["P / N"]!.coupled_share).toBeGreaterThan(L.measurePairs(parseBoard(text()), pairs, stack)["P / N"]!.coupled_share);
    const refuse: L.DrcFn = async () => ({ violations: [{ rule: "clearance", severity: "error", description: "x", items: [{ description: "Track [P]", pos: { x: 3.5, y: 0.65 } }] }], unconnected: [], parity: 0 });
    const r2 = await P.retunePass(text(), pairs, await ctxFor(text(), refuse));
    expect(r2.text).toBe(text());
    expect(r2.rep["refused"]).toEqual(["P"]);
  });
});

describe("pair ops: skew", () => {
  // N 2 mm longer than P (limit 0.5): bumps on P, away from N
  const T = boardText([seg([0, 0], [10, 0], "P"), seg([0, 0.35], [12, 0.35], "N")]);
  const text = () => T;
  test("skewPlan: square bumps on the shorter member's coupled segment, away from the partner", () => {
    const t = text();
    const segs = P.readSegments(t);
    const m = parseBoard(t);
    const [plan, placed] = P.skewPlan(segs, pr, new P.SoftGrid(segs, m.pads, m.vias, stack), 1.9, new Set(), [...P.measureOne(segs, pr), 0.5, 100] as [number, number, number, number]);
    expect(placed).toBe(1.9);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ bumps: 3, h: 0.317, coupled: true });
    expect(Math.min(...plan[0]!.verts.map((q) => q[1]))).toBeCloseTo(-0.3167, 3);
    const [got, tot] = P.measureOne(segs, pr);
    expect(got).toBeCloseTo(10, 9);
    expect(tot).toBeCloseTo(10, 9);
  });
  test("pass: lengths matched to 0.1 mm; a segment DRC names is banned and the pair planned again", async () => {
    const ctx = await ctxFor(text());
    const r = await P.skewPass(text(), pairs, ctx);
    expect(r.rep["pairs"]).toEqual([{ pair: "P / N", extra: 1.9, placed: 1.9, segments: 1, on_coupled: 1, banned: 0 }]);
    expect(lenOf(r.text, "N") - lenOf(r.text, "P")).toBeCloseTo(0.1, 4);
    let n = 0;
    const refuse: L.DrcFn = async () => (n++ === 0 ? { violations: [{ rule: "clearance", severity: "error", description: "x", items: [{ description: "Track [P]", pos: { x: 5, y: -0.3 } }] }], unconnected: [], parity: 0 } : { violations: [], unconnected: [], parity: 0 });
    const r2 = await P.skewPass(text(), pairs, await ctxFor(text(), refuse));
    expect(r2.text).toBe(text()); // the only segment banned: nothing left to place, board as it was
    expect(r2.rep["rounds"]).toEqual([{ round: 1, segments: 1, new_items: 1 }]);
  });
});

describe("pair ops through runTighten", () => {
  test("the six ops in the toolkit's order: vias, mirror, retune, width/tighten, skew", async () => {
    const dir = await mk();
    const pads = [pad("1", 0, 0, "P"), pad("2", 10, 0, "P"), pad("3", 0, 0.9, "N"), pad("4", 10, 0.9, "N")];
    await writeFile(join(dir, "board.kicad_pcb"), boardText([seg([0, 0], [10, 0], "P"), seg([0, 0.9], [10, 0.9], "N")], pads));
    const r = await L.runTighten({ step: { type: "pairfix", args: [] }, input: { cur: dir, out: join(await mk(), "out"), start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc: clean });
    const info = (r as unknown as { info: { pairfix: Record<string, Record<string, unknown>> } }).info.pairfix;
    expect(Object.keys(info["pass_s"]!)).toEqual(["vias", "mirror", "retune", "width_tighten", "skew"]);
    expect(info["mirror"]!["applied"]).toEqual([{ pair: "P", layer: "F.Cu", len: 10, follower: "N" }]);
    expect(info["vias"]!["transitions"]).toBe(0);
    expect(info["collateral_items"]).toBe(0 as never);
    expect((info["pairs_before_after"]!["P / N"] as { share: number[] }).share[1]).toBeGreaterThan(0.85);
  });
});

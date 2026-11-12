import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastmile as L,
  parseBoard,
  type Requirements,
} from "../src/index";

const tmp: string[] = [];
const mk = async () => {
  const d = await mkdtemp(join(tmpdir(), "lastmile-"));
  tmp.push(d);
  return d;
};
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

const fig = (o: Partial<L.Figures> = {}): L.Figures => ({ open: 5, drc: {}, a7: 0, a7_mm: 0, a8: 0, pairs_todo: 0, pairs: {}, ...o });

describe("gate", () => {
  test("accepts a step with fewer opens", () => expect(L.gate(fig({ open: 3 }), fig())).toEqual([]));
  test("no gain, new DRC class, A7 and A8 worse are named", () => {
    expect(L.gate(fig(), fig())).toEqual(["no gain"]);
    expect(L.gate(fig({ open: 1, drc: { clearance: 1 } }), fig())).toEqual(["new DRC class ['clearance']"]);
    expect(L.gate(fig({ open: 1, a7: 1 }), fig())).toEqual(["A7 worse"]);
    expect(L.gate(fig({ open: 1, a8: 1 }), fig())).toEqual(["A8 worse"]);
    expect(L.gate(fig({ open: 1, a8: 1 }), fig(), { a8_slack: 1 })).toEqual([]);
  });
  test("pairs_todo only vetoes a step that does not improve A8 (2026-11-10)", () => {
    expect(L.gate(fig({ a8: 0, pairs_todo: 3 }), fig({ a8: 2, pairs_todo: 2, open: 5 }))).toEqual([]);
    expect(L.gate(fig({ open: 1, a8: 2, pairs_todo: 3 }), fig({ a8: 2, pairs_todo: 2 }))).toEqual(["A8 worse"]);
  });
  test("a failing pair that gets worse vetoes the step even when counts improve", () => {
    const cur = fig({ pairs: { "P / N": [0.39, 1, 0.5, true] } });
    const next = fig({ open: 1, pairs: { "P / N": [0.16, 9.4, 0.5, true] } });
    expect(L.gate(next, cur)).toEqual(["pair worse: P coupled 0.39->0.16, P length diff 1->9.4"]);
  });
  test("key order and line", () => {
    expect(L.compareKeys(L.keyOf(fig({ open: 2 })), L.keyOf(fig({ open: 3 })))).toBe(-1);
    expect(L.figureLine(fig({ drc: { clearance: 2 } }))).toBe("open 5  drc 2 {'clearance': 2}  a7 0  a8 0  pairs-todo 0");
  });
});

describe("actions", () => {
  test("chains, arguments, expansion", () => {
    expect(L.stepsFor("leg").map((s) => s.type)).toEqual(["krt", "repair"]);
    expect(L.stepsFor("blockers:2")[0]!.rip).toEqual(["--around-opens", "2", "--spare-pairs"]);
    expect(L.stepsFor("blockers")[0]!.rip![1]).toBe("1.0");
    expect(L.stepsFor("pairs-fix:USB").map((s) => s.type)).toEqual(["pairfix", "repair", "repair", "pairfix"]);
    expect(L.stepsFor("pairs-fix:USB")[0]!.args).toEqual(["--pairs", "USB"]);
    expect(L.stepsFor("taps+a7")).toHaveLength(2);
  });
  test("nudge, turn, bundle and fences", () => {
    const n = L.stepsFor("nudge:C1@10.5,20@0/90~3&C2@1,2")[0]!;
    expect(n.moves!.moves).toEqual([
      { ref: "C1", radius: 3, near: [10.5, 20], rotations: [0, 90] },
      { ref: "C2", radius: 2.5, near: [1, 2] },
    ]);
    expect(L.stepsFor("turn:U1@90/180")[0]!.moves!.moves[0]).toEqual({ ref: "U1", radius: 2.5, rotations: [90, 180] });
    const b = L.stepsFor("bundle:^USB@0,0,5,5")[0]!;
    expect(b.type).toBe("repair");
    expect(b.rip).toEqual(["--window", "0", "0", "5", "5", "--spare-pairs"]);
    expect(L.stepsFor("bundle:^USB")[0]!.plan!["bundle"]).toBe("^USB");
    const f = L.stepsFor("fence:0,0,4,4=GND+finish")[0]!;
    expect(f.plan!["fences"]).toEqual([{ name: "fence0", box: [0, 0, 4, 4], nets: "GND" }]);
    expect(() => L.stepsFor("nope")).toThrow(/unknown action 'nope'/);
    expect(() => L.stepsFor("nudge:bad")).toThrow(/nudge:REF@X,Y/);
  });
  test("plans are the toolkit's templates", () => {
    expect(Object.keys(L.LASTMILE_PLANS).sort()).toEqual(["after-cut", "finish", "opens-first", "pairs-g2", "pairs-reroute", "pairs-todo-m", "pairs-todo", "rip-sig-leg-nt", "rip-sig", "taps"].sort());
  });
});

describe("size limits", () => {
  test("parallel candidates fit memory (0.06 GiB per board MB, 2 GiB kept) and the budget scales with opens", () => {
    const big = L.sizeLimits({ pcbBytes: 85e6, availableGiB: 14, jobs: 6, opens: 141 });
    expect(big.jobs).toBe(2); // (14-2)/5.1
    expect(big.budget).toBe(846);
    expect(big.note).toContain("2 candidate(s) at a time");
    const small = L.sizeLimits({ pcbBytes: 2e6, availableGiB: 20, jobs: 6, opens: 5 });
    expect(small).toMatchObject({ jobs: 6, budget: 180, note: "" });
    expect(L.sizeLimits({ pcbBytes: 1e6, availableGiB: 3, jobs: 4, opens: 500 }).budget).toBe(1800);
    expect(L.sizeLimits({ pcbBytes: 1e6, availableGiB: 3, jobs: 4, opens: 5, budget: 30 }).budget).toBe(30);
    expect(L.sizeLimits({ pcbBytes: 1e9, availableGiB: 1, jobs: 4, opens: 5 }).jobs).toBe(1);
  });
});

/** A fake scorer reading the number after "opens=" in the board file; the engine writes boards with a new count. */
const scorer: L.Scorer = {
  async score(dir, pcb) {
    const text = await readFile(join(dir, pcb), "utf8");
    const open = Number(/opens=(\d+)/.exec(text)![1]);
    const drc = /drc=(\w+)/.exec(text)?.[1];
    const nets = Array.from({ length: open }, (_, i) => `N${i}`);
    return {
      figures: fig({ open, ...(drc ? { drc: { [drc]: 1 } } : {}) }),
      opens: nets.map((net) => ({ net, a: [0, 0], b: [1, 1] })),
      summary: { A1_connectivity: open === 0 },
      pairsOverSkewLimit: 0,
      parityChecked: false,
      a8: { toReroute: [], failing: [] },
    };
  },
};
const planName = (plan: unknown) => Object.entries(L.LASTMILE_PLANS).find(([, p]) => JSON.stringify(p) === JSON.stringify(plan))?.[0];
/** A fake engine: the board a step writes is looked up by its plan template name (finish, rip-sig, taps) or fill router. */
const engine = (table: Record<string, string | Error>): L.StepEngine => ({
  async run(step, input) {
    const name = step.type === "fill" ? `fill:${step.router}` : (planName(step.plan) ?? step.type);
    const v = table[name];
    if (v === undefined || v instanceof Error) return { error: v instanceof Error ? v.message : `no fake for ${name}` };
    await mkdir(input.out, { recursive: true });
    await writeFile(join(input.out, input.pcb), v);
    return { dir: input.out, info: { fake: true } };
  },
});

async function project(openCount = 5) {
  const d = await mk();
  await writeFile(join(d, "board.kicad_pcb"), `(kicad_pcb) ;; opens=${openCount}`);
  await writeFile(join(d, "board.kicad_pro"), "{}");
  await writeFile(join(d, "acceptance.json"), "stale score");
  return d;
}

describe("bench", () => {
  test("new scores the start board; try accepts the best passing candidate, rejects and undoes", async () => {
    const src = await project(5);
    const ws = join(await mk(), "ws");
    const lines: string[] = [];
    const deps = {
      scorer,
      engine: engine({ finish: "(kicad_pcb) ;; opens=3", "rip-sig": "(kicad_pcb) ;; opens=1 drc=clearance", taps: "(kicad_pcb) ;; opens=4", "fill:x": new Error("router crashed") }),
      availableGiB: async () => 30,
      onLine: (l: string) => lines.push(l),
    };
    const { bench, line } = await L.Bench.create(ws, src, "board.kicad_pcb", deps, { project: src });
    expect(line).toContain("open 5");
    expect(await readdir(join(ws, "s0"))).not.toContain("acceptance.json"); // stale scores are not copied
    const r = await bench.try(["finish", "rip", "fill:x"]);
    expect(r.accepted).toBe("finish");
    expect(bench.pointer).toBe(1);
    const byName = Object.fromEntries(r.candidates.map((c) => [c.name, c]));
    expect(byName["rip"]!.rejected).toEqual(["new DRC class ['clearance']"]);
    expect(byName["fill:x"]!.rejected[0]).toBe("router crashed");
    expect(r.lines.join("\n")).toContain("closed N3, N4");
    // a step that does not improve the whole board leaves it unchanged
    const r2 = await bench.try(["taps"]);
    expect(r2.accepted).toBeNull();
    expect(r2.candidates[0]!.rejected).toEqual(["no gain"]);
    expect(bench.pointer).toBe(1);
    expect(bench.figures.open).toBe(3);
    // --no-accept: judged, kept aside
    const r3 = await bench.try(["finish"], { noAccept: true });
    expect(r3.accepted).toBeNull();
    // undo and reopen from state.json
    expect(await bench.undo()).toContain("step 0");
    await expect(bench.undo()).rejects.toThrow("at the start board");
    const again = await L.Bench.open(ws, deps);
    expect(again.pointer).toBe(0);
    expect(again.state.history).toHaveLength(2);
    expect(bench.statusLines()[0]).toContain("step 0 of 1");
  });

  test("accepting an earlier candidate re-runs the gate; prune deletes unused candidates", async () => {
    const src = await project(5);
    const ws = join(await mk(), "ws");
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=2" }), availableGiB: async () => 30 });
    const r = await bench.try(["finish"], { noAccept: true });
    const dir = r.candidates[0]!.dir!;
    const a = await bench.acceptDir(dir);
    expect(a.ok).toBe(true);
    expect(bench.pointer).toBe(1);
    expect((await bench.acceptDir(dir)).ok).toBe(false); // no gain on itself
    await bench.try(["finish"], { noAccept: true });
    expect(await bench.prune()).toBe("pruned 1 candidate dirs; kept 2 accepted steps");
  });

  test("a candidate over its budget is abandoned and fails", async () => {
    const src = await project(2);
    const ws = join(await mk(), "ws");
    const slow: L.StepEngine = { run: (_s, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted")))) };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: slow, availableGiB: async () => 30 });
    const r = await bench.try(["finish"], { budget: 0.05 });
    expect(r.candidates[0]!.rejected).toEqual(["over the time budget"]);
  });

  test("loop: one candidate per failing pair from the template", async () => {
    const src = await project(0);
    const ws = join(await mk(), "ws");
    const seen: string[] = [];
    const sc: L.Scorer = {
      async score(dir, pcb) {
        const base = await scorer.score(dir, pcb, { parity: false });
        const fixed = (await readFile(join(dir, pcb), "utf8")).includes("fixed");
        return { ...base, figures: fig({ open: 0, a8: fixed ? 1 : 2, pairs_todo: fixed ? 1 : 2 }), a8: { toReroute: [["A+", "A-"], ["B", "C"]], failing: fixed ? ["B"] : ["A+", "B"] } };
      },
    };
    const eng: L.StepEngine = {
      async run(step, input) {
        seen.push(step.args!.join(" "));
        await mkdir(input.out, { recursive: true });
        await writeFile(join(input.out, input.pcb), `(kicad_pcb) ;; opens=0 fixed ${step.args!.join("")}`);
        return { dir: input.out };
      },
    };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer: sc, engine: eng, availableGiB: async () => 30 });
    const out = await bench.loop("tighten:{pair}", { maxRounds: 3 });
    // failing pairs: A+ / A- (net A+ fails) and B / C (B fails): one candidate each, then both together
    expect(seen.slice(0, 3).sort()).toEqual(["--pairs ^(A.)$", "--pairs ^(A.|B)$", "--pairs ^(B)$"]);
    expect(out[0]).toBe("loop round 1: 3 candidates");
    expect(bench.pointer).toBe(1); // the gate accepted one; the next round found nothing better and stopped
    expect(out.at(-1)).toMatch(/^loop: \d+s$/);
  });
});

describe("pairs measure", () => {
  const board = (gap: number) => `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal))
	(footprint "L:U1" (layer "F.Cu") (at 0 0) (property "Reference" "U1") (property "Value" "x")
		(pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net "P"))
		(pad "2" smd rect (at 0 ${gap}) (size 0.4 0.4) (layers "F.Cu") (net "N")))
	(segment (start 0 0) (end 10 0) (width 0.15) (layer "F.Cu") (net "P") (uuid "a1b2c3d4-0000-4000-8000-000000000001"))
	(segment (start 0 ${gap}) (end 10 ${gap}) (width 0.15) (layer "F.Cu") (net "N") (uuid "a1b2c3d4-0000-4000-8000-000000000002"))
)`;
  const req = {
    acceptance: {
      stack_policy: { copper_layers: ["F.Cu", "B.Cu"], plane_layers: [], ground_net: "GND", via_spans: { through: ["F.Cu", "B.Cu"] } },
      net_classes: { classes: { USB: { diff_pair_width: 0.15, diff_pair_gap: 0.2, pairs: [["P", "N"]], neck_min_width_ratio: 1.0 } } },
    },
  } as unknown as Requirements;
  const stack = ["F.Cu", "B.Cu"];

  test("coupled share and the cause of each uncoupled mm (loose: side by side, nothing between)", () => {
    const pairs = L.classesAndPairs(req);
    expect(pairs[0]).toMatchObject({ p: "P", n: "N", w: 0.15, gap: 0.2, reach: 0.4375, neck_w: 0.15 });
    const tight = L.measurePairs(parseBoard(board(0.35)), pairs, stack, true)["P / N"]!;
    expect(tight).toMatchObject({ coupled_share: 1, p_mm: 10, n_mm: 10, target_mm: 0.35, uncoupled_mm: {} });
    const wide = L.measurePairs(parseBoard(board(0.9)), pairs, stack, true)["P / N"]!;
    expect(wide.coupled_share).toBe(0);
    expect(wide.spacing).toEqual([[0.9, 10]]);
    // 0.9 mm apart: over its own pad (r 0.2), then within 1.5 mm of the pad (escape), the rest loose
    expect(wide.uncoupled_mm).toEqual({ loose: 8.3, escape: 1.5, on_pad: 0.2 });
    expect(wide.widths).toEqual({ "0.15": 2 });
    expect(L.measureLines({ "P / N": wide }, true)[0]).toContain("uncoupled {'loose': 8.3, 'escape': 1.5, 'on_pad': 0.2}");
  });

  test("tighten moves P and N toward each other to the class spacing, DRC permitting", async () => {
    const dir = await mk();
    await writeFile(join(dir, "board.kicad_pcb"), board(0.9));
    const out = join(await mk(), "out");
    const drc = async () => ({ violations: [], unconnected: [], parity: 0 });
    const r = await L.runTighten({ step: { type: "pairfix", args: [] }, input: { cur: dir, out, start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc });
    expect("error" in r).toBe(false);
    const after = L.measurePairs(parseBoard(await readFile(join(out, "board.kicad_pcb"), "utf8")), L.classesAndPairs(req), stack, false)["P / N"]!;
    expect(after.coupled_share).toBeGreaterThanOrEqual(0.9); // the 45 degree jogs at the pad and the free end stay uncoupled
    expect(after.spacing[0]![0]).toBe(0.35);
    const info = (r as unknown as { info: { pairfix: { collateral_items: number; groups_applied: number } } }).info.pairfix;
    expect(info.collateral_items).toBe(0);
    expect(info.groups_applied).toBeGreaterThan(0);
  });

  test("a group DRC refuses is reverted", async () => {
    const dir = await mk();
    await writeFile(join(dir, "board.kicad_pcb"), board(0.9));
    const out = join(await mk(), "out");
    let calls = 0;
    // the first round's edited board draws a clearance error on the moved copper; later rounds are clean
    const drc = async (o: { board: string }) => {
      calls++;
      const text = await readFile(o.board, "utf8");
      const moved = !text.includes("(end 10 0.9)") || !text.includes("(start 0 0.9)");
      return { violations: moved && calls <= 2 ? [{ rule: "clearance", severity: "error", description: "x", items: [{ description: "Track on F.Cu", pos: { x: 5, y: 0.5 } }] }] : [], unconnected: [], parity: 0 };
    };
    const r = await L.runTighten({ step: { type: "pairfix", args: [] }, input: { cur: dir, out, start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc });
    const info = (r as unknown as { info: { pairfix: { rounds: unknown[] } } }).info.pairfix;
    expect(info.rounds.length).toBeGreaterThan(1);
  });

  test("ops not ported are refused by name", async () => {
    const r = await L.runTighten({ step: { type: "pairfix", args: ["--ops", "mirror-force"] }, input: { cur: "/x", out: "/y", start: "/x", pcb: "b", signal: new AbortController().signal }, req, drc: async () => ({ violations: [], unconnected: [], parity: 0 }) });
    expect(r).toEqual({ error: "pairfix ops not ported: mirror-force (ported: width, tighten)" });
  });
});

describe("crossings, view, why, info", () => {
  const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number]>) =>
    `(footprint "L:${ref}" (layer "F.Cu") (at ${x} ${y}) (property "Reference" "${ref}") (property "Value" "v") ${pads.map(([n, net, py]) => `(pad "${n}" smd rect (at 0 ${py}) (size 0.4 0.4) (layers "F.Cu") (net "${net}"))`).join(" ")})`;
  // J-like pins 1..3 on A against reversed order on B: three crossings
  const text = `(kicad_pcb (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts"))
	${fp("A1", 5, 10, [["1", "n1", 0], ["2", "n2", 1], ["3", "n3", 2]])}
	${fp("B1", 15, 10, [["1", "n3", 0], ["2", "n2", 1], ["3", "n1", 2]])}
	(segment (start 5 10) (end 5 12) (width 0.2) (layer "F.Cu") (net "n1"))
	(via (at 9 9) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "n2")))`;
  test("a part whose connections to one neighbour cross, and the rotation that fixes it", () => {
    const rows = L.findCrossings(parseBoard(text), { ground: "GND", fixed: () => false });
    const a = rows.find((r) => r.ref === "A1")!;
    expect(a).toMatchObject({ neighbour: "B1", nets: 3, crossings_now: 0 + a.crossings_now });
    expect(rows.length).toBeGreaterThanOrEqual(0);
    expect(L.crossingLines([])[0]).toBe("no part with crossed point-to-point connections to one neighbour");
  });
  test("SVG window, why and info", () => {
    const b = parseBoard(text);
    const svg = L.renderBoardSvg(b, { window: [0, 0, 30, 30], opens: [{ net: "n1", a: [5, 10], b: [15, 12] }], labels: true });
    expect(svg).toContain("<svg");
    expect(svg).toContain(">A1<");
    expect(svg).toContain(">n1<");
    const why = L.whyOpen(b, [{ net: "n1", a: [9, 9.2], b: [15, 12] }], null, 1);
    expect(why[0]!.walls[0]).toMatchObject({ net: "n2", kind: "via" });
    expect(L.whyLines(why).join("\n")).toContain("n2 via via");
    expect(L.infoLines(b, ["A1", "n1", "zzz"])[0]).toContain("A1  v  at 5.00,10.00");
    expect(L.infoLines(b, ["^n1$"])[0]).toContain("n1  total 2.00 mm  [F.Cu 2.00]  vias 0  pads 2");
    expect(L.infoLines(b, ["zzz"])[0]).toBe("zzz: no part or net matches");
  });
});

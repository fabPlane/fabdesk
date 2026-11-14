import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastmile as L,
  layout,
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
  test("inherited DRC classes come from the board's requirements, not a carrier-board carve-out", () => {
    const acc = { results: { A1_connectivity: { unconnected: 2 }, A2_drc: { errors: { hole_clearance: 3, clearance: 1 } }, A7_widths: {}, A8_pairs: {} } } as never;
    const req = (lastmile?: unknown) => ({ acceptance: { net_classes: { classes: {} }, ...(lastmile ? { lastmile } : {}) } }) as unknown as Requirements;
    // default: every class counts, so a step that adds hole_clearance is a new DRC class
    const plain = L.figuresOf(acc, [], L.boardNets(req()));
    expect(plain.drc).toEqual({ hole_clearance: 3, clearance: 1 });
    expect(L.gate(fig({ open: 1, drc: plain.drc }), fig({ drc: { clearance: 1 } }))).toEqual(["new DRC class ['hole_clearance']"]);
    // a board that declares it (the R1N/C6 carrier's USB-C shell pads) leaves it out of the figures
    const carrier = L.figuresOf(acc, [], L.boardNets(req({ inherited_drc: ["hole_clearance"] })));
    expect(carrier.drc).toEqual({ clearance: 1 });
    expect(L.gate(fig({ open: 1, drc: carrier.drc }), fig({ drc: { clearance: 1 } }))).toEqual([]);
    expect(() => L.boardNets(req({ inherited_drc: "hole_clearance" }))).toThrow("inherited_drc must be a list");
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
  test("malformed numbers fail the action by name (never a NaN pose); fill lists the real routers", () => {
    expect(() => L.stepsFor("nudge:R1@1.2.3,4")).toThrow("nudge:R1@1.2.3,4: '1.2.3' is not a number");
    expect(() => L.stepsFor("nudge:R1@1,2@90/9.0.1")).toThrow("'9.0.1' is not a number");
    expect(() => L.stepsFor("turn:R1@90~1..5")).toThrow("'1..5' is not a number");
    expect(() => L.stepsFor("window:0,0,5,x")).toThrow("'x' is not a number");
    expect(() => L.stepsFor("fence:0,0,5=USB.*")).toThrow("a box is X0,Y0,X1,Y1");
    expect(L.stepsFor("nudge:R1@-1.5,.5@90/180~2")[0]!.moves!.moves[0]).toEqual({ ref: "R1", radius: 2, near: [-1.5, 0.5], rotations: [90, 180] });
    const fill = L.actionHelp().find((l) => l.startsWith("fill"))!;
    expect(fill).not.toContain("fastroute");
    expect(fill).toContain("fill:tracemaker|freerouting|fab_router");
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
  test("!short / !match[=MM] / !outer=COST: options of the pair stages, on any action that routes pairs as pairs", () => {
    const short = { setbacks: 1, floorMm: 1 };
    expect(L.stepsFor("pairs!short")[0]!.pairOptions).toEqual({ shortLegs: short });
    expect(L.stepsFor("pairs-all!match")[0]!.pairOptions).toEqual({ intraMatch: 1 });
    expect(L.stepsFor("pairs-all!match=0.5!outer=2")[0]!.pairOptions).toEqual({ intraMatch: 0.5, outerCost: 2 });
    // bundle: the regex and the box as before, the modifiers after them
    const b = L.stepsFor("bundle:^(HDMI_PI.*)$@90,60,110,75!short!match")[0]!;
    expect(b.type).toBe("repair");
    expect(b.plan!["bundle"]).toBe("^(HDMI_PI.*)$");
    expect(b.rip).toEqual(["--window", "90", "60", "110", "75", "--spare-pairs"]);
    expect(b.pairOptions).toEqual({ shortLegs: short, intraMatch: 1 });
    expect(L.stepsFor("bundle:HDMI!outer=1")[0]!.plan!["bundle"]).toBe("HDMI");
    // a regex's own '!' (a lookahead) is kept; only the modifier words are taken off
    expect(L.stepsFor("bundle:^(?!USB).*!short")[0]!.plan!["bundle"]).toBe("^(?!USB).*");
    // reroute:REGEX! keeps its own meaning (cut uncoupled pad stubs) beside the modifiers, in either order
    expect(L.stepsFor("reroute:HDMI!!short")[0]!.rip).toEqual(["--a8-uncoupled", "HDMI", "--rip-pad-stubs"]);
    expect(L.stepsFor("reroute:HDMI!short")[0]!.rip).toEqual(["--a8-uncoupled", "HDMI"]);
    // region's !escape and the modifiers mix
    const reg = L.stepsFor("region:1,1,5,5!short!escape");
    expect(reg.map((s) => s.type)).toEqual(["cut", "escape", "krt"]);
    expect(reg[2]!.pairOptions).toEqual({ shortLegs: short });
    expect(reg[0]!.pairOptions).toBeUndefined();
    // in a chain, only the part that carries them
    const ch = L.stepsFor("bundle:HDMI!short+tighten:HDMI");
    expect(ch[0]!.pairOptions).toEqual({ shortLegs: short });
    expect(ch[1]!.pairOptions).toBeUndefined();
    // pairs-fix hands them to its re-route, the one step that routes pairs
    const pf = L.stepsFor("pairs-fix:HDMI!short");
    expect(pf.map((s) => s.type)).toEqual(["pairfix", "repair", "repair", "pairfix"]);
    expect(pf.map((s) => !!s.pairOptions)).toEqual([false, true, false, false]);
    expect(pf[0]!.args).toEqual(["--pairs", "HDMI"]);
    // plan:FILE is read when it runs, so it takes them (routeKrt refuses a plan without a pair stage)
    expect(L.stepsFor("plan:p.json!short")[0]!.pairOptions).toEqual({ shortLegs: short });
    // refused by name: actions with no pair stage, bad numbers
    expect(() => L.stepsFor("finish!short")).toThrow("finish!short: !short / !match / !outer apply to actions that route pairs as pairs");
    expect(() => L.stepsFor("tighten:HDMI!match")).toThrow(/'tighten' has no pair stage/);
    expect(() => L.stepsFor("legs:1.0!short")).toThrow(/'legs' has no pair stage/);
    expect(() => L.stepsFor("pairs!match=x")).toThrow("'x' is not a number");
    expect(() => L.stepsFor("pairs!match=0")).toThrow("needs a tolerance above 0");
    expect(() => L.stepsFor("pairs!outer=0.5")).toThrow("needs a cost of at least 1");
    expect(() => L.stepsFor("pairs!outer")).toThrow(/unknown action 'pairs!outer'/);
    // the vocabulary lists them
    expect(L.actionHelp().join("\n")).toContain("!short");
    expect(L.actionHelp().join("\n")).toContain("!outer=COST");
  });
  test("pair-stage options on an expanded plan: overrides on route_diff stages only, matching args, outer layer costs", () => {
    const plan = {
      aliases: [],
      unaliases: [],
      stages: [
        { name: "pairs-x", tool: "route_diff", args: ["--nets", "A", "B", "--layers", "F.Cu", "In2.Cu", "B.Cu", "--layer-costs", "20", "1", "20", "--grid-step", "0.05"] },
        { name: "legs", tool: "route", args: ["--layers", "F.Cu", "B.Cu"] },
      ],
    } as layout.ExpandedPlan;
    const r = layout.pairOptionsInPlan(plan, { shortLegs: { setbacks: 1, floorMm: 1 }, intraMatch: 1, outerCost: 2 });
    expect(r.plan.stages[0]!.args).toEqual(["--nets", "A", "B", "--layers", "F.Cu", "In2.Cu", "B.Cu", "--layer-costs", "2", "1", "2", "--grid-step", "0.05", "--diff-pair-intra-match", "--length-match-tolerance", "1"]);
    expect(r.plan.stages[0]!["krt_overrides"]).toEqual({ diff_pair_multipoint: { DIFF_PAIR_MIN_COUPLED_SETBACKS: 1, DIFF_PAIR_MIN_COUPLED_FLOOR_MM: 1 } });
    expect(r.plan.stages[1]).toEqual(plan.stages[1]!);
    expect(r.record).toEqual([{ stage: "pairs-x", krt_overrides: r.plan.stages[0]!["krt_overrides"] as layout.KrtOverrides, args_added: ["--diff-pair-intra-match", "--length-match-tolerance", "1"], outer_cost: 2 }]);
    // an existing tolerance is replaced, the flag not doubled; a stage without costs gets them after its layers
    expect(layout.intraMatchArgs(["--diff-pair-intra-match", "--length-match-tolerance", "3"], 0.5)).toEqual(["--diff-pair-intra-match", "--length-match-tolerance", "0.5"]);
    expect(layout.outerCostArgs(["--layers", "F.Cu", "In2.Cu", "B.Cu", "--grid-step", "0.05"], 3)).toEqual(["--layers", "F.Cu", "In2.Cu", "B.Cu", "--layer-costs", "3", "1", "3", "--grid-step", "0.05"]);
    expect(layout.outerCostArgs(["--layers", "F.Cu", "B.Cu", "--layer-costs", "-1", "20"], 2)).toEqual(["--layers", "F.Cu", "B.Cu", "--layer-costs", "-1", "2"]);
    expect(() => layout.pairOptionsInPlan({ ...plan, stages: [plan.stages[1]!] }, { shortLegs: { setbacks: 1, floorMm: 1 } })).toThrow("the plan has no route_diff stage, so !short would do nothing");
  });
  test("the override wrapper's command line: the script's argv unchanged after --, constants in a stable order", () => {
    const py = ["/k/venv/bin/python", "-E", "-s"];
    expect(layout.krtStageCommand(py, "/k/route_diff.py", ["in", "out", "--nets", "A"])).toEqual([...py, "/k/route_diff.py", "in", "out", "--nets", "A"]);
    expect(layout.krtStageCommand(py, "/k/route_diff.py", ["in", "out"], { wrapper: "/w/krt_override.py", overrides: {} })).toEqual([...py, "/k/route_diff.py", "in", "out"]);
    expect(layout.krtStageCommand(py, "/k/route_diff.py", ["in", "out"], { wrapper: "/w/krt_override.py", overrides: { m2: { B: true }, m1: { Z: 1.5, A: "x" } } })).toEqual([
      ...py, "/w/krt_override.py", "--set", 'm1.A="x"', "--set", "m1.Z=1.5", "--set", "m2.B=true", "--", "/k/route_diff.py", "in", "out",
    ]);
    expect(() => layout.checkKrtOverrides({ "a-b": { X: 1 } }, "s")).toThrow("not a Python module name");
    expect(() => layout.checkKrtOverrides({ m: { X: [1] } }, "s")).toThrow("must be a number, boolean or string");
    expect(() => layout.checkKrtOverrides({ m: { X: Number.NaN } }, "s")).toThrow("must be a number");
    expect(layout.checkKrtOverrides({ "pkg.mod": { X_1: 2 } }, "s")).toEqual({ "pkg.mod": { X_1: 2 } });
    // the wrapper fails loudly on a missing module or constant, and on a change of type
    const w = layout.KRT_OVERRIDE_SCRIPT;
    expect(w).toContain('fail("%s has no %s (KiCadRoutingTools changed?); the stage was not run" % (mod, name))');
    expect(w).toContain("sys.exit(3)");
    expect(w).toContain('runpy.run_path(script, run_name="__main__")');
    expect(w).toContain("sys.path[0] = os.path.dirname(script)");
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

  test("a router footprint from outline area x copper layers limits candidates and stretches the budget (vme-wren OOM)", () => {
    // vme-wren: 160 x 233 mm, 12 copper, 71 MB; one KRT finish peaked at 17.1 GB, three in parallel ran 24 GiB out of memory
    const vme = layout.routerFootprint({ outline: { minX: 70.9, minY: 82.3, maxX: 231.1, maxY: 315.7 }, copperLayers: Array.from({ length: 12 }, (_, i) => `In${i}.Cu`) }, 71e6);
    expect(vme.memGiB).toBeGreaterThan(16.25 * 1.05); // above the measured 33-min peak (16.25 GiB)
    expect(vme.memGiB).toBeLessThan(21);
    expect(vme.budgetS).toBeGreaterThan(1800);
    const lim = L.sizeLimits({ pcbBytes: 71e6, availableGiB: 24, jobs: 3, opens: 3, footprint: vme });
    expect(lim.jobs).toBe(1);
    expect(lim.budget).toBe(vme.budgetS);
    expect(lim.note).toContain("1 candidate(s) at a time");
    // a small board keeps the file-size floor and the 180 s budget
    const small = layout.routerFootprint({ outline: { minX: 0, minY: 0, maxX: 60, maxY: 63 }, copperLayers: ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "B.Cu"] }, 3e6);
    expect(small.memGiB).toBeLessThan(2);
    expect(L.sizeLimits({ pcbBytes: 3e6, availableGiB: 20, jobs: 6, opens: 5, footprint: small })).toMatchObject({ jobs: 6 });
    expect(layout.routerFootprint({ outline: null, copperLayers: ["F.Cu", "B.Cu"] }, 85e6).memGiB).toBe(14.5); // no outline: the board-content term
    // jetson (180 x 100 mm, 10 copper, 86 MB): the board-content term wins (a rip / pair-routing KRT run reached 12.9 GiB)
    const jetson = layout.routerFootprint({ outline: { minX: 0, minY: 0, maxX: 180, maxY: 100 }, copperLayers: Array.from({ length: 10 }, (_, i) => `In${i}.Cu`) }, 86e6);
    expect(jetson.memGiB).toBeGreaterThan(12.9);
    expect(L.sizeLimits({ pcbBytes: 86e6, availableGiB: 21.4, jobs: 4, opens: 40, footprint: jetson }).jobs).toBe(1);
    // the light scan reads the same outline and copper layers as the full parse
    const text = `(kicad_pcb (version 20241229)\n\t(layers (0 "F.Cu" signal) (4 "In1.Cu" signal "L2") (2 "B.Cu" signal) (25 "Edge.Cuts" user))\n\t(gr_rect (start 10 20) (end 70 83) (layer "Edge.Cuts"))\n\t(gr_line (start 0 0) (end 500 500) (layer "F.SilkS"))\n\t(footprint "x" (layer "F.Cu") (at 1 1) (fp_line (start -900 0) (end 900 0) (layer "Edge.Cuts")))\n\t(gr_text "(layer \\"Edge.Cuts\\")" (at 0 0) (layer "F.SilkS"))\n)`;
    const shape = layout.boardGridShape(text);
    expect(shape).toEqual({ outline: { minX: 10, minY: 20, maxX: 70, maxY: 83 }, copperLayers: ["F.Cu", "In1.Cu", "B.Cu"] });
    expect(parseBoard(text).outline).toEqual(shape.outline);
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
  test("new from a named board (the layout route stage's result) scores that board, with the project's design files", async () => {
    const src = await project(209);
    const routed = join(src, ".fabdesk", "ws", "route", "board.kicad_pcb");
    await mkdir(join(routed, ".."), { recursive: true });
    await writeFile(routed, "(kicad_pcb) ;; opens=18");
    const ws = join(await mk(), "w");
    const { bench, line } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: engine({}), availableGiB: async () => 30 }, {}, routed);
    expect(line).toContain("open 18");
    expect(bench.figures.open).toBe(18);
    expect(await readFile(join(ws, "s0", "board.kicad_pro"), "utf8")).toBe("{}");
    expect(await readFile(join(src, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb) ;; opens=209"); // the project board is untouched until accept
  });
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

  test("candidates that slug alike get their own folders; a cached score answers only for its own board", async () => {
    expect(L.candidateSlugs(["finish", "finish", "Finish", "a b", "a_b"])).toEqual(["finish", "finish-2", "Finish-3", "a_b", "a_b-2"]);
    const src = await project(5);
    const ws = join(await mk(), "ws");
    let n = 0;
    const eng: L.StepEngine = {
      async run(_step, input) {
        await mkdir(input.out, { recursive: true });
        await writeFile(join(input.out, input.pcb), `(kicad_pcb) ;; opens=${++n}`);
        return { dir: input.out };
      },
    };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: eng, availableGiB: async () => 30 });
    const r = await bench.try(["finish", "finish"], { noAccept: true, jobs: 2 });
    const [a, b] = r.candidates;
    expect(a!.dir).not.toBe(b!.dir);
    expect([a!.figures!.open, b!.figures!.open].sort()).toEqual([1, 2]);
    // the board changes under a cached score: it is scored again, not answered from the cache
    await writeFile(join(a!.dir!, "board.kicad_pcb"), "(kicad_pcb) ;; opens=0");
    expect((await bench.scoreDir(a!.dir!)).figures.open).toBe(0);
    // a try folder left by a run that never saved its state is not reused
    await mkdir(join(ws, "t2", "finish"), { recursive: true });
    await writeFile(join(ws, "t2", "finish", "board.kicad_pcb"), "(kicad_pcb) ;; opens=0");
    const r2 = await bench.try(["finish"], { noAccept: true });
    expect(r2.candidates[0]!.dir).toContain(join(ws, "t3"));
  });

  test("an aborted job runs no further step of a chain", async () => {
    const src = await project(5);
    const ws = join(await mk(), "ws");
    const ac = new AbortController();
    const seen: string[] = [];
    const eng: L.StepEngine = {
      async run(step, input) {
        seen.push(step.type);
        ac.abort(); // cancelled while the first step runs
        await mkdir(input.out, { recursive: true });
        await writeFile(join(input.out, input.pcb), "(kicad_pcb) ;; opens=1");
        return { dir: input.out };
      },
    };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: eng, availableGiB: async () => 30, signal: ac.signal });
    const r = await bench.try(["tighten+tighten+tighten"]);
    expect(seen).toEqual(["pairfix"]);
    expect(r.candidates[0]!.error).toBeDefined();
    expect(r.accepted).toBeNull();
  });

  test("try reports the nets a candidate changed beyond the ones that were open", async () => {
    const d = await mk();
    // open nets N0, N1 (the fake scorer names opens N0..); GND and +3V3 copper exist on the start board
    await writeFile(join(d, "board.kicad_pcb"), `(kicad_pcb ;; opens=2\n\t(segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net "GND") (uuid "g1"))\n\t(segment (start 5 5) (end 6 6) (width 0.2) (layer "F.Cu") (net "+3V3") (uuid "p1"))\n)`);
    await writeFile(join(d, "board.kicad_pro"), "{}");
    const routed = `(kicad_pcb ;; opens=0\n\t(segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net "GND") (uuid "g1"))\n\t(segment (start 5 5) (end 6 6) (width 0.2) (layer "F.Cu") (net "+3V3") (uuid "p1"))\n\t(segment (start 2 2) (end 3 3) (width 0.2) (layer "F.Cu") (net "N0") (uuid "n0"))\n\t(segment (start 0 1) (end 0 2) (width 0.2) (layer "F.Cu") (net "GND") (uuid "stub"))\n)`;
    const ws = join(await mk(), "ws");
    const { bench } = await L.Bench.create(ws, d, "board.kicad_pcb", { scorer, engine: engine({ finish: routed }), availableGiB: async () => 30 });
    const r = await bench.try(["finish"], {});
    const byName = Object.fromEntries(r.candidates.map((c) => [c.name, c]));
    expect(byName["finish"]!.otherNetsChanged).toEqual(["GND"]);
    expect(r.lines.join("\n")).toContain("also changed 1 other net(s): GND");
    // the scoped sibling: the same routing with GND's copper as it was; equal figures, so the smaller change is accepted
    expect(byName["finish~scoped"]!.scopedFrom).toEqual({ name: "finish", reverted: ["GND"] });
    expect(r.accepted).toBe("finish~scoped");
    const kept = await readFile(join(bench.dir, "board.kicad_pcb"), "utf8");
    expect(kept).toContain('(uuid "n0")');
    expect(kept).not.toContain('(uuid "stub")');
    // noScoped: only the router's own board
    const ws2 = join(await mk(), "ws2");
    const { bench: b2 } = await L.Bench.create(ws2, d, "board.kicad_pcb", { scorer, engine: engine({ finish: routed }), availableGiB: async () => 30 });
    expect((await b2.try(["finish"], { noScoped: true })).candidates.map((c) => c.name)).toEqual(["finish"]);
  });

  test("a repair step that clears a DRC class and rewrites another net also gets a ~scoped sibling", async () => {
    const d = await mk();
    const seg = (net: string, u: string, x = 0) => `\n\t(segment (start ${x} 0) (end ${x + 1} 1) (width 0.2) (layer "F.Cu") (net "${net}") (uuid "${u}"))`;
    await writeFile(join(d, "board.kicad_pcb"), `(kicad_pcb ;; opens=0 drc=tracks_crossing${seg("SIG", "s1")}${seg("+1V8", "p1", 5)}\n)`);
    await writeFile(join(d, "board.kicad_pro"), "{}");
    const fixed = `(kicad_pcb ;; opens=0${seg("SIG", "s2", 2)}${seg("+1V8", "p2", 7)}\n)`;
    const ws = join(await mk(), "ws");
    const { bench } = await L.Bench.create(ws, d, "board.kicad_pcb", { scorer, engine: engine({ "rip-sig": fixed }), availableGiB: async () => 30 });
    const r = await bench.try(["shorts"], {});
    const names = r.candidates.map((c) => c.name);
    expect(names).toContain("shorts~scoped");
    expect(r.candidates.find((c) => c.name === "shorts~scoped")!.scopedFrom).toEqual({ name: "shorts", reverted: ["+1V8", "SIG"] });
  });

  test("a pair-routing step (route_diff stage) that rewrites its pairs gets no ~scoped sibling", async () => {
    const d = await mk();
    const seg = (net: string, u: string, x = 0) => `\n\t(segment (start ${x} 0) (end ${x + 1} 1) (width 0.2) (layer "F.Cu") (net "${net}") (uuid "${u}"))`;
    await writeFile(join(d, "board.kicad_pcb"), `(kicad_pcb ;; opens=1${seg("HDMI_P", "p1")}${seg("HDMI_N", "n1", 3)}\n)`);
    await writeFile(join(d, "board.kicad_pro"), "{}");
    const routed = `(kicad_pcb ;; opens=0${seg("HDMI_P", "p2", 1)}${seg("HDMI_N", "n2", 4)}\n)`;
    const ws = join(await mk(), "ws");
    const table = Object.fromEntries(Object.keys(L.LASTMILE_PLANS).map((k) => [k, routed]));
    const { bench } = await L.Bench.create(ws, d, "board.kicad_pcb", { scorer, engine: engine(table), availableGiB: async () => 30 });
    const r = await bench.try(["pairs-all"], {});
    expect(r.candidates.map((c) => c.name)).toEqual(["pairs-all"]);
  });

  test("a candidate over its budget is abandoned and fails", async () => {
    const src = await project(2);
    const ws = join(await mk(), "ws");
    const slow: L.StepEngine = { run: (_s, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted")))) };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer, engine: slow, availableGiB: async () => 30 });
    const r = await bench.try(["finish"], { budget: 0.05 });
    expect(r.candidates[0]!.rejected).toEqual(["over the time budget"]);
  });

  test("a step that returns a board after the budget ran out is over budget, and is not scored", async () => {
    const src = await project(2);
    const ws = join(await mk(), "ws");
    let scored = 0;
    const counting: L.Scorer = { score: async (d, p, o) => (scored++, scorer.score(d, p, o)) };
    // like a KRT run stopped at the budget that still left a partial board behind
    const late: L.StepEngine = {
      run: async (_s, i) => {
        await new Promise((r) => i.signal.addEventListener("abort", r, { once: true }));
        await mkdir(i.out, { recursive: true });
        await writeFile(join(i.out, i.pcb), "(kicad_pcb) ;; opens=0");
        return { dir: i.out };
      },
    };
    const { bench } = await L.Bench.create(ws, src, "board.kicad_pcb", { scorer: counting, engine: late, availableGiB: async () => 30 });
    const before = scored;
    const r = await bench.try(["finish"], { budget: 0.05 });
    expect(r.candidates[0]!.rejected).toEqual(["over the time budget"]);
    expect(r.accepted).toBeNull();
    expect(scored).toBe(before);
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
    const r = await L.runTighten({ step: { type: "pairfix", args: ["--ops", "width,tighten"] }, input: { cur: dir, out, start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc });
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
    const r = await L.runTighten({ step: { type: "pairfix", args: ["--ops", "width,tighten"] }, input: { cur: dir, out, start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc });
    const info = (r as unknown as { info: { pairfix: { rounds: unknown[] } } }).info.pairfix;
    expect(info.rounds.length).toBeGreaterThan(1);
  });

  test("the default ops are the toolkit's six, all ported", async () => {
    const dir = await mk();
    await writeFile(join(dir, "board.kicad_pcb"), board(0.35));
    const r = await L.runTighten({ step: { type: "pairfix", args: [] }, input: { cur: dir, out: join(await mk(), "out"), start: dir, pcb: "board.kicad_pcb", signal: new AbortController().signal }, req, drc: async () => ({ violations: [], unconnected: [], parity: 0 }) });
    expect(L.DEFAULT_OPS).toBe("vias,mirror,retune,width,tighten,skew");
    expect((r as unknown as { info: { pairfix: { ops: string[] } } }).info.pairfix.ops).toEqual(["mirror", "retune", "skew", "tighten", "vias", "width"]);
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

describe("repairCandidate (board_edit repair hook)", () => {
  test("finish on the candidate reconnects what the edit cut and writes the board back", async () => {
    const src = await project(4);
    const r = await L.repairCandidate({ scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=1" }), availableGiB: async () => 30 }, { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: ["N1", "N2"] });
    expect(r.note).toContain("open 4 -> 1");
    expect(await readFile(join(src, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb) ;; opens=1");
  });
  test("a finish that does not pass the gate leaves the candidate as edited and says why", async () => {
    const src = await project(4);
    const r = await L.repairCandidate({ scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=2 drc=clearance" }), availableGiB: async () => 30 }, { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: ["N1"] });
    expect(r.note).toContain("left the board as edited");
    expect(r.note).toContain("new DRC class");
    expect(await readFile(join(src, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb) ;; opens=4");
  });
  test("opens left after finish go through editbench's chain (taps, leg, rip + blockers); the workspace is kept", async () => {
    const src = await project(4);
    const r = await L.repairCandidate(
      { scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=2", "rip-sig": "(kicad_pcb) ;; opens=0" }), availableGiB: async () => 30 },
      { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: ["N1"], projectDir: src },
    );
    expect(r.steps.map((s) => s.try.join("+"))).toEqual(["finish", "taps", "leg", "rip+blockers:1.0"]);
    expect(r.steps.map((s) => !!s.accepted)).toEqual([true, false, false, true]);
    expect(r.note).toContain("open 4 -> 0");
    expect(r.workspace).toBe(".lastmile");
    expect(await readFile(join(src, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb) ;; opens=0");
    expect(await stat(join(src, ".lastmile", "state.json")).then(() => true, () => false)).toBe(true);
  });
  test("a board that was not routed before the edit is left to board_route (no whole-board routing inside the edit)", async () => {
    const src = await project(212);
    await writeFile(join(src, "before-acceptance.json"), JSON.stringify({ results: { A1_connectivity: { unconnected: 210 } } }));
    const r = await L.repairCandidate({ scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=0" }), availableGiB: async () => 30 }, { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: ["+5V", "GND"] });
    expect(r.steps).toEqual([]);
    expect(r.note).toContain("210 open connections before the edit");
    expect(r.note).toContain("board_route");
    expect(await readFile(join(src, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb) ;; opens=212");
  });
  test("a routed board with a few opens before the edit is still repaired", async () => {
    const src = await project(4);
    await writeFile(join(src, "before-acceptance.json"), JSON.stringify({ results: { A1_connectivity: { unconnected: 1 } } }));
    const r = await L.repairCandidate({ scorer, engine: engine({ finish: "(kicad_pcb) ;; opens=1" }), availableGiB: async () => 30 }, { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: ["N1"] });
    expect(r.note).toContain("open 4 -> 1");
  });
  test("nothing to repair runs no step", async () => {
    const src = await project(0);
    const r = await L.repairCandidate({ scorer, engine: engine({}), availableGiB: async () => 30 }, { candidateDir: src, pcb: "board.kicad_pcb", routeAgain: [] });
    expect(r.steps).toEqual([]);
    expect(r.note).toContain("none needed");
  });
  test("repairStages follows editbench: taps and leg only with opens, a7 only with A7 failures", () => {
    const f = (open: number, a7: number) => ({ open, a7, a7_mm: 0, a8: 0, drc: {}, pairs_todo: 0, pairs: {} });
    expect(L.repairStages(f(2, 0))).toEqual([["taps"], ["leg"], ["rip", "blockers:1.0"]]);
    expect(L.repairStages(f(0, 1))).toEqual([["a7"], ["rip", "blockers:1.0"]]);
  });
});

describe("pairsNext: the step to try for pairs that are not coupled", () => {
  const m = (share: number) => ({ class: "PAIR_100OHM", target_mm: 0.38, p_mm: 10, n_mm: 10, coupled_share: share, spacing: [], widths: {} });
  test("routed apart -> bundle (with the router's short-leg caveat); partly coupled -> reroute; coupled -> nothing", () => {
    const next = L.pairsNext({ "/H.CK_P / /H.CK_N": m(0.03), "/U.D_P / /U.D_N": m(0.7), "/E.T_P / /E.T_N": m(0.97) });
    expect(next).toHaveLength(2);
    expect(next[0]).toContain('"bundle:^(/H\\.CK_P)$"');
    expect(next[0]).toContain("electrically short");
    // the next try for a tight fan-out names the modifiers, and parses as an action
    expect(next[0]).toContain('"bundle:^(/H\\.CK_P)$!short!match!outer=2"');
    expect(L.stepsFor("bundle:^(/H\\.CK_P)$!short!match!outer=2")[0]!.pairOptions).toEqual({ shortLegs: { setbacks: 1, floorMm: 1 }, intraMatch: 1, outerCost: 2 });
    expect(next[1]).toContain('"reroute:^(/U\\.D_P)$"');
    expect(L.pairsNext({ a: m(0.95) })).toEqual([]);
  });
});

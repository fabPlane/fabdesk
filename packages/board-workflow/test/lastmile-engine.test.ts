/**
 * The last-mile step engine with fake engines: KRT plans route and merge onto boards of any file name, a step that
 * needs KRT fails by name without it, `finish` falls back to the host router, `fill` runs in a board.kicad_pcb scratch
 * copy. Also the sweep grid and the net_forensics parser.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lastmile as L, layout, onboard, readRequirements, type Requirements } from "../src/index";
import { BOARD, PRO } from "./edit-fixture";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "bw-engine-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NEW_SEG = `(segment (start 1 1) (end 2 2) (width 0.15) (layer "F.Cu") (net "SIG") (uuid "krt-new"))`;

/** Fake host: KRT stages copy their input board and add one segment; spawns are recorded. */
function fakeLayout(krt: string | null, spawns: string[][]): layout.LayoutHost {
  return {
    tools: { krt, tracemaker: null, kicadCli: "/fake/kicad-cli" },
    spawn: async (cmd, o) => {
      spawns.push(cmd);
      // the router script, whether run directly or through the override wrapper (krt_override.py ... -- SCRIPT ARGS)
      const si = cmd.findIndex((c) => /route(_diff)?\.py$/.test(c));
      if (si >= 0) {
        const t = await readFile(cmd[si + 1]!, "utf8");
        await writeFile(cmd[si + 2]!, t.replace(/\)\s*$/, `\n\t${NEW_SEG}\n)`));
      }
      await writeFile(o.log, "");
      return { code: 0, wallS: 0.1 };
    },
    courtyardDrc: async () => [],
    scoreDrc: async () => ({ violations: [], unconnected: 0, parity: 0 }),
    memAvailableGiB: async () => 20,
    diskFreeGiB: async () => 100,
  };
}

const scorer: L.Scorer = {
  async score(dir) {
    await mkdir(join(dir, ".lastmile"), { recursive: true });
    await writeFile(join(dir, ".lastmile", "drc-run.json"), JSON.stringify({ violations: [], unconnected: [], parity: 0 }));
    await writeFile(join(dir, ".lastmile", "acceptance.json"), JSON.stringify({ summary: {}, results: { A8_pairs: { pairs_to_reroute: [] } } }));
    return { figures: { open: 0 } as never, opens: [], summary: {}, pairsOverSkewLimit: 0, parityChecked: false, a8: { toReroute: [], failing: [] } };
  },
};

/** A project whose board is not called board.kicad_pcb (the toolkit's boards are C6.kicad_pcb, R1N...). */
async function c6(): Promise<{ dir: string; req: Requirements }> {
  const dir = await tmp();
  await writeFile(join(dir, "C6.kicad_pcb"), BOARD);
  await writeFile(join(dir, "C6.kicad_pro"), PRO);
  await onboard(dir, { name: "t", pcb: "C6.kicad_pcb" });
  return { dir, req: (await readRequirements(dir))! };
}

function engine(req: Requirements, krt: string | null, spawns: string[][], fills: Array<{ router: string; dir: string; files: string[] }>) {
  return L.createStepEngine({
    req,
    drc: async () => ({ violations: [], unconnected: [], parity: 0 }),
    scorer,
    layout: fakeLayout(krt, spawns),
    fallbackRouter: "fab_router",
    fill: async (router, dir) => {
      fills.push({ router, dir, files: await readdir(dir) });
      const b = join(dir, "board.kicad_pcb");
      await writeFile(b, (await readFile(b, "utf8")).replace(/\)\s*$/, `\n\t(segment (start 5 5) (end 6 6) (width 0.15) (layer "F.Cu") (net "SIG") (uuid "fill-${router}"))\n)`));
      return { message: `${router} done` };
    },
  });
}

const input = (cur: string, out: string) => ({ cur, out, start: cur, pcb: "C6.kicad_pcb", signal: new AbortController().signal });

describe("step engine", () => {
  test("a KRT step runs its own plan on a board of any name and merges the routed copper", async () => {
    const { dir, req } = await c6();
    const spawns: string[][] = [];
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const e = engine(req, krt, spawns, []);
    const out = join(await tmp(), "rip");
    const r = await e.run(L.stepsFor("rip")[0]!, input(dir, out));
    expect("error" in r ? r.error : null).toBeNull();
    if ("error" in r) return;
    expect(r.dir).toBe(out);
    expect(await readFile(join(out, "C6.kicad_pcb"), "utf8")).toContain('(uuid "krt-new")');
    expect(r.info?.["engine"]).toBe("krt");
    // the taps plan, not a generic route: its stages are the tap widths, each skipped on a board with no tap nets
    const t = await e.run(L.stepsFor("taps")[0]!, input(dir, join(await tmp(), "taps")));
    if ("error" in t) throw new Error(t.error);
    const stages = t.info?.["stages"] as Array<{ name: string; skipped?: string }>;
    expect(stages.map((s) => s.name)).toEqual(["tap0.3", "tap0.25", "tap0.2", "tap0.15"]);
    expect(stages.every((s) => s.skipped === "nothing selected")).toBe(true);
  });

  test("rip routes with rip-sig's arguments (signal nets ripped, pairs and power protected)", async () => {
    const { dir, req } = await c6();
    const spawns: string[][] = [];
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const r = await engine(req, krt, spawns, []).run(L.stepsFor("rip")[0]!, input(dir, join(await tmp(), "rip")));
    expect("error" in r).toBe(false);
    const route = spawns.find((c) => c.some((x) => x.endsWith("route.py")))!;
    expect(route).toContain("--rip-existing-nets");
    expect(route).toContain("--keep-input-copper");
  });

  test("repair: rips, then routes what the rip opened with the step's plan; nothing ripped leaves the board as it was", async () => {
    const { dir, req } = await c6();
    const spawns: string[][] = [];
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const e = engine(req, krt, spawns, []);
    const empty = await e.run(L.stepsFor("window:50,30,55,35")[0]!, input(dir, join(await tmp(), "w0")));
    if ("error" in empty) throw new Error(empty.error);
    expect(empty.skipped).toBe(true);
    expect(empty.dir).toBe(dir);
    expect(spawns).toHaveLength(0);
    const out = join(await tmp(), "w1");
    const r = await e.run(L.stepsFor("window:9,9,21,11")[0]!, input(dir, out));
    if ("error" in r) throw new Error(r.error);
    expect(r.dir).toBe(join(out, "route"));
    const rip = r.info?.["rip"] as { removed: number; nets: string[] };
    expect(rip.removed).toBeGreaterThan(0);
    expect(rip.nets).toContain("SIG");
    // opens-first: the nets open before the rip are routed first, then everything the rip opened
    expect((r.info?.["stages"] as Array<{ name: string }>).map((s) => s.name)).toEqual(["opens-first", "finish"]);
    const board = await readFile(join(out, "route", "C6.kicad_pcb"), "utf8");
    expect(board).not.toContain("sg-19.5-10-10-10-SIG");
    expect(board).toContain('(uuid "krt-new")');
  });

  test("region:BOX!escape runs route_region's order: rip all nets in the box (no router), escapes on the ripped board, then after-cut routes the cut pairs as pairs", async () => {
    const { dir, req } = await c6();
    // SIG / SIG2 as a declared pair, so after-cut's pair stage names the nets the cut opened (rip.json carried through escape)
    req.acceptance.net_classes.classes["PAIRX"] = { pairs: [["SIG", "SIG2"]], nets: ["SIG", "SIG2"], diff_pair_width: 0.2, diff_pair_gap: 0.15, layers: ["F.Cu"], track_width: 0.2 } as never;
    const spawns: string[][] = [];
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const e = engine(req, krt, spawns, []);
    const steps = L.stepsFor("region:9,9,21,15!escape");
    expect(steps.map((s) => s.type)).toEqual(["cut", "escape", "krt"]);
    let cur = dir;
    const infos: Array<Record<string, unknown> | undefined> = [];
    for (const [i, st] of steps.entries()) {
      const r = await e.run(st, { ...input(cur, join(await tmp(), `s${i}`)), start: dir });
      if ("error" in r) throw new Error(r.error);
      infos.push(r.info);
      if (i === 0) {
        expect(spawns).toHaveLength(0); // the cut runs no router
        const ripped = await readFile(join(r.dir, "C6.kicad_pcb"), "utf8");
        expect(ripped).not.toContain("sg-19.5-10-10-10-SIG");
        expect(ripped).not.toContain("sg-20.5-10-19.5-14-SIG2");
        expect(ripped).toContain("sg-39.5-18-29-20-VIN"); // outside the box
        expect(JSON.parse(await readFile(join(r.dir, "rip.json"), "utf8")).nets).toEqual(["SIG", "SIG2"]);
      }
      cur = r.dir;
    }
    expect(infos[0]?.["removed"]).toEqual({ segment: 2, via: 0, arc: 0, pruned: 0 });
    expect(infos[1]?.["engine"]).toBe("power_escape");
    const diff = spawns.find((c) => c.some((x) => x.endsWith("route_diff.py")))!;
    const nets = diff.slice(diff.indexOf("--nets") + 1, diff.indexOf("--nets") + 3);
    expect(nets.sort()).toEqual(["SIG", "SIG2"]);
    expect(await readFile(join(cur, "C6.kicad_pcb"), "utf8")).toContain('(uuid "krt-new")');
  });

  test("cut runs without KRT; like route_region it prunes dangling copper on the whole board even when the box is empty", async () => {
    const { dir, req } = await c6();
    const e = engine(req, null, [], []);
    const r = await e.run(L.stepsFor("cut:50,30,55,35")[0]!, input(dir, join(await tmp(), "c0")));
    if ("error" in r) throw new Error(r.error);
    const removed = r.info?.["removed"] as { segment: number; via: number; pruned: number };
    expect([removed.segment, removed.via]).toEqual([0, 0]);
    // the fixture's GND stub ends in a via joined to nothing: route_region's prune_dangling drops it
    expect(removed.pruned).toBeGreaterThan(0);
  });

  test("without KRT a KRT step fails naming KRT; finish falls back to the host router", async () => {
    const { dir, req } = await c6();
    const fills: Array<{ router: string; dir: string; files: string[] }> = [];
    const e = engine(req, null, [], fills);
    for (const action of ["rip", "taps", "pairs-all", "pairs", "blockers:1.0", "a7", "nudge:R1@22,10"]) {
      const r = await e.run(L.stepsFor(action)[0]!, input(dir, join(await tmp(), "x")));
      expect("error" in r ? r.error : "").toContain("KiCadRoutingTools");
    }
    const out = join(await tmp(), "finish");
    const r = await e.run(L.stepsFor("finish")[0]!, input(dir, out));
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.info?.["fallback"]).toContain("fab_router");
    expect(fills[0]!.files).toContain("board.kicad_pcb");
    expect(await readFile(join(out, "C6.kicad_pcb"), "utf8")).toContain("fill-fab_router");
    // router scratch files are kept out of the board folder copies
    expect((await readdir(out)).filter((f) => f === "tracemaker" || f === "fill")).toEqual([]);
  });

  test("a missing KRT installs on first use through the host; a failed install's reason ends the step error", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const spawns: string[][] = [];
    const asked: string[] = [];
    const host = { ...fakeLayout(null, spawns), ensure: async (e: layout.EngineId) => (asked.push(e), { path: krt }) };
    const mk = (h: layout.LayoutHost, fills: Array<{ router: string }> = []) =>
      L.createStepEngine({ req, drc: async () => ({ violations: [], unconnected: [], parity: 0 }), scorer, layout: h, fallbackRouter: "fab_router", fill: async (router, d) => (fills.push({ router }), { message: d }) });
    const r = await mk(host).run(L.stepsFor("rip")[0]!, input(dir, join(await tmp(), "rip")));
    expect("error" in r ? r.error : null).toBeNull();
    expect(asked).toEqual(["krt"]);
    expect(host.tools.krt).toBe(krt); // kept: the next step does not ask again
    await mk(host).run(L.stepsFor("rip")[0]!, input(dir, join(await tmp(), "rip2")));
    expect(asked).toEqual(["krt"]);

    const why = "KiCadRoutingTools did not install: KiCadRoutingTools 0.23.8 ships no grid_router for linux-arm64; building it needs Rust (cargo, https://rustup.rs). Install them and Retry, or set FABDESK_KRT_DIR to a build.";
    const failing = { ...fakeLayout(null, []), ensure: async () => ({ path: null, why }) };
    const bad = await mk(failing).run(L.stepsFor("a7")[0]!, input(dir, join(await tmp(), "a7")));
    const err = "error" in bad ? bad.error : "";
    expect(err).toContain("KRT did not install");
    expect(err.endsWith("set FABDESK_KRT_DIR to a build.)")).toBe(true);
    expect(err.length).toBeLessThanOrEqual(160);
    const fills: Array<{ router: string }> = [];
    const fin = await mk(failing, fills).run(L.stepsFor("finish")[0]!, input(dir, join(await tmp(), "fin")));
    expect("error" in fin).toBe(false);
    if (!("error" in fin)) expect(String(fin.info?.["fallback"])).toMatch(/did not install.*finish ran on fab_router/);
    expect(fills.map((f) => f.router)).toEqual(["fab_router"]);
  });

  test("fill:ROUTER works on a stem-named board through a board.kicad_pcb scratch copy", async () => {
    const { dir, req } = await c6();
    const fills: Array<{ router: string; dir: string; files: string[] }> = [];
    const out = join(await tmp(), "fill");
    const r = await engine(req, null, [], fills).run(L.stepsFor("fill:tracemaker")[0]!, input(dir, out));
    expect("error" in r ? r.error : null).toBeNull();
    expect(fills[0]!.router).toBe("tracemaker");
    expect(basename(fills[0]!.dir)).toBe("fill");
    expect(await readFile(join(out, "C6.kicad_pcb"), "utf8")).toContain("fill-tracemaker");
  });
});

describe("step engine: plan files and aborts", () => {
  test("plan:FILE resolves in the project, refuses a path outside it and names a missing file", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    await mkdir(join(dir, "plans"), { recursive: true });
    await writeFile(join(dir, "plans", "mine.json"), JSON.stringify(L.LASTMILE_PLANS["finish"]));
    const outside = await tmp();
    await writeFile(join(outside, "evil.json"), JSON.stringify(L.LASTMILE_PLANS["finish"]));
    const spawns: string[][] = [];
    const e = L.createStepEngine({
      req,
      drc: async () => ({ violations: [], unconnected: [], parity: 0 }),
      scorer,
      layout: fakeLayout(krt, spawns),
      fallbackRouter: "fab_router",
      fill: async () => ({}),
      planRoot: dir,
    });
    // the daemon's cwd is not the project: a relative plan path still resolves against the project
    const r = await e.run(L.stepsFor("plan:plans/mine.json")[0]!, input(dir, join(await tmp(), "p")));
    expect("error" in r ? r.error : null).toBeNull();
    expect(spawns.length).toBeGreaterThan(0);
    await expect(e.run(L.stepsFor(`plan:${join(outside, "evil.json")}`)[0]!, input(dir, join(await tmp(), "q")))).rejects.toThrow("outside the project");
    await expect(e.run(L.stepsFor("plan:../evil.json")[0]!, input(dir, join(await tmp(), "q2")))).rejects.toThrow(/outside the project|no such file/);
    await expect(e.run(L.stepsFor("plan:plans/none.json")[0]!, input(dir, join(await tmp(), "r")))).rejects.toThrow("plan:plans/none.json: no such file");
    const noRoot = engine(req, krt, [], []);
    await expect(noRoot.run(L.stepsFor("plan:plans/mine.json")[0]!, input(dir, join(await tmp(), "s")))).rejects.toThrow("no project folder");
  });

  test("opens: finish limited to the nets open on the start board (from the bench's score); none scored, the stage is skipped", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    await writeFile(join(dir, "lastmile.score.json"), JSON.stringify({ opens: [{ net: "SIG" }, { net: "SIG" }, { net: "N2" }] }));
    const spawns: string[][] = [];
    const r = await engine(req, krt, spawns, []).run(L.stepsFor("opens")[0]!, input(dir, join(await tmp(), "o")));
    expect("error" in r).toBe(false);
    const route = spawns.find((c) => c.some((x) => /route\.py$/.test(x)))!;
    const at = route.indexOf("--nets");
    expect(at).toBeGreaterThan(0);
    expect(route.slice(at + 1, at + 3).sort()).toEqual(["N2", "SIG"]);
    expect(route).not.toContain("@open-before");
    // the toolkit's finish is unchanged: no --nets
    const spawns2: string[][] = [];
    await engine(req, krt, spawns2, []).run(L.stepsFor("finish")[0]!, input(dir, join(await tmp(), "f")));
    expect(spawns2.find((c) => c.some((x) => /route\.py$/.test(x)))!).not.toContain("--nets");
  });

  test("a step's avoidLayers apply after @layers expands: an inner layer left out, outer layers at cost 10 (jetson's working plan)", async () => {
    const { dir, req } = await c6();
    const ten = ["F.Cu", ...Array.from({ length: 8 }, (_, i) => `In${i + 1}.Cu`), "B.Cu"];
    const { no_track_layers: _n, ...sp } = req.acceptance.stack_policy;
    req.acceptance.stack_policy = { ...sp, copper_layers: ten, plane_layers: ["In1.Cu", "In3.Cu", "In6.Cu", "In8.Cu"] } as never;
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    await writeFile(join(dir, "lastmile.score.json"), JSON.stringify({ opens: [{ net: "SIG" }] }));
    const spawns: string[][] = [];
    const step = { ...L.stepsFor("opens")[0]!, avoidLayers: ["F.Cu", "In4.Cu", "B.Cu"] };
    const out = join(await tmp(), "o");
    const r = await engine(req, krt, spawns, []).run(step, input(dir, out));
    expect("error" in r).toBe(false);
    const route = spawns.find((c) => c.some((x) => /route\.py$/.test(x)))!;
    const at = route.indexOf("--layers");
    expect(route.slice(at + 1, at + 6)).toEqual(["F.Cu", "In2.Cu", "In5.Cu", "In7.Cu", "B.Cu"]);
    expect(route[at + 6]).toBe("--layer-costs");
    expect(route.slice(at + 7, at + 12)).toEqual(["10", "1", "1", "1", "10"]);
    expect(route).toContain("--keep-input-copper");
    expect((r as { info: Record<string, unknown> }).info["avoided"]).toEqual([{ stage: "finish", removed: ["In4.Cu"], costed: ["F.Cu", "B.Cu"] }]);
    // the plan KRT ran is written with the change and says so
    const plan = JSON.parse(await readFile(join(out, ".lastmile", "krt", "plan.json"), "utf8")) as layout.KrtPlan;
    expect(plan.note).toContain("kept out of reach: F.Cu, In4.Cu, B.Cu");
    // without avoidLayers the same step routes on every signal layer at the default cost
    const plain: string[][] = [];
    await engine(req, krt, plain, []).run(L.stepsFor("opens")[0]!, input(dir, join(await tmp(), "p")));
    const r2 = plain.find((c) => c.some((x) => /route\.py$/.test(x)))!;
    expect(r2.slice(r2.indexOf("--layers") + 1, r2.indexOf("--layers") + 7)).toEqual(["F.Cu", "In2.Cu", "In4.Cu", "In5.Cu", "In7.Cu", "B.Cu"]);
    expect(r2).not.toContain("--layer-costs");
  });

  test("!short / !match: the pair stages run through the override wrapper with the short-leg rule lowered and intra-pair matching; other stages run directly", async () => {
    const { dir, req } = await c6();
    req.acceptance.net_classes.classes["PAIRX"] = { pairs: [["SIG", "SIG2"]], nets: ["SIG", "SIG2"], diff_pair_width: 0.2, diff_pair_gap: 0.15, layers: ["F.Cu"], track_width: 0.2 } as never;
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const spawns: string[][] = [];
    const steps = L.stepsFor("pairs-all!short!match=0.8");
    expect(steps[0]!.pairOptions).toEqual({ shortLegs: { setbacks: 1, floorMm: 1 }, intraMatch: 0.8 });
    const out = join(await tmp(), "o");
    const r = await engine(req, krt, spawns, []).run(steps[0]!, input(dir, out));
    if ("error" in r) throw new Error(r.error);
    const work = join(out, ".lastmile", "krt");
    const diff = spawns.find((c) => c.some((x) => x.endsWith("route_diff.py")))!;
    const py = layout.krtPaths(krt).python;
    expect(diff.slice(0, py.length + 1)).toEqual([...py, join(work, "krt_override.py")]);
    expect(diff.slice(py.length + 1, py.length + 6)).toEqual(["--set", "diff_pair_multipoint.DIFF_PAIR_MIN_COUPLED_FLOOR_MM=1", "--set", "diff_pair_multipoint.DIFF_PAIR_MIN_COUPLED_SETBACKS=1", "--"]);
    // the script's own argv follows unchanged: input, output, then the stage's args with the matching flags added
    const si = diff.findIndex((x) => x.endsWith("route_diff.py"));
    expect(diff[si + 1]).toBe(join(work, "s0.kicad_pcb"));
    expect(diff[si + 2]).toBe(join(work, "s1.kicad_pcb"));
    expect(diff.slice(diff.indexOf("--diff-pair-intra-match"), diff.indexOf("--diff-pair-intra-match") + 3)).toEqual(["--diff-pair-intra-match", "--length-match-tolerance", "0.8"]);
    for (const c of spawns.filter((c) => c.some((x) => /[\\/]route\.py$/.test(x)))) {
      expect(c.join(" ")).not.toContain("krt_override.py");
      expect(c).not.toContain("--diff-pair-intra-match");
    }
    expect(await readFile(join(work, "krt_override.py"), "utf8")).toBe(layout.KRT_OVERRIDE_SCRIPT);
    // plan.json and the stage records say what ran
    const plan = JSON.parse(await readFile(join(work, "plan.json"), "utf8")) as layout.KrtPlan;
    const pairStage = plan.stages.find((s) => s.tool === "route_diff")!;
    expect(pairStage["krt_overrides"]).toEqual({ diff_pair_multipoint: { DIFF_PAIR_MIN_COUPLED_SETBACKS: 1, DIFF_PAIR_MIN_COUPLED_FLOOR_MM: 1 } });
    expect(plan.stages.filter((s) => s.tool !== "route_diff").every((s) => !s["krt_overrides"])).toBe(true);
    expect(plan.note).toContain("short legs coupled");
    const krtRec = JSON.parse(await readFile(join(work, "krt.json"), "utf8")) as layout.RouteKrtRecord;
    expect(krtRec.stages.find((s) => s["tool"] === "route_diff")!["krt_overrides"]).toEqual(pairStage["krt_overrides"]);
    expect((r.info?.["pair_options"] as Array<{ stage: string }>).map((x) => x.stage)).toEqual(["pairs-pairx"]);
    // the same action without modifiers runs KRT directly
    const plain: string[][] = [];
    await engine(req, krt, plain, []).run(L.stepsFor("pairs-all")[0]!, input(dir, join(await tmp(), "p")));
    expect(plain.flat().some((x) => x.endsWith("krt_override.py"))).toBe(false);
  });

  test("a constant the installed KRT does not have stops the stage by name; a plan with no pair stage refuses !short", async () => {
    const { dir, req } = await c6();
    req.acceptance.net_classes.classes["PAIRX"] = { pairs: [["SIG", "SIG2"]], nets: ["SIG", "SIG2"], diff_pair_width: 0.2, diff_pair_gap: 0.15, layers: ["F.Cu"], track_width: 0.2 } as never;
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const host = fakeLayout(krt, []);
    const failing: layout.LayoutHost = {
      ...host,
      spawn: async (cmd, o) => {
        if (cmd.some((x) => x.endsWith("krt_override.py"))) {
          await writeFile(o.log, "KRT_OVERRIDE_ERROR: diff_pair_multipoint has no DIFF_PAIR_MIN_COUPLED_SETBACKS (KiCadRoutingTools changed?); the stage was not run\n");
          return { code: 3, wallS: 0.1 };
        }
        return host.spawn(cmd, o);
      },
    };
    const rec = await layout.routeKrt(failing, { placed: dir, out: join(await tmp(), "k"), plan: L.LASTMILE_PLANS["pairs-g2"] as never, stem: "C6", req, score: false, pairOptions: { shortLegs: { setbacks: 1, floorMm: 1 } } });
    expect(rec.error).toBe("stage pairs-pairx: diff_pair_multipoint has no DIFF_PAIR_MIN_COUPLED_SETBACKS (KiCadRoutingTools changed?); the stage was not run");
    expect(rec.stages).toHaveLength(1);
    // a plan without a route_diff stage: the option would do nothing, so the run is refused before any stage
    const spawns: string[][] = [];
    await expect(layout.routeKrt(fakeLayout(krt, spawns), { placed: dir, out: join(await tmp(), "f"), plan: L.LASTMILE_PLANS["finish"] as never, stem: "C6", req, score: false, pairOptions: { shortLegs: { setbacks: 1, floorMm: 1 } } })).rejects.toThrow(/no route_diff stage/);
    expect(spawns).toHaveLength(0);
    // a plan file's own krt_overrides are honoured, and checked
    const own = structuredClone(L.LASTMILE_PLANS["pairs-g2"]) as unknown as layout.KrtPlan;
    own.stages[0]!["krt_overrides"] = { diff_pair_multipoint: { "bad name": 1 } };
    await expect(layout.routeKrt(fakeLayout(krt, spawns), { placed: dir, out: join(await tmp(), "g"), plan: own, stem: "C6", req, score: false })).rejects.toThrow(/not a Python name/);
    expect(spawns).toHaveLength(0);
  });

  test("an aborted signal starts nothing: no step, no KRT stage, no process", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const spawns: string[][] = [];
    const ac = new AbortController();
    ac.abort();
    const inp = { ...input(dir, join(await tmp(), "a")), signal: ac.signal };
    await expect(engine(req, krt, spawns, []).run(L.stepsFor("finish")[0]!, inp)).rejects.toThrow();
    expect(spawns).toHaveLength(0);
    // routeKrt itself stops before its first stage
    const rec = await layout.routeKrt({ ...fakeLayout(krt, spawns), signal: ac.signal }, { placed: dir, out: join(await tmp(), "k"), plan: L.LASTMILE_PLANS["finish"] as never, stem: "C6", req, score: false });
    expect(rec.error).toMatch(/^aborted before stage/);
    expect(spawns).toHaveLength(0);
    // the real process runner refuses to start a child it could never stop
    const d = await tmp();
    const marker = join(d, "ran");
    await expect(layout.nodeRun(["sh", "-c", `touch ${marker}`], { log: join(d, "log"), signal: ac.signal })).rejects.toThrow("not started");
    await new Promise((r) => setTimeout(r, 200));
    expect((await readdir(d)).includes("ran")).toBe(false);
  });
});

describe("admission names the engine", () => {
  test("KRT steps are admitted as krt (grid estimate); fill:freerouting and fill:fab_router are not", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const admits: Array<{ kind: string; engine?: string }> = [];
    const host = { ...fakeLayout(krt, []), admit: async (kind: string, _l: string, _p: string[], o?: { engine?: string }) => (admits.push({ kind, ...(o?.engine ? { engine: o.engine } : {}) }), { release() {} }) };
    const e = L.createStepEngine({
      req, scorer, layout: host as never, fallbackRouter: "fab_router",
      drc: async () => ({ violations: [], unconnected: [], parity: 0 }),
      fill: async (_r, d) => { await writeFile(join(d, "board.kicad_pcb"), await readFile(join(d, "board.kicad_pcb"), "utf8")); return {}; },
    });
    for (const a of ["finish", "fill:freerouting", "fill:fab_router", "fill:tracemaker"]) await e.run(L.stepsFor(a)[0]!, input(dir, join(await tmp(), a.replace(":", "_"))));
    expect(admits).toEqual([
      { kind: "router", engine: "krt" },
      { kind: "router", engine: "freerouting" },
      { kind: "router", engine: "fab_router" },
      { kind: "tracemaker", engine: "tracemaker" },
    ]);
  });
});

describe("finish changes only what was open", () => {
  test("finish keeps new copper on the open nets only; the router's touches on other nets are counted, not kept", async () => {
    const { dir, req } = await c6();
    const krt = join(dir, "krt");
    await mkdir(join(krt, "src/plugins"), { recursive: true });
    const OTHER = `(segment (start 7 7) (end 8 8) (width 0.15) (layer "F.Cu") (net "GND") (uuid "krt-gnd-stub"))`;
    const host: layout.LayoutHost = {
      ...fakeLayout(krt, []),
      spawn: async (cmd, o) => {
        const si = cmd.findIndex((c) => c.endsWith(".py"));
        if (/route(_diff)?\.py$/.test(cmd[si] ?? "")) {
          const t = await readFile(cmd[si + 1]!, "utf8");
          await writeFile(cmd[si + 2]!, t.replace(/\)\s*$/, `\n\t${NEW_SEG}\n\t${OTHER}\n)`));
        }
        await writeFile(o.log, "");
        return { code: 0, wallS: 0.1 };
      },
    };
    // the start board is open on SIG only
    const openSig: L.Scorer = {
      async score(d) {
        const sc = await scorer.score(d, "", { parity: false });
        await writeFile(join(d, ".lastmile", "drc-run.json"), JSON.stringify({ violations: [], unconnected: [{ items: [{ description: "Pad 1 [SIG] of U1", pos: { x: 31, y: 20 } }, { description: "Pad 1 [SIG] of R1", pos: { x: 19.5, y: 10 } }] }], parity: 0 }));
        return sc;
      },
    };
    const e = L.createStepEngine({ req, scorer: openSig, layout: host, fallbackRouter: "fab_router", drc: async () => ({ violations: [], unconnected: [], parity: 0 }), fill: async () => ({}) });
    const out = join(await tmp(), "finish");
    const r = await e.run(L.stepsFor("finish")[0]!, input(dir, out));
    if ("error" in r) throw new Error(r.error);
    const board = await readFile(join(out, "C6.kicad_pcb"), "utf8");
    expect(board).toContain('(net "SIG")');
    expect(board).toContain("(start 1 1) (end 2 2)");
    expect(board).not.toContain("(start 7 7) (end 8 8)");
    expect(board).toContain("sg-40.5-18-40.5-25-GND"); // the rest of the board exactly as it was
    expect(r.info?.["restricted"]).toMatchObject({ only_open_nets: 1, other_nets_router_touched_not_kept: 1, other_nets_sample: ["GND"] });
  });

  test("copper by net: changed nets ignore uuids and number formatting; keepCopperOfNets drops other nets", () => {
    const a = `(kicad_pcb\n\t(segment (start 1 1) (end 2 2) (width 0.15) (layer "F.Cu") (net "A") (uuid "u1"))\n\t(segment (start 3 3) (end 4 4) (width 0.15) (layer "F.Cu") (net "B") (uuid "u2"))\n)`;
    const b = `(kicad_pcb\n\t(segment\n\t\t(start 1.0 1) (end 2 2.00) (width 0.15) (layer "F.Cu") (net "A") (uuid "x9"))\n\t(segment (start 3 3) (end 4 5) (width 0.15) (layer "F.Cu") (net "B") (uuid "u2"))\n\t(via (at 9 9) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "C") (uuid "v1"))\n)`;
    expect(layout.changedCopperNets(a, b)).toEqual(["B", "C"]);
    const kept = layout.keepCopperOfNets(b, new Set(["C"]));
    expect(kept).toContain('(net "C")');
    expect(kept).not.toContain('(net "A")');
    expect(kept).not.toContain('(net "B")');
  });
});

describe("sweep", () => {
  test("a grid of poses round the part, flipped, without the current pose, each followed by the chain", () => {
    const acts = L.sweepActions(BOARD, ["R1"], { span: 0.5, step: 0.5, rotations: "flip", then: "blockers:1.0" });
    expect(acts).toHaveLength(3 * 3 * 2 - 1);
    expect(acts).toContain("nudge:R1@20.50,9.50@180~0.25+blockers:1.0");
    expect(acts).not.toContain("nudge:R1@20.00,10.00@0~0.25+blockers:1.0");
    expect(() => L.sweepActions(BOARD, ["NOPE"])).toThrow(/NOPE/);
  });
});

describe("net_forensics", () => {
  test("one line per stuck end with the nearest foreign copper", () => {
    const out = L.forensicsLines(
      [
        "=== c18::USB_DP ===",
        "  WALL around island2-end (10.0, 20.0), r=1.0",
        "    c18::GND: track F.Cu 0.2mm, 0.31mm",
        "    VBUS: via, 0.5mm",
        "  GAP 3.2 mm between islands",
      ].join("\n"),
    );
    expect(out).toEqual(["USB_DP", "    end (10.0, 20.0): GND track F.Cu 0.2mm; VBUS via", "  GAP 3.2 mm between islands"]);
  });
});

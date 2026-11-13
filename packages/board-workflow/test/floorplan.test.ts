import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFixedKeepouts,
  beyondBox,
  blockPlan,
  boardPoses,
  claimedParts,
  floorplanRun,
  gatherParts,
  groupRefs,
  prepareBlockPass,
  readFloorplan,
  selectGroups,
  singlePadParts,
  stageFloorplan,
  FLOORPLAN_POOL_BASE,
  type FlowState,
  stagingRegion,
  type Blocks,
  type Floorplan,
  type LayoutHost,
} from "../src/layout/index";
import { footprintSpans, lockedRefs, pose, setPose } from "../src/layout/text";
import { regionRip } from "../src/lastmile/replace";
import { stepsFor } from "../src/lastmile/actions";
import type { Requirements } from "../src/requirements";

const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, o: { side?: "F" | "B"; tht?: boolean } = {}) => `
  (footprint "Lib:${ref}"
    (layer "${o.side ?? "F"}.Cu")
    (transform
      (translate ${x} ${y})
      (rotate 0)
      (scale 1 1))
    (property "Reference" "${ref}" (at 0 -2 0))
    (fp_rect (start -1 -1) (end 1 1) (layer "${o.side ?? "F"}.CrtYd"))
    ${pads.map(([n, net, px, py]) => `(pad "${n}" ${o.tht ? "thru_hole circle" : "smd rect"} (at ${px} ${py} 0) (size 0.4 0.4) (layers "F.Cu") (net "${net}"))`).join("\n    ")}
  )`;
const jPads: Array<[string, string, number, number]> = Array.from({ length: 8 }, (_, i) => [String(i + 1), `S${i}`, -0.875 + i * 0.25, 0.5]);
const BOARD = `(kicad_pcb (version 20250114)
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
  ${fp("J1", 5, 5, jPads)}
  ${fp("U1", 30, 20, [["1", "S0", -0.5, 0], ["2", "S1", 0.5, 0], ["3", "GND", 0, 0.5]])}
  ${fp("R1", 32, 24, [["1", "S2", -0.5, 0], ["2", "S3", 0.5, 0]])}
  ${fp("R2", 34, 24, [["1", "S4", -0.5, 0], ["2", "S5", 0.5, 0]])}
  ${fp("TP1", 36, 26, [["1", "S6", 0, 0]])}
  ${fp("C1", 10, 20, [["1", "S7", -0.5, 0], ["2", "GND", 0.5, 0]])}
  (segment (start 30 20) (end 32 24) (width 0.15) (layer "F.Cu") (net "S0") (uuid "a"))
  (segment (start 32 24) (end 34 24) (width 0.15) (layer "F.Cu") (net "S0") (uuid "b"))
  (segment (start 9.5 20) (end 5.875 5.5) (width 0.15) (layer "F.Cu") (net "S7") (uuid "c"))
  (via (at 31 22) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "S0") (uuid "d"))
)
`;
const FIXED = /^J/;
const blocks: Blocks = { mcu: { parts: ["U1", "R1", "R2", "TP1"] }, pwr: { parts: ["C1"] }, conn: { parts: ["J1"] } };
const plan: Floorplan = {
  courtyard_clearance_mm: 0.3,
  groups: [
    { name: "core", blocks: ["mcu"], region: [20, 10, 38, 28] },
    { name: "core_row", of: "core", parts: ["R2"], region: [20, 10, 38, 28], courtyard_clearance_mm: 0.2 },
    { name: "power", blocks: ["pwr"], region: [2, 12, 18, 28], pinned: {} },
  ],
};

describe("floorplan data", () => {
  test("validation names the problem", () => {
    expect(() => readFloorplan({ groups: [] }, blocks)).toThrow(/courtyard_clearance_mm/);
    expect(() => readFloorplan({ courtyard_clearance_mm: 0.2, groups: [{ name: "x", region: [0, 0, 1], blocks: ["mcu"] }] }, blocks)).toThrow(/region/);
    expect(() => readFloorplan({ courtyard_clearance_mm: 0.2, groups: [{ name: "x", region: [0, 0, 1, 1], blocks: ["nope"] }] }, blocks)).toThrow(/no block nope/);
    expect(readFloorplan(plan, blocks)).toBe(plan);
  });

  test("group parts: claimed by sub-groups, never fixed, single-pad or pinned", () => {
    const single = singlePadParts(BOARD, FIXED);
    expect([...single]).toEqual(["TP1"]);
    const claimed = claimedParts(plan);
    expect(groupRefs(plan.groups[0]!, blocks, single, claimed, FIXED)).toEqual(["R1", "U1"]);
    expect(groupRefs(plan.groups[1]!, blocks, single, claimed, FIXED)).toEqual(["R2"]);
    expect(groupRefs({ ...plan.groups[0]!, pinned: { U1: [30, 20, 0] } }, blocks, single, claimed, FIXED)).toEqual(["R1"]);
    expect(selectGroups(plan, ["core"]).map((g) => g.name)).toEqual(["core", "core_row"]);
  });

  test("staging and keep-out boxes derive from the outline (C6 values for a 74.9 x 65.4 board)", () => {
    expect(stagingRegion(BOARD)).toEqual([75, 20, 95, 40]);
    expect(beyondBox(BOARD)).toEqual([-5, -5, 45, 35]);
    const c6 = BOARD.replace("(end 40 30)", "(end 74.9 65.4)");
    expect(stagingRegion(c6)).toEqual([110, 20, 130, 40]);
    expect(beyondBox(c6)).toEqual([-5, -5, 80, 71]);
  });
});

describe("block pass (block_pass prepare, floorplan_run gather / fixed_keepouts)", () => {
  test("gather moves the parts to the free point nearest the region centre", () => {
    const out = gatherParts(BOARD, ["U1", "R1"], [20, 10, 38, 28]);
    const p = boardPoses(out);
    expect(p.get("U1")!.slice(0, 2)).toEqual([29, 19]);
    expect(p.get("R1")!.slice(0, 2)).toEqual([29, 19]);
    expect(out).toContain("(translate 29.0000 19.0000)");
    // a fixed courtyard over the centre pushes the point away by the part's half-diagonal + 0.5 mm
    const avoided = boardPoses(gatherParts(BOARD, ["U1"], [20, 10, 38, 28], [[27, 17, 31, 21]])).get("U1")!;
    expect(avoided[0] < 27 - 1.9 || avoided[0] > 31 + 1.9 || avoided[1] < 17 - 1.9 || avoided[1] > 21 + 1.9).toBe(true);
  });

  test("prepare locks every other footprint and keeps the placer inside the region on F and B", () => {
    const r = prepareBlockPass(BOARD, ["U1", "R1"], [20, 10, 38, 28], [-5, -5, 45, 35]);
    expect(r.movable).toBe(2);
    expect(r.locked).toBe(4);
    expect((r.text.match(/\(locked yes\)/g) ?? []).length).toBe(4);
    expect([...lockedRefs(r.text)]).toContain("C1");
    expect(r.text.match(/block-pass-keepout/g)!.length).toBe(8);
    expect(() => prepareBlockPass(BOARD, ["U9"], [0, 0, 1, 1], [-5, -5, 45, 35])).toThrow(/unknown refs: U9/);
  });

  test("fixed keep-outs: the connector's courtyard, and its pad field on the other side when dense SMD", () => {
    const out = addFixedKeepouts(BOARD, FIXED);
    const zones = [...out.matchAll(/\(layer "([FB])\.Cu"\) \(uuid "[^"]+"\) \(name "block-pass-keepout"\)/g)].map((m) => m[1]);
    expect(zones).toEqual(["F", "B"]);
    const tht = addFixedKeepouts(BOARD.replace(/smd rect \(at (-?[\d.]+) 0\.5 0\)/g, "thru_hole circle (at $1 0.5 0)"), FIXED);
    expect(tht.match(/block-pass-keepout/g)!.length).toBe(1);
  });
});

const tmp = await mkdtemp(join(tmpdir(), "fabdesk-floorplan-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));

/** A stand-in for tracemaker-place: every unlocked footprint of the pass input to a grid point inside the region. */
function fakeHost(o: { moveLocked?: boolean; courtyard?: Array<{ rule: string; items: Array<{ description: string }> }> } = {}): LayoutHost & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    tools: { krt: null, tracemaker: join(tmp, "bin", "tracemaker"), kicadCli: null },
    spawn: async (cmd, opts) => {
      calls.push(cmd);
      let text = await readFile(cmd[1]!, "utf8");
      // locked: `(locked` before the first property (lockedRefs looks 400 characters ahead: these footprints are short)
      const locked = new Set([...footprintSpans(text)].filter(([, [a, b]]) => /\(locked/.test(text.slice(a, b).split("(property")[0]!)).map(([r]) => r));
      let k = 0;
      for (const [ref] of footprintSpans(text)) {
        if (locked.has(ref) && !(o.moveLocked && ref === "C1")) continue;
        const sp = footprintSpans(text).get(ref)!;
        const body = text.slice(sp[0], sp[1]);
        text = text.slice(0, sp[0]) + setPose(body, 22 + 3 * k, 12 + 2 * k, (pose(body)[2] + 90) % 360) + text.slice(sp[1]);
        k++;
      }
      await writeFile(cmd[cmd.indexOf("-o") + 1]!, text);
      await writeFile(cmd[cmd.indexOf("--json") + 1]!, JSON.stringify({ fixed_parts: [] }));
      await writeFile(opts.log, `legalisation: ${k} placed, 0 failed\nconflicts before 0 after 0 new 0\n`);
      return { code: 0, wallS: 0 };
    },
    courtyardDrc: async () => o.courtyard ?? [],
    scoreDrc: async () => {
      throw new Error("unused");
    },
    memAvailableGiB: async () => 64,
    diskFreeGiB: async () => 100,
  };
}

describe("floorplanRun (floorplan_run.py)", async () => {
  await mkdir(join(tmp, "bin"), { recursive: true });
  await writeFile(join(tmp, "bin", "tracemaker"), "");
  await writeFile(join(tmp, "bin", "tracemaker-place"), "");
  const base = join(tmp, "base");
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "b.kicad_pcb"), BOARD);
  const fpCore: Floorplan = { courtyard_clearance_mm: 0.3, groups: [plan.groups[0]!, plan.groups[1]!] };

  test("passes in order, poses copied back, records verified, courtyard gate", async () => {
    const host = fakeHost();
    const r = await floorplanRun(host, { base, out: join(tmp, "run1"), stem: "b", floorplan: fpCore, blocks, fixed: FIXED, seed: 4, legalise: (t) => t });
    expect(r.ok).toBe(true);
    const passes = r.log.filter((x) => "group" in x) as Array<Record<string, unknown>>;
    expect(passes.map((x) => [x["group"], x["parts"], x["placed"], x["ok"]])).toEqual([["core", 2, 2, true], ["core_row", 1, 1, true]]);
    expect(host.calls[0]).toContain("--seed");
    expect(host.calls[0]![host.calls[0]!.indexOf("--courtyard-clearance-mm") + 1]).toBe("0.3");
    expect(host.calls[1]![host.calls[1]!.indexOf("--courtyard-clearance-mm") + 1]).toBe("0.2");
    const p = boardPoses(await readFile(r.board, "utf8"));
    expect(p.get("U1")!.slice(0, 3)).toEqual([22, 12, 90]); // the stand-in places in file order: U1 first
    expect(p.get("R1")!.slice(0, 3)).toEqual([25, 14, 90]);
    expect(p.get("R2")!.slice(0, 3)).toEqual([22, 12, 90]); // its own pass (core_row)
    expect(p.get("J1")!.slice(0, 2)).toEqual([5, 5]);
    expect(r.log.at(-1)).toEqual({ native_courtyard_check: {} });
    expect(JSON.parse(await readFile(join(tmp, "run1", "floorplan-log.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(r.log)));
  });

  test("a part outside the group that moved fails the pass", async () => {
    const r = await floorplanRun(fakeHost({ moveLocked: true }), { base, out: join(tmp, "run2"), stem: "b", floorplan: fpCore, blocks, fixed: FIXED, legalise: (t) => t });
    expect(r.ok).toBe(false);
    expect(r.stop).toMatch(/pass failed verification: core/);
    expect((r.log[0] as { pose_mismatch: string[] }).pose_mismatch).toEqual([]);
  });

  test("native courtyard findings stop the run", async () => {
    const r = await floorplanRun(fakeHost({ courtyard: [{ rule: "courtyards_overlap", items: [{ description: "Footprint U1 x" }, { description: "Footprint R1 y" }] }] }), {
      base, out: join(tmp, "run3"), stem: "b", floorplan: fpCore, blocks, fixed: FIXED, legalise: (t) => t,
    });
    expect(r.stop).toMatch(/native courtyard check failed/);
  });
});

describe("stageFloorplan (board_route floorplan)", () => {
  test("a gated result joins the place pool as seed 1000 + seed, kept, with placement figures", async () => {
    const ws = join(tmp, "ws");
    const reqDir = join(tmp, "req");
    await mkdir(join(ws, "base"), { recursive: true });
    await mkdir(reqDir, { recursive: true });
    await writeFile(join(ws, "base", "b.kicad_pcb"), BOARD);
    const acc = { stack_policy: { ground_net: "GND" }, net_classes: { classes: {} } };
    for (const [f, v] of [["acceptance.json", acc], ["circuit.json", { components: [] }], ["mechanical.json", { anchors: [] }], ["heights.json", { entries: [] }]] as const) await writeFile(join(reqDir, f), JSON.stringify(v));
    await writeFile(join(tmp, "fp.json"), JSON.stringify({ courtyard_clearance_mm: 0.3, groups: [plan.groups[0], plan.groups[1]] }));
    await writeFile(join(tmp, "blocks.json"), JSON.stringify(blocks));
    const st = { ws, spec: { stem: "b", base: join(ws, "base"), requirements: reqDir, fixed: "^J" }, stages: { check: { status: "pass", started: 0 } }, decisions: [], place_pool: [{ seed: 3, gate: true, kept: true }] } as unknown as FlowState;
    const o = await stageFloorplan(fakeHost(), st, { floorplan: join(tmp, "fp.json"), blocks: join(tmp, "blocks.json"), seed: 2 });
    expect(o.ok).toBe(true);
    expect(o.verdict).toMatch(/^PASS floorplan fp-s2/);
    expect(st.place_pool!.map((s) => [s.seed, s.kept])).toEqual([[3, true], [FLOORPLAN_POOL_BASE + 2, true]]);
    expect(st.place_pool![1]!.placed).toBe(join(ws, "floorplan", "fp-s2"));
    expect(o.lines.some((l) => l.startsWith("HPWL"))).toBe(true);
    expect(JSON.parse(await readFile(join(ws, "flow.json"), "utf8")).place_pool).toHaveLength(2);
  });
});

describe("route_region --replace pieces", () => {
  test("region rip cuts every net's copper with a point in the region and prunes what hangs", () => {
    const r = regionRip(BOARD, [[29, 19, 31, 21]]);
    expect(r.removed.segment).toBe(1);
    expect(r.removed.via).toBe(0);
    expect(r.nets).toEqual(["S0"]);
    expect(r.text).not.toContain('(uuid "a")');
    expect(r.text).toContain('(uuid "c")');
  });

  test("replace: action syntax", () => {
    const [st] = stepsFor("replace:display,charger@layout/fp.json#3");
    expect(st!.type).toBe("replace");
    expect(st!.replace).toEqual({ groups: ["display", "charger"], floorplan: "layout/fp.json", seed: 3 });
    expect(st!.planName).toBe("after-cut");
    expect(stepsFor("replace:display")[0]!.replace).toEqual({ groups: ["display"] });
  });
});

describe("block_eval plan", () => {
  test("base plan stages restricted to the block's nets, then the rest in calls of 60", () => {
    const acc = { stack_policy: { no_track_layers: ["In1.Cu"], ground_net: "GND" }, net_classes: { classes: { USB: { pairs: [["DP", "DN"]] } } } };
    const nets = ["DP", "DN", "A", ...Array.from({ length: 61 }, (_, i) => `N${String(i).padStart(2, "0")}`)].sort();
    const p = blockPlan({ session: [{ name: "small", nets: ["A", "Z"], work: 1 }, { name: "pairs", nets: "@pairs", work: 2 }] }, nets, { acceptance: acc } as unknown as Requirements, ["g"], true);
    expect(p.session.map((s) => [s.name, (s.nets as string[]).length])).toEqual([["gnd-drops", 1], ["small", 1], ["pairs", 2], ["rest-0", 60], ["rest-1", 1]]);
    expect(p.session[3]!.hints).toEqual({ layers: { no_tracks: ["In1.Cu"] } });
  });
});

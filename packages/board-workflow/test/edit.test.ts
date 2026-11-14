import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditCandidateBuilder,
  openReviewProject,
  type ReviewEnv,
  childLists,
  drcInputFromRaw,
  listSpanAt,
  onboard,
  parseLossless,
  printLossless,
  removeSpans,
  runAcceptance,
  splice,
  topLevelSpans,
} from "../src/index";
import { EditStop, SheetSet, diffBoards, judge, parsePlan, revertNets, runEdit, type EditRunners } from "../src/edit/index";
import { directLink, segSegDist } from "../src/edit/link";
import { g } from "../src/edit/fmt";
import { planMoves } from "../src/edit/move";
import { legalisePoses, pySum } from "../src/edit/legalise";
import { pruneDangling } from "../src/edit/prune";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

import { BOARD, PRO, SHEET, fpT, seg } from "./edit-fixture";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "edit-"));
  dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), BOARD);
  await writeFile(join(dir, "board.kicad_pro"), PRO);
  await writeFile(join(dir, "board.kicad_sch"), SHEET);
  await onboard(dir, { name: "t" });
  return dir;
}

const clean = { violations: [], unconnected: 0, parity: 0 };
const runners = (over: Partial<EditRunners> = {}): EditRunners => ({ accept: (dir, pcb) => runAcceptance(dir, { pcb, drc: async () => clean }), ...over });

describe("round-trip-safe writing", () => {
  test("a lossless parse prints the input byte for byte, strings with parentheses and escapes included", () => {
    for (const t of [BOARD, SHEET, '(a  "x ) \\" (y"\n\t(b 1\r\n 2)  c )\n\n']) expect(printLossless(parseLossless(t))).toBe(t);
  });
  test("removing a block and putting it back is the identity; no edits change nothing", () => {
    const [c1] = topLevelSpans(SHEET, "symbol");
    const blk = SHEET.slice(c1!.start, c1!.end);
    const removed = removeSpans(SHEET, [c1!]);
    expect(removed).not.toContain('(property "Reference" "C1"');
    expect(splice(SHEET, [])).toBe(SHEET);
    // the block goes back where it was, byte for byte
    const lead = SHEET.slice(0, c1!.start).match(/[ \t]*$/)![0];
    const at = c1!.start - lead.length;
    expect(splice(removed, [{ start: at, end: at, text: lead + blk }])).toBe(SHEET);
  });
  test("top-level spans see only the root's children; child lists and list spans agree", () => {
    expect(topLevelSpans(SHEET, "symbol")).toHaveLength(5); // placed symbols, not the lib_symbols entries
    const lib = SHEET.indexOf("(lib_symbols");
    expect(childLists(SHEET, listSpanAt(SHEET, lib))).toHaveLength(2);
  });
  const cm5 = "/home/shane/pcb-cmp/cm5_minima/proj2";
  test.skipIf(!existsSync(cm5))("every cm5_minima sheet and the board round-trip byte-stable", async () => {
    const files = readdirSync(cm5).filter((n) => /\.kicad_(sch|pcb)$/.test(n));
    expect(files.length).toBeGreaterThan(8);
    for (const n of files) {
      const t = await readFile(join(cm5, n), "utf8");
      expect(printLossless(parseLossless(t)) === t).toBe(true);
      const spans = topLevelSpans(t, "symbol").concat(topLevelSpans(t, "footprint"));
      expect(splice(t, spans.map((s) => ({ ...s, text: t.slice(s.start, s.end) })))).toBe(t);
    }
  });
});

describe("number formatting follows Python", () => {
  test("%g", () => {
    expect([g(0), g(180), g(92.5912), g(0.5), g(123.4567), g(1e-5), g(1234567), g(-3.25), g(100000), g(0.0001)]).toEqual(["0", "180", "92.5912", "0.5", "123.457", "1e-05", "1.23457e+06", "-3.25", "100000", "0.0001"]);
  });
});

describe("plan", () => {
  test("validates what the agent writes", () => {
    expect(() => parsePlan({})).toThrow(/id/);
    expect(() => parsePlan({ id: "x", move: [{ ref: "R1" }] })).toThrow(/to/);
    expect(() => parsePlan({ id: "x", net: [{ pin: "R1", to: "A" }] })).toThrow(/pin/);
    expect(parsePlan({ id: "ok", remove: ["C3"] }).remove).toEqual(["C3"]);
  });
});

describe("impact", () => {
  test("removing a decoupling cap: what it touches, and a PASS", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, plan: { id: "rm", remove: ["C3"] }, mode: "impact", runners: runners() });
    expect(r.verdict).toBe("PASS impact");
    expect(r.impact.nets["VIN"]).toMatchObject({ pads_before: 5, pads_after: 4, status: "reduced" });
    expect(r.impact.schematic).toEqual(["board.kicad_sch: C3"]);
    expect(r.impactLines.some((l) => l.startsWith("part  C3 '100n' side F anchor False fixed False pads 2"))).toBe(true);
  });
  test("a pin left alone is a STOP until the plan accepts it; an unknown part fails", async () => {
    const dir = await project();
    const stopR = await runEdit({ projectDir: dir, plan: { id: "rm", remove: ["R2"] }, mode: "impact", runners: runners() });
    expect(stopR.stop).toBe(true);
    expect(stopR.verdict).toMatch(/^STOP review: unconnected pins not accepted/);
    const ok = await runEdit({ projectDir: dir, plan: { id: "rm", remove: ["R2"], accept_unconnected: ["R1.2"] }, mode: "impact", runners: runners() });
    expect(ok.verdict).toBe("PASS impact");
    const bad = await runEdit({ projectDir: dir, plan: { id: "rm", remove: ["ZZ9"] }, mode: "impact", runners: runners() });
    expect(bad.verdict).toBe("FAIL refs not on board: ZZ9");
  });
  test("a fixed part in the way of a move is a STOP naming it", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, plan: { id: "mv", move: [{ ref: "R1", to: [5.5, 5, 0] }], displace: { radius: 3 } }, mode: "impact", runners: runners() });
    expect(r.stop).toBe(true);
    expect(r.verdict).toMatch(/^STOP fixed parts in the way of the new pose\(s\): J1/);
  });
});

describe("apply, proof and the candidate", () => {
  test("remove: board and schematic change together, the requirements follow, origin.json is written for adopt", async () => {
    const dir = await project();
    const before = await readFile(join(dir, "board.kicad_sch"), "utf8");
    const r = await runEdit({ projectDir: dir, plan: { id: "rm", remove: ["C3"] }, mode: "full", runners: runners() });
    expect(r.stage).toBe("proof");
    expect(r.proof).toBeDefined();
    expect(r.candidate).toBeDefined();
    const cand = r.candidate!;
    const board = await readFile(cand.pcb, "utf8");
    expect(board).not.toContain('(property "Reference" "C3"');
    expect(r.applied?.symbols).toBe(1);
    expect(r.applied?.schematic_orphans_removed?.["board.kicad_sch"]).toEqual({ wire: 0, label: 2, no_connect: 0 });
    const sheet = await readFile(join(cand.dir, "board.kicad_sch"), "utf8");
    expect(sheet).not.toContain('"C3"');
    expect(sheet).toContain('"C2"');
    // the project itself is untouched until adopt
    expect(await readFile(join(dir, "board.kicad_sch"), "utf8")).toBe(before);
    const circuit = JSON.parse(await readFile(join(cand.dir, ".fabdesk/board/requirements/circuit.json"), "utf8"));
    expect(circuit.components.map((c: { reference: string }) => c.reference)).not.toContain("C3");
    const origin = JSON.parse(await readFile(cand.origin, "utf8"));
    expect(origin.project).toBe(dir);
    expect(Object.keys(origin.files)).toEqual(["board.kicad_sch"]);
    expect(r.diff?.removed).toEqual(["C3"]);
    expect(r.churn).toMatchObject({ collateral_nets: 0, unplanned_moved: [] });
    // A4 (circuit) judged on the candidate's own, edited requirements
    expect(r.proof?.after["A4_circuit"]).toBe(true);
  });

  test("a move cuts the fan-out, keeps everything else, and reports the nets to route again", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, mode: "apply", runners: runners() });
    expect(r.stage).toBe("apply");
    expect(r.applied?.moves?.moved[0]).toMatchObject({ ref: "C3", to: [50, 30, 90] });
    expect(r.applied?.moves?.cut_nets).toEqual(["GND", "VIN"]);
    expect(r.repair).toMatchObject({ available: false, routeAgain: ["GND", "VIN"] });
    expect(r.diff?.moved).toEqual(["C3"]);
    expect(r.churn?.unplanned_moved).toEqual([]);
    const text = await readFile(r.candidate!.pcb, "utf8");
    expect(text).toContain("(translate 50.0000 30.0000)");
    expect(text).toContain("(rotate 90)");
  });

  // a repair that also changes a net the plan never touched (SIG2): the churn guard puts SIG2's copper back
  const strayRepair = (): NonNullable<EditRunners["repair"]> => async ({ pcb }) => {
    const t = await readFile(pcb, "utf8");
    const end = t.trimEnd().lastIndexOf(")");
    await writeFile(pcb, `${t.slice(0, end)}  ${seg(20.5, 10, 25, 10, "SIG2")}\n)\n`);
    return { note: "stray" };
  };
  test("churn guard: a collateral net gets its source copper back when the board scores no worse", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, mode: "full", runners: runners({ repair: strayRepair() }) });
    expect(r.guard).toEqual({ nets: ["SIG2"], kept: true });
    expect(r.churn?.collateral_nets).toBe(0);
    expect(await readFile(r.candidate!.pcb, "utf8")).not.toContain("(end 25 10)");
    const index = JSON.parse(await readFile(join(r.candidate!.dir, ".fabdesk/board/accept/index.json"), "utf8")) as Array<{ file: string; sha256: string }>;
    expect(await readFile(join(r.candidate!.dir, index.at(-1)!.file), "utf8")).toContain('"summary"'); // the guard's record moved in
    expect(existsSync(join(dir, ".fabdesk/board/edits", `.${r.candidate!.dir.split("/").pop()}.guard`))).toBe(false);
  });
  test("churn guard: the candidate is kept as repaired when putting the copper back scores worse", async () => {
    const dir = await project();
    const err = { violations: [{ rule: "clearance", severity: "error", description: "x" }], unconnected: 0, parity: 0 };
    const accept: EditRunners["accept"] = (d, pcb) => runAcceptance(d, { pcb, drc: async () => (d.endsWith(".guard") ? err : clean) });
    const r = await runEdit({ projectDir: dir, plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, mode: "full", runners: runners({ accept, repair: strayRepair() }) });
    expect(r.guard).toMatchObject({ nets: ["SIG2"], kept: false, why: "worse on A2 0->1" });
    expect(r.churn?.collateral_nets).toBe(1);
    expect(await readFile(r.candidate!.pcb, "utf8")).toContain("(end 25 10)");
  });

  test("add copies a template symbol with one label per pin; net moves a pin and its label; swap changes value and field", async () => {
    const dir = await project();
    const r = await runEdit({
      projectDir: dir,
      plan: {
        id: "mix",
        add: [{ ref: "C9", like: "C1", pins: { "1": "VIN", "2": "GND" }, near: "U1", height_mm: 1 }],
        net: [{ pin: "R1.2", to: "SIG3" }],
        swap: [{ ref: "R2", value: "2k2", fields: { MPN: "X-1" } }],
        accept_unconnected: ["R2.1"],
        displace: { radius: 6 },
      },
      mode: "apply",
      runners: runners(),
    });
    expect(r.verdict).toBe("PASS apply");
    const sheet = await readFile(join(r.candidate!.dir, "board.kicad_sch"), "utf8");
    expect(sheet).toContain('(property "Reference" "C9"');
    expect(sheet.match(/\(global_label "VIN"/g)).toHaveLength(4); // C1, C2, C3 and the new C9
    expect(sheet).toContain('(global_label "SIG3"'); // R1 pin 2 was relabelled
    expect(sheet).not.toMatch(/R1[\s\S]*\(global_label "SIG2"[^]*\(symbol \(lib_id "Device:R"\) \(at 130/); // only R2's label is left on SIG2
    expect(sheet).toContain('(property "MPN" "X-1"');
    expect(sheet).toContain('(property "Value" "2k2"');
    const board = await readFile(r.candidate!.pcb, "utf8");
    expect(board).toContain('(property "Reference" "C9"');
    expect(r.applied?.net_changes[0]).toMatchObject({ pin: "R1.2", from: "SIG2", to: "SIG3", label_was: "SIG2" });
    expect(r.applied?.adds[0]?.near).toBe("U1");
    const circuit = JSON.parse(await readFile(join(r.candidate!.dir, ".fabdesk/board/requirements/circuit.json"), "utf8"));
    expect(circuit.components.find((c: { reference: string }) => c.reference === "C9")).toMatchObject({ pins: { "1": "VIN", "2": "GND" } });
    expect(circuit.components.find((c: { reference: string }) => c.reference === "R2").value).toBe("2k2");
    const heights = JSON.parse(await readFile(join(r.candidate!.dir, ".fabdesk/board/requirements/heights.json"), "utf8"));
    expect(heights.entries.find((e: { ref: string }) => e.ref === "C9")).toMatchObject({ height_above_surface_mm: 1, side: "F" });
  });

  test("mode proof judges an existing candidate; the repair hook runs before it when the edit opened connections", async () => {
    const dir = await project();
    const calls: string[][] = [];
    const rn = runners({ repair: async (i) => (calls.push(i.routeAgain), { note: "routed" }) });
    const first = await runEdit({ projectDir: dir, plan: { id: "mv2", move: [{ ref: "C3", to: [50, 30, 0] }], displace: { radius: 3 } }, mode: "apply", runners: rn });
    const proof = await runEdit({ projectDir: dir, plan: { id: "mv2", move: [{ ref: "C3", to: [50, 30, 0] }], displace: { radius: 3 } }, mode: "proof", candidate: first.candidate!.dir, runners: rn });
    expect(calls).toEqual([["GND", "VIN"]]);
    expect(proof.repair).toMatchObject({ available: true, note: "routed" });
    expect(proof.proof?.comparison?.label).toBe("baseline");
  });
});

describe("DRC exclusions follow an edit", () => {
  const UC = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // C1 and C3 overlap on purpose (an owner's exclusion at (41, 10)); the plan swaps C1 and C2 (same footprint id)
  const KEY = (a: string, b: string) => `courtyards_overlap|41000000|10000000|${a}|${b}`;
  async function swapProject(): Promise<string> {
    const dir = await project();
    const board = (await readFile(join(dir, "board.kicad_pcb"), "utf8")).replace('(uuid "fp-C1")', `(uuid "${UC(1)}")`).replace('(uuid "fp-C2")', `(uuid "${UC(2)}")`).replace('(uuid "fp-C3")', `(uuid "${UC(3)}")`);
    await writeFile(join(dir, "board.kicad_pcb"), board);
    const pro = JSON.parse(await readFile(join(dir, "board.kicad_pro"), "utf8"));
    pro.board.design_settings.drc_exclusions = [[KEY(UC(1), UC(3)), "Intentional Overlap"]];
    await writeFile(join(dir, "board.kicad_pro"), JSON.stringify(pro, null, 2));
    return dir;
  }
  /** A KiCad stand-in: whatever sits at (40, 10) overlaps C3; the marker is excluded when the project holds its exact key (`matches` decides). */
  const fakeDrc = (matches: (key: string, at: string) => boolean): EditRunners["accept"] => (d, pcb) =>
    runAcceptance(d, {
      pcb,
      drc: async ({ board, outFile }) => {
        const text = await readFile(board, "utf8");
        const at = /\(uuid "([^"]+)"\)\s*\(transform\s*\(translate 40(?:\.0+)? 10(?:\.0+)?\)/.exec(text)?.[1] ?? "none";
        const keys = (JSON.parse(await readFile(board.replace(/\.kicad_pcb$/, ".kicad_pro"), "utf8")).board?.design_settings?.drc_exclusions ?? []).map((e: string[]) => e[0]);
        const v = { type: "courtyards_overlap", severity: "error", description: "Courtyards overlap", items: [{ uuid: at, description: "Footprint" }, { uuid: UC(3), description: "Footprint C3" }] };
        const raw = { violations: keys.some((k: string) => k === KEY(at, UC(3)) && matches(k, at)) ? [] : [v] };
        await writeFile(outFile, JSON.stringify(raw));
        return { ...drcInputFromRaw(raw), unconnected: 0 };
      },
    });
  const plan = { id: "swap-c", move: [{ ref: "C1", to: [40, 14, 0] }, { ref: "C2", to: [40, 10, 0] }] };

  test("a swap carries the owner's exclusion to the part now in its place; the proof does not regress and adopt is told", async () => {
    const dir = await swapProject();
    const r = await runEdit({ projectDir: dir, plan, mode: "full", runners: runners({ accept: fakeDrc(() => true) }) });
    expect(r.exclusions?.carried.map((c) => c.line)).toEqual(["courtyards_overlap C1 + C3 at (41, 10) -> C2 + C3 at (41, 10) (C2 took C1's place)"]);
    expect(r.proof?.figures.drc).toEqual({});
    expect(r.verdict).toStartWith("PASS");
    const pro = JSON.parse(await readFile(join(r.candidate!.dir, "board.kicad_pro"), "utf8"));
    expect(pro.board.design_settings.drc_exclusions).toEqual([[KEY(UC(2), UC(3)), "Intentional Overlap [carried by edit swap-c]"]]);
    // the project's own file is untouched; origin.json records its exclusions so adopt can tell if they moved on
    expect(JSON.parse(await readFile(join(dir, "board.kicad_pro"), "utf8")).board.design_settings.drc_exclusions).toEqual([[KEY(UC(1), UC(3)), "Intentional Overlap"]]);
    expect(JSON.parse(await readFile(r.candidate!.origin, "utf8")).exclusions).toMatchObject({ file: "board.kicad_pro" });
    expect(JSON.parse(await readFile(join(r.candidate!.dir, "drc-exclusions.json"), "utf8")).carried).toHaveLength(1);
  });

  test("a re-keyed exclusion KiCad does not match is put back, said so, and the violation counts", async () => {
    const dir = await swapProject();
    const r = await runEdit({ projectDir: dir, plan, mode: "full", runners: runners({ accept: fakeDrc((_k, at) => at !== UC(2)) }) });
    expect(r.exclusions?.carried).toEqual([]);
    expect(r.exclusions?.notes[0]).toContain("KiCad did not match the re-keyed exclusion");
    expect(r.verdict).toBe("FAIL A2_drc"); // strict: the source passed every check
    const pro = JSON.parse(await readFile(join(r.candidate!.dir, "board.kicad_pro"), "utf8"));
    expect(pro.board.design_settings.drc_exclusions).toEqual([[KEY(UC(1), UC(3)), "Intentional Overlap"]]);
  });
});

describe("judging", () => {
  const res = (over: Record<string, unknown> = {}) => ({
    A1_connectivity: { pass: true, unconnected: 0 },
    A2_drc: { pass: true, errors: {} },
    A3_parity: { pass: true, items: 0 },
    A4_circuit: { pass: true }, A5_anchors: { pass: true }, A6_stack: { pass: true }, A7_widths: { pass: true, nets_failing: 0 }, A8_pairs: { pass: true, nets_failing: 0 }, A9_heights: { pass: true },
    ...over,
  });
  const sum = (r: ReturnType<typeof res>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (v as { pass: boolean }).pass])) as never;
  const J = (r: ReturnType<typeof res>) => ({ summary: sum(r), results: r as never });
  test("strict when the source passed", () => {
    expect(judge(J(res()), J(res())).verdict).toBe("PASS all A1-A9 with parity");
    const j = judge(J(res()), J(res({ A1_connectivity: { pass: false, unconnected: 3 } })));
    expect(j).toMatchObject({ mode: "strict", verdict: "FAIL A1_connectivity", pass: false });
    expect(j.figures.open).toBe(3);
  });
  test("no new failure when the source already failed", () => {
    const b = res({ A2_drc: { pass: false, errors: { courtyards_overlap: 3 } }, A8_pairs: { pass: false, nets_failing: 2 } });
    expect(judge(J(b), J(b)).verdict).toBe("PASS (no regression)");
    expect(judge(J(b), J(res({ ...b, A2_drc: { pass: false, errors: { courtyards_overlap: 4 } } }))).verdict).toBe("FAIL regress ['A2 errors 3->4']");
    expect(judge(J(b), J(res({ ...b, A8_pairs: { pass: false, nets_failing: 3 } }))).verdict).toBe("FAIL regress ['A8 2->3']");
    expect(judge(J(b), J(res({ ...b, A6_stack: { pass: false } }))).verdict).toBe("FAIL regress ['A6_stack']");
  });
  test("a source that already had opens (placed, unrouted): A1 judged by count, not required to pass", () => {
    const b = res({ A1_connectivity: { pass: false, unconnected: 208 }, A2_drc: { pass: false, errors: { courtyards_overlap: 7 } } });
    expect(judge(J(b), J(b)).verdict).toBe("PASS (no regression)");
    expect(judge(J(b), J(res({ ...b, A1_connectivity: { pass: false, unconnected: 209 } }))).verdict).toBe("FAIL regress ['A1 opens 208->209']");
    // a connected source must stay connected (unchanged)
    const c = res({ A2_drc: { pass: false, errors: { courtyards_overlap: 3 } } });
    expect(judge(J(c), J(res({ ...c, A1_connectivity: { pass: false, unconnected: 1 } }))).verdict).toBe("FAIL regress ['A1_connectivity']");
  });
});

describe("collateral, drc input and the helpers", () => {
  test("a diff names removed, moved and changed copper; revertNets puts a net's copper back", () => {
    const moved = BOARD.replace("(translate 40 10)", "(translate 41 10)");
    const d = diffBoards(BOARD, moved);
    expect(d.moved).toEqual(["C1"]);
    const cut = BOARD.replace(seg(20.5, 10, 19.5, 14, "SIG2"), "");
    expect(diffBoards(BOARD, cut).copper_changed_nets).toEqual({ SIG2: [4.12, 0] });
    const back = revertNets(BOARD, cut, ["SIG2"]);
    expect(diffBoards(BOARD, back).copper_changed_nets).toEqual({});
  });
  test("dangling copper is pruned, a connected stub is kept", () => {
    expect(pruneDangling(BOARD, new Set(["SIG2"])).pruned).toBe(0); // pad to pad
    const stub = BOARD.replace(seg(20.5, 10, 19.5, 14, "SIG2"), seg(20.5, 10, 20.5, 12, "SIG2")); // starts on R1 pad 2, ends in the air
    expect(pruneDangling(stub, new Set(["SIG2"])).pruned).toBe(1);
    expect(pruneDangling(stub, new Set(["VIN"])).pruned).toBe(0); // only the named nets are pruned
  });
  test("owner-excluded DRC violations are not findings", () => {
    const d = drcInputFromRaw({
      violations: [{ type: "courtyards_overlap", severity: "error", description: "x" }, { type: "courtyards_overlap", severity: "error", description: "y", excluded: true }],
      unconnected_items: [{ excluded: true }],
      schematic_parity: [{ type: "p" }],
    });
    expect(d).toMatchObject({ unconnected: 0, parity: 1 });
    expect(d.violations).toHaveLength(1);
  });
  test("parsePlan: carry_auto true means this part; a wrong type is refused by name, not a crash", () => {
    expect(parsePlan({ id: "m", move: [{ ref: "R1", to: [20, 30, 0], carry_auto: true }] }).move![0]!.carry_auto).toEqual(["R1"]);
    expect(parsePlan({ id: "m", move: [{ ref: "R1", to: [20, 30, 0], carry_auto: false }] }).move![0]!.carry_auto).toBeUndefined();
    expect(() => parsePlan({ id: "m", move: [{ ref: "R1", to: [20, 30, 0], carry_auto: "R2" }] })).toThrow(/carry_auto" is a list/);
    expect(() => parsePlan({ id: "m", move: [{ ref: "R1", to: [20, 30, 0], carry: true }] })).toThrow(/carry" is a list/);
    const auto = planMoves(BOARD, (r) => r === "J1", parsePlan({ id: "m", move: [{ ref: "R1", to: [20, 30, 0], carry_auto: true }] }).move!, { radius: 4 }, []);
    expect(auto.led.carry_auto).toEqual({ R1: ["R2"] });
  });
  test("planMoves: a swap of two parts' poses is two moves and re-seats nothing", () => {
    const { led } = planMoves(BOARD, (r) => r === "J1", [{ ref: "C1", to: [40, 14, 0] }, { ref: "C2", to: [40, 10, 0] }], undefined, []);
    expect(led.moved.map((m) => m.ref)).toEqual(["C1", "C2"]);
    expect(led.displaced).toEqual([]);
    expect(led.inherited_overlaps).toBeUndefined();
  });
  test("planMoves near: the tool picks the pose next to the target; make_room displaces what is there; carry_auto takes net-local satellites", () => {
    const near = planMoves(BOARD, (r) => r === "J1", [{ ref: "C3", near: "U1", radius: 6 }], { radius: 6 }, []);
    expect(near.led.near).toHaveLength(1);
    expect(near.led.near[0]).toMatchObject({ ref: "C3" });
    const [x, y] = near.led.near[0]!.to;
    expect(Math.hypot(x - 30, y - 20)).toBeLessThan(6);
    // a part that sits where the block wants to go is displaced when the block says make_room
    const room = planMoves(BOARD, (r) => r === "J1", [{ ref: "C3", near: [40, 14], radius: 2, make_room: true }], { radius: 6 }, []);
    expect(room.led.displaced.map((d) => d.ref)).toEqual(["C2"]);
    // R1 and R2 share SIG2 (and nothing else but GND): R2 is a satellite of R1
    const auto = planMoves(BOARD, (r) => r === "J1", [{ ref: "R1", to: [20, 30, 0], carry_auto: ["R1"] }], { radius: 4 }, []);
    expect(auto.led.carry_auto).toEqual({ R1: ["R2"] });
    expect(auto.led.carried.map((c) => c.ref)).toEqual(["R2"]);
  });
  test("near on copper: impact names the nearest pose that cuts no other net; clear: true takes it, or stops saying why", () => {
    let band = "";
    for (let y = 13; y <= 27; y += 0.5) band += seg(21, y, 38, y, "OTHER");
    const b2 = BOARD.replace(/\n\)$/, `${band}\n)`);
    const r = planMoves(b2, (r_) => r_ === "J1", [{ ref: "C3", near: "U1", radius: 6 }], { radius: 6 }, []);
    expect(r.led.landing_removed_nets).toEqual(["OTHER"]); // the toolkit's order: a pose on copper when nothing near is clear
    const nc = r.led.near_clear![0]!;
    expect(nc).toMatchObject({ ref: "C3", chosen_cuts: 4, target: [30, 20] });
    expect(nc.clear_mm!).toBeGreaterThan(6);
    const c = planMoves(b2, (r_) => r_ === "J1", [{ ref: "C3", near: "U1", radius: Math.ceil(nc.clear_mm!), clear: true }], { radius: 6 }, []);
    expect(c.led.near[0]!.to).toEqual(nc.clear!);
    expect(c.led.landing_removed_nets).toEqual([]);
    expect(c.led.near_clear).toBeUndefined();
    expect(() => planMoves(b2, (r_) => r_ === "J1", [{ ref: "C3", near: "U1", radius: 6, clear: true }], { radius: 6 }, [])).toThrow(/clear of other nets' copper \(clear: true\)/);
  });
  test("legalise (tp_legalise): test points go to the nearest free spot to their net's other pads, many in one plan, rotation kept", () => {
    const tps = fpT("TP1", 55, 35, [["1", "SIG2", 0, 0]], { box: [-0.5, -0.5, 0.5, 0.5], value: "TP" }) + fpT("TP2", 5, 35, [["1", "SIG", 0, 0]], { box: [-0.5, -0.5, 0.5, 0.5], value: "TP", rot: 90 });
    const board = BOARD.replace(/\n\)$/, `${tps}\n)`);
    const plan = parsePlan({ id: "tp", legalise: ["TP1", "TP2"] });
    expect(plan.move?.map((m) => [m.ref, m.legalise])).toEqual([["TP1", { clearance: 0.15, edge: 0.5, radius: 40 }], ["TP2", { clearance: 0.15, edge: 0.5, radius: 40 }]]);
    // SIG2's other pads: R1.2 (20.5, 10) and R2.1 (19.5, 14): centroid (20, 12) is free (0.15 mm from R1 and R2 courtyards);
    // SIG: R1.1 (19.5, 10) and U1.2 (31, 20): centroid (25.25, 15). Both poses as the toolkit's tp_legalise.py on this board.
    expect([...legalisePoses(board, ["TP1", "TP2"])]).toEqual([["TP1", [20, 12, 0]], ["TP2", [25.25, 15, 90]]]);
    // the edit applies them as plain moves; R1/R2 at 0.15-0.2 mm are not "in the way" (the legalise clearance is the gap)
    const { led, text } = planMoves(board, (r) => r === "J1", plan.move!, plan.displace, []);
    expect(led.moved.map((m) => [m.ref, m.to])).toEqual([["TP1", [20, 12, 0]], ["TP2", [25.25, 15, 90]]]);
    expect(led.displaced).toEqual([]);
    expect(text).toContain("(translate 20.0000 12.0000)");
    // each placed part is an obstacle for the next: TP3 on SIG2 too (the centroids of TP1 and TP3 nearly coincide) lands
    // clear of where TP1 was just placed (1 mm boxes, 0.15 mm apart at least)
    const tp3 = fpT("TP3", 54, 35, [["1", "SIG2", 0, 0]], { box: [-0.5, -0.5, 0.5, 0.5], value: "TP" });
    const three = legalisePoses(BOARD.replace(/\n\)$/, `${tps}${tp3}\n)`), ["TP1", "TP3"]);
    const [a, b] = [three.get("TP1")!, three.get("TP3")!];
    expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeGreaterThanOrEqual(1.15 - 1e-9);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(3);
    // a move near a net still works for any part; a ref the plan already moves keeps its own move
    expect(() => planMoves(board, () => false, [{ ref: "R1", near: "net" }], undefined, [])).toThrow(/R1 has pads on 2 nets/);
    expect(parsePlan({ id: "tp", move: [{ ref: "TP1", to: [1, 2, 0] }], legalise: { refs: ["TP1", "TP2"], clearance: 0.3 } }).move?.map((m) => [m.ref, m.legalise?.clearance])).toEqual([["TP1", undefined], ["TP2", 0.3]]);
    expect(() => parsePlan({ id: "tp", legalise: [] })).toThrow(/plan.legalise/);
  });

  test("the legalise centroid sums as Python's sum() (jetson TP45's net: a plain sum rounds the tie the other way)", () => {
    const xs = [151.82500000000002, 215.64499999999998, 227.2, 226];
    expect(xs.reduce((t, x) => t + x, 0) / 4).toBe(205.16750000000002);
    expect(pySum(xs) / 4).toBe(205.1675); // python3 -c "print(sum([151.82500000000002, 215.64499999999998, 227.2, 226.0]) / 4)"
    expect(pySum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(pySum([])).toBe(0);
  });

  // the toolkit's tp_legalise.py --refs TP101,...,TP106 on cm5_minima (2026-11-13): every pose equal
  const cm5Board = join(homedir(), "pcb-cmp/cm5_minima/proj2/board.kicad_pcb");
  test.skipIf(!existsSync(cm5Board))("legalise on cm5_minima: the six test points land where tp_legalise.py puts them", async () => {
    const poses = legalisePoses(await readFile(cm5Board, "utf8"), ["TP101", "TP102", "TP103", "TP104", "TP105", "TP106"]);
    expect(Object.fromEntries(poses)).toEqual({
      TP101: [108.257, 60.371, 0],
      TP102: [106.901, 62.537, 0],
      TP103: [98.429, 64.835, 0],
      TP104: [105.126, 55.754, 0],
      TP105: [107.361, 55.605, 0],
      TP106: [105.085, 53.599, 0],
    });
  });
  test("a fit/do-not-fit swap sets the footprint attribute and the symbol flags together", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, plan: { id: "dnp", swap: [{ ref: "C3", dnp: true }] }, mode: "apply", runners: runners() });
    expect(await readFile(r.candidate!.pcb, "utf8")).toContain("(attr exclude_from_bom dnp)");
    const sheet = await readFile(join(r.candidate!.dir, "board.kicad_sch"), "utf8");
    expect(sheet).toMatch(/\(symbol \(lib_id "Device:C"\) \(at 90 50 0\) \(unit 1\) \(exclude_from_sim no\) \(in_bom no\) \(on_board yes\) \(dnp yes\)/);
  });
  test("sheet sets only write what changed", async () => {
    const dir = await project();
    const s = new SheetSet(dir);
    expect(s.flush()).toEqual([]);
    expect(s.symbol("C2")).not.toBeNull();
    expect(s.symbol("C99")).toBeNull();
    expect(() => {
      throw new EditStop("x");
    }).toThrow("x");
  });
});

describe("review -> edit bridge (EditCandidateBuilder)", () => {
  const plan = { id: "fix-DECAP", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } } as never;
  const finding = { id: "L3:DECAP:U1:-", severity: "must-fix" } as never;
  const fakeReview = (findings: Array<{ id: string; severity: string }>, checks: Array<{ name: string; status: string }> = []) =>
    (async () => ({ review: { findings, checks }, evaluation: {}, dir: "/nowhere" })) as never;
  const build = async (findings: Array<{ id: string; severity: string }>, over: Partial<EditRunners> = {}, checks: Array<{ name: string; status: string }> = []) => {
    const dir = await project();
    const b = createEditCandidateBuilder({ project: await openReviewProject(dir), runners: runners(over), reviewEnv: {} as ReviewEnv, reviewCandidate: fakeReview(findings, checks) });
    return { dir, res: await b.build(plan, finding) };
  };
  test("READY: proof passes, the finding is gone, nothing new, no collateral", async () => {
    const { res } = await build([]);
    expect(res.ready).toBe(true);
    expect(res.dir).toContain("/.fabdesk/board/edits/fix-DECAP-");
    expect(res.notes.join(" ")).toContain("finding L3:DECAP:U1:- gone");
    expect(JSON.parse(await readFile(join(res.dir!, "review-bridge.json"), "utf8")).ready).toBe(true);
  });
  test("not ready when the finding is still there, or a new must-fix appears", async () => {
    expect((await build([{ id: "L3:DECAP:U1:-", severity: "must-fix" }])).res.notes.join(" ")).toContain("still present");
    const added = await build([{ id: "L3:OTHER:R9:-", severity: "question" }]);
    expect(added.res.ready).toBe(false);
    expect(added.res.notes.join(" ")).toContain("new findings: L3:OTHER:R9:-");
    // notes are not findings that block
    expect((await build([{ id: "L3:NOTE:R9:-", severity: "note" }])).res.ready).toBe(true);
  });
  test("not ready when the candidate's review had check errors (a finding whose check errored is not gone)", async () => {
    const { res } = await build([], {}, [{ name: "decoupling", status: "error" }]);
    expect(res.ready).toBe(false);
    expect(res.notes.join(" ")).toContain("check errors (decoupling)");
  });
  test("not ready when the proof fails (opens left by the edit)", async () => {
    const { res } = await build([], { accept: (dir, pcb) => runAcceptance(dir, { pcb, drc: async () => ({ violations: [], unconnected: 2, parity: 0 }) }) });
    expect(res.ready).toBe(false);
    expect(res.notes.join(" ")).toContain("proof does not pass");
  });
  test("an unsolvable stop is reported, not built", async () => {
    const dir = await project();
    const b = createEditCandidateBuilder({ project: await openReviewProject(dir), runners: runners(), reviewEnv: {} as ReviewEnv, reviewCandidate: fakeReview([]) });
    const res = await b.build({ id: "bad", remove: ["R2"] } as never, finding);
    expect(res.ready).toBe(false);
    expect(res.notes.join(" ")).toContain("STOP");
  });
});

describe("an added part placed next to a pad gets a direct track to it", () => {
  test("add near U1.1 (VIN): a clear straight or one-bend VIN track from the new part's VIN pad to U1.1", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, mode: "apply", plan: { id: "dec", add: [{ ref: "C9", like: "C1", pins: { "1": "VIN", "2": "GND" }, near: "U1.1", height_mm: 1 }], displace: { radius: 6 } }, runners: runners() });
    expect(r.verdict).toBe("PASS apply");
    const link = (r.applied as { adds: Array<{ link?: Record<string, unknown> }> }).adds[0]!.link!;
    expect(link).toMatchObject({ from: "C9.1", to: "U1.1", layer: "F.Cu" });
    expect(link["skipped"]).toBeUndefined();
    const text = await readFile(r.candidate!.pcb, "utf8");
    const pts = link["points"] as Array<[number, number]>;
    expect(text).toContain(`(start ${pts[0]![0].toFixed(4)} ${pts[0]![1].toFixed(4)})`);
    expect(r.repair?.routeAgain).toEqual(["GND", "VIN"]); // an add's nets go to the repair
  });
  test("the candidate's origin.json names the requirements the add changed (circuit.json), with the project's hash, so adopt carries them", async () => {
    const dir = await project();
    const r = await runEdit({ projectDir: dir, mode: "apply", plan: { id: "dec", add: [{ ref: "C9", like: "C1", pins: { "1": "VIN", "2": "GND" }, near: "U1.1", height_mm: 1 }], displace: { radius: 6 } }, runners: runners() });
    const cand = join(r.candidate!.pcb, "..");
    const origin = JSON.parse(await readFile(join(cand, "origin.json"), "utf8")) as { extra?: Record<string, string | null> };
    const rel = ".fabdesk/board/requirements/circuit.json";
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(origin.extra?.[rel]).toBe(sha(await readFile(join(dir, rel))));
    expect(await readFile(join(cand, rel), "utf8")).toContain('"C9"');
  });
  test("link: false leaves it to the pours / last mile; a pad of no shared net is reported, not linked", async () => {
    const dir = await project();
    const off = await runEdit({ projectDir: dir, mode: "apply", plan: { id: "dec", add: [{ ref: "C9", like: "C1", pins: { "1": "VIN", "2": "GND" }, near: "U1.1", link: false, height_mm: 1 }], displace: { radius: 6 } }, runners: runners() });
    expect((off.applied as { adds: Array<{ link?: unknown }> }).adds[0]!.link).toBeUndefined();
    const t = directLink(BOARD, "C1", "U1.2", 0.2); // C1 has no SIG pad
    expect(t.log).toEqual({ from: "C1.?", to: "U1.2", skipped: "C1 has no pad on SIG" });
    expect(t.text).toBe(BOARD);
  });
  test("segment distance: crossing 0, parallel the gap", () => {
    expect(segSegDist([0, 0], [2, 0], [1, -1], [1, 1])).toBe(0);
    expect(segSegDist([0, 0], [2, 0], [0, 1], [2, 1])).toBe(1);
  });
});


describe("editbench run (bench.ts edit-run)", () => {
  test("verdict strings as the toolkit writes them", async () => {
    const { editBenchVerdict } = await import("../src/bench/editrun");
    const all = { A1_connectivity: true, A2_drc: true, A3_parity: true, A7_widths: true, A8_pairs: true };
    expect(editBenchVerdict(all, 0, { summary: all }, false)).toBe("PASS all A1-A9 with parity");
    expect(editBenchVerdict({ ...all, A2_drc: false, A7_widths: false }, 0, { summary: all }, false)).toBe("FAIL A2_drc,A7_widths");
    const before = { summary: { ...all, A8_pairs: false }, results: { A8_pairs: { nets_failing: 2 } } };
    expect(editBenchVerdict({ ...all, A8_pairs: false }, 2, before, true)).toBe("PASS (no regression)");
    expect(editBenchVerdict({ ...all, A8_pairs: false, A7_widths: false }, 4, before, true)).toBe("FAIL regress ['A7_widths', 'A8 2->4']");
  });
  test("one plan through the edit stage on a copy of its project: the toolkit's result.json, read by edit-table", async () => {
    const { bench } = await import("../src/index");
    const dir = await project();
    const out = await mkdtemp(join(tmpdir(), "erun-"));
    dirs.push(out);
    const planPath = join(out, "move.json");
    await writeFile(planPath, JSON.stringify({ id: "bench-t-move", project: dir, move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }));
    const res = await bench.runEditBench({
      planPath,
      out: join(out, "run"),
      toolVersion: "abc",
      accept: (d, pcb) => runAcceptance(d, { pcb, drc: async () => clean }),
      repair: async () => ({ note: "fake", start: { line: "ws: open 1  drc 0  a7 0  a8 0  pairs-todo 0", wall_s: 0.5 }, steps: [{ try: ["finish"], accepted: "c1", open: 0, wall_s: 1.25, out: ["now   step 1: open 0"] }] }),
      now: () => new Date(2026, 10, 13, 9, 5, 7),
    });
    expect(Object.keys(res)).toEqual(["plan", "id", "tool_version", "phases", "started", "agent_coordinates", "interventions", "impact_verdict", "after_edit", "repair_steps", "final", "final_detail", "verdict", "churn", "candidate", "total_s"]);
    expect(Object.keys(res["phases"] as object)).toEqual(["impact", "apply", "bench_new", "repair", "proof", "guard", "diff"]);
    expect(res["started"]).toBe("2026-11-13T09:05:07");
    expect(res["after_edit"]).toBe("ws: open 1  drc 0  a7 0  a8 0  pairs-todo 0");
    expect(res["repair_steps"]).toEqual([{ try: ["finish"], wall_s: 1.25, out: ["now   step 1: open 0"] }]);
    expect(String(res["verdict"])).toMatch(/^(PASS all A1-A9 with parity|FAIL )/);
    expect(Object.keys(res["churn"] as object)).toEqual(["unplanned_moved", "collateral_nets", "collateral_mm", "planned_nets", "collateral_top"]);
    // the source project is untouched: the candidate lives in the run's copy
    expect(String(res["candidate"]).startsWith(join(out, "run", "project"))).toBe(true);
    expect(existsSync(join(dir, ".fabdesk", "board", "edits"))).toBe(false);
    const t = bench.editTable(await bench.readEditResults([join(out, "run")]));
    expect(t.json[0]).toMatchObject({ board: "t", task: "move", tool: "abc", verdict: res["verdict"] });
  });
});

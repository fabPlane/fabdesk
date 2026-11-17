import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESCAPES, bench, parseBoard } from "../src/index";
import { PCB, fakeEnv, fp } from "./review-fixture";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "bench-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A board with every kind of part the suite picks from: decouplers on a 3-pad rail, a pull-up, a lone series R, two IC rails. */
const BOARD = `(kicad_pcb (version 20250114)
	(gr_rect (start 0 0) (end 50 40) (layer "Edge.Cuts"))
	${fp("U1", 20, 20, [["1", "+3V3", 0, 0], ["2", "GND", 1, 0], ["3", "SDA", 2, 0], ["4", "LED", 3, 0], ["5", "+1V8", 4, 0], ["6", "DP", 5, 0], ["7", "DN", 6, 0]], "", "MCU")}
	${fp("C1", 10, 10, [["1", "+3V3", -0.5, 0], ["2", "GND", 0.5, 0]], "", "100n")}
	${fp("C2", 12, 10, [["1", "+3V3", -0.8, 0], ["2", "GND", 0.8, 0]], "", "1u")}
	${fp("C3", 14, 10, [["1", "+1V8", -0.5, 0], ["2", "GND", 0.5, 0]], "", "100n")}
	${fp("C4", 16, 10, [["1", "+1V8", -0.5, 0], ["2", "GND", 0.5, 0]], "", "100n")}
	${fp("R1", 30, 10, [["1", "+3V3", -0.5, 0], ["2", "SDA", 0.5, 0]], "", "4k7")}
	${fp("R2", 30, 14, [["1", "LED", -0.5, 0], ["2", "LEDK", 0.5, 0]], "", "1k")}
	${fp("D1", 34, 14, [["1", "LEDK", -0.5, 0], ["2", "GND", 0.5, 0]], "", "LED")}
	${fp("R3", 30, 20, [["1", "DP", -0.5, 0], ["2", "DN", 0.5, 0]], "", "100")}
)`;
const ACC = { net_classes: { classes: { USB: { pairs: [["DP", "DN"]] }, PWR_3V3: { nets: ["+1V8"] } } }, stack_policy: { ground_net: "GND" } };

describe("editbench tasks / table", () => {
  test("pick is the sorted list indexed by sha256(name:salt)", () => {
    expect(bench.pick([], "b", "x")).toBeNull();
    const a = bench.pick(["C3", "C1", "C2"], "board", "remove");
    expect(["C1", "C2", "C3"]).toContain(a!);
    expect(bench.pick(["C2", "C1", "C3"], "board", "remove")).toBe(a!);
  });

  test("the rules pick each kind of task from the board; pair nets and fixed parts are left alone", () => {
    const t = bench.editTasks({ name: "b", board: parseBoard(BOARD), acceptance: ACC, fixed: "^(C4)$", base: { board: "x" } });
    expect(Object.keys(t).sort()).toEqual(["add", "move", "net", "remove", "swap", "value"]);
    expect(["C1", "C2", "C3"]).toContain((t["remove"]!["remove"] as string[])[0]!);
    expect(t["remove"]!["board"]).toBe("x");
    const value = (t["value"]!["swap"] as Array<{ ref: string; value: string }>)[0]!;
    expect(value.ref).not.toBe("R3"); // on the USB pair
    expect(value.value.endsWith("-B")).toBe(true);
    expect((t["move"]!["move"] as Array<{ ref: string; near: string }>)[0]).toMatchObject({ ref: "R2", near: "U1" });
    const sw = (t["swap"]!["swap"] as Array<{ ref: string }>)[0]!;
    expect(["C1", "C2", "C3"]).toContain(sw.ref);
    const add = (t["add"]!["add"] as Array<{ ref: string; near: string; pins: Record<string, string> }>)[0]!;
    expect(add.near).toBe("U1");
    expect(add.ref).toMatch(/^C9\d\d$/);
    expect(Object.values(add.pins)).toContain("GND");
    const net = (t["net"]!["net"] as Array<{ pin: string; to: string; tap_width?: number }>)[0]!;
    expect(net).toMatchObject({ pin: "R1.1", to: "+1V8", tap_width: 0.15 });
  });

  test("writeEditTasks names the board relative to root when inside; the table reads result.json files and keeps Python floats", async () => {
    const d = await tmp();
    await mkdir(join(d, "proj", "req"), { recursive: true });
    await writeFile(join(d, "proj", "b.kicad_pcb"), BOARD);
    await writeFile(join(d, "proj", "req", "acceptance.json"), JSON.stringify(ACC));
    const t = await bench.writeEditTasks({ name: "b", src: join(d, "proj"), stem: "b", requirements: join(d, "proj", "req"), root: d, out: join(d, "plans") });
    expect(t["remove"]!["board"]).toBe("proj");
    expect(JSON.parse(await readFile(join(d, "plans", "remove.json"), "utf8"))["id"]).toBe("bench-b-remove");
    await mkdir(join(d, "res", "a"), { recursive: true });
    await mkdir(join(d, "res", "a-b"), { recursive: true });
    await writeFile(join(d, "res", "a-b", "result.json"), `{"id": "bench-b-net", "started": "2026-11-11T19:46:43", "verdict": "FAIL A1", "total_s": 3.5, "agent_coordinates": 1}`);
    await writeFile(join(d, "res", "a", "result.json"), `{"id": "bench-b-remove", "tool_version": "abc", "started": "2026-11-11T18:45:00", "verdict": "PASS all", "total_s": 75.0, "churn": {"collateral_nets": 0, "collateral_mm": 0.0, "unplanned_moved": ["R1"]}, "agent_coordinates": 0}`);
    const rows = await bench.readEditResults([join(d, "res")]);
    expect(rows.map((r) => r.id)).toEqual(["bench-b-remove", "bench-b-net"]);
    const tab = bench.editTable(rows);
    expect(tab.md.split("\n").slice(2)).toEqual(["| b-remove | abc | 18:45 | PASS all | 75.0 | 0 / 0.0 | 1 | 0 |", "| b-net | None | 19:46 | FAIL A1 | 3.5 | - / - | - | 1 |"]);
    expect(tab.json[0]).toMatchObject({ board: "b", task: "remove", pass: true, unplanned_moved: 1 });
  });
});

describe("pairbench", () => {
  const PAIRS = `(kicad_pcb
	(segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net "DP") (uuid "a"))
	(segment (start 0 0.4) (end 10 0.4) (width 0.2) (layer "F.Cu") (net "DN") (uuid "b"))
	(segment (start 0 5) (end 10 5) (width 0.2) (layer "F.Cu") (net "X") (uuid "c"))
	(via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "X") (uuid "d")))`;
  const spec = [{ p: "DP", n: "DN", class: "USB", w: 0.2, gap: 0.2, neck_w: 0.2, reach: 0.5 }];

  test("metrics: coupled share of 7 mm+ pairs, worst length difference; collateral is non-pair items that differ", () => {
    const m = bench.boardMetrics(PAIRS, spec, ["F.Cu", "B.Cu"]);
    expect(m.pairs_uncoupled).toBe(0);
    expect(m.shares["DP / DN"]).toBe(1);
    expect(m.worst_len_diff).toBe(0);
    const far = bench.boardMetrics(PAIRS.replace("(start 0 0.4) (end 10 0.4)", "(start 0 3) (end 12 3)"), spec, ["F.Cu", "B.Cu"]);
    expect(far.uncoupled).toEqual(["DP / DN"]);
    expect(far.focus_mean_share).toBe(0);
    expect(far.worst_len_diff).toBe(2);
    const a = bench.nonpairItems(PAIRS, new Set(["DP", "DN"]));
    expect(a.size).toBe(2);
    const b = bench.nonpairItems(PAIRS.replace('(uuid "c")', '(uuid "zz")').replace("(at 3 3)", "(at 4 3)"), new Set(["DP", "DN"]));
    expect(bench.symmetricDifference(a, b)).toBe(2); // the via moved; a new uuid alone is no change
  });

  test("table rows: start, passing and failed candidates", () => {
    const fig = { open: 1, drc: { clearance: 2 }, a7: 0, a7_mm: 0, a8: 3, pairs_todo: 0, pairs: {} };
    const t = bench.pairbenchTable([{ board: "b", src: "s", wall_s: 1, bench_stdout: "", start: { figures: fig, pairs_uncoupled: 2, focus_mean_share: 0.25, worst_len_diff: 1.125 }, rows: [
      { action: "tighten", wall_s: 12.5, figures: fig, verdict: "passes gate", pairs_uncoupled: 1, focus_mean_share: 1, worst_len_diff: 0.5, collateral: 4 },
      { action: "pairs", wall_s: null, figures: null, verdict: ["FAILED: x"] },
    ] }]).split("\n");
    expect(t[2]).toBe("| b | *start* | | 1 | 2 | 3 | 2 | 0.25 | 1.12 | | |");
    expect(t[3]).toBe("| | tighten | 12 | 1 | 2 | 3 | 1 | 1.0 | 0.50 | 4 | pass |");
    expect(t[4]).toBe("| | pairs | 0 | failed | | | | | | | ['FAILED: x'] |");
  });

  test("runPairbench writes pairbench.json and .md and carries on past a failed board", async () => {
    const d = await tmp();
    const fig = { open: 0, drc: {}, a7: 0, a7_mm: 0, a8: 0, pairs_todo: 0, pairs: {} };
    const said: string[] = [];
    const r = await bench.runPairbench({ boards: [{ name: "a", src: "x" }, { name: "b", src: "y" }], actions: ["tighten"] }, d, async (b) => {
      if (b.name === "b") throw new Error("no board");
      return { board: b.name, src: b.src, wall_s: 0, bench_stdout: "", start: { figures: fig, pairs_uncoupled: 0, focus_mean_share: null, worst_len_diff: 0 }, rows: [] };
    }, (l) => said.push(l));
    expect(said).toEqual(["a: done", "b: failed\nno board"]);
    expect(r.boards.length).toBe(1);
    expect(await readFile(join(d, "pairbench.md"), "utf8")).toContain("| a | *start* |");
    expect(JSON.parse(await readFile(join(d, "pairbench.json"), "utf8")).boards.length).toBe(1);
  });
});

describe("review bench (escape replay)", () => {
  test("catches: a non-note finding on the ref, pad and rule when named", () => {
    const f = { severity: "must-fix" as const, ref: "J1", pad: "", rule: "MOUTH" };
    expect(bench.catches(f, { board: "x", ref: "J1", rule: "MOUTH" })).toBe(true);
    expect(bench.catches(f, { board: "x", ref: "J1", pad: "3" })).toBe(false);
    expect(bench.catches({ ...f, severity: "note" }, { board: "x", ref: "J1" })).toBe(false);
  });

  test("replays an escape on a copy of its board and counts a clean board's L1-L4 findings", async () => {
    const d = await tmp();
    await mkdir(join(d, "boards", "bad"), { recursive: true });
    await writeFile(join(d, "boards", "bad", "b.kicad_pcb"), PCB); // J1 faces into the board
    await writeFile(join(d, "boards", "bad", "b.kicad_sch"), "(kicad_sch)");
    const boards = { "replay-bad.json": { name: "replay-bad", dir: "bad", stem: "b", checks_only: ["identity", "mouth"] }, "replay-good.json": { name: "replay-good", dir: "bad", stem: "b", checks_only: ["identity"] } };
    const escapes = { escapes: [{ id: "E01", expect: [{ board: "replay-bad.json", ref: "J1", rule: "MOUTH" }, { board: "replay-bad.json", ref: "U1", rule: "MOUTH", known_miss: true }] }], clean_boards: ["replay-good.json"] };
    const r = await bench.reviewBench({ boardsDir: join(d, "boards"), work: join(d, "work"), env: () => fakeEnv(), escapes, boards });
    expect(r.caught).toBe(1);
    expect(r.expected).toBe(2);
    expect(r.rows[0]).toMatchObject({ escape: "E01", board: "replay-bad", caught: true, by: ["L4:MOUTH:J1:-"] });
    expect(r.lines).toContain("  E01 replay-bad U1 missed (known miss) []");
    expect(r.clean).toEqual([{ board: "replay-good", findings_L1_L4: 0, ids: [] }]);
    // the board folder itself is never reviewed in place
    expect(await readFile(join(d, "boards", "bad", "b.kicad_pcb"), "utf8")).toBe(PCB);
  });

  test("the shipped replay board list covers every escape's expected board and clean board", () => {
    const named = new Set(Object.keys(bench.REPLAY_BOARDS));
    const esc = ESCAPES as unknown as bench.EscapesFile;
    for (const e of esc.escapes) for (const x of e.expect ?? []) expect(named.has(x.board)).toBe(true);
    for (const c of esc.clean_boards ?? []) expect(named.has(c)).toBe(true);
  });
});

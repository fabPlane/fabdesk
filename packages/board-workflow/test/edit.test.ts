import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EditStop,
  SheetSet,
  childLists,
  diffBoards,
  drcInputFromRaw,
  judge,
  listSpanAt,
  onboard,
  parseLossless,
  parsePlan,
  printLossless,
  removeSpans,
  revertNets,
  runAcceptance,
  runEdit,
  splice,
  topLevelSpans,
  type EditRunners,
} from "../src/index";
import { g } from "../src/edit/fmt";
import { planMoves } from "../src/edit/move";
import { pruneDangling } from "../src/edit/prune";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

// ---- a small project: board (KiCad 10.99 transform format) and one schematic sheet that agree with it
const fpT = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, opts: { value?: string; box?: number[]; rot?: number; side?: string } = {}) => {
  const [bx0, by0, bx1, by1] = opts.box ?? [-1, -0.6, 1, 0.6];
  return `
	(footprint "Lib:${ref.replace(/\d+$/, "")}X"
		(layer "${opts.side ?? "F"}.Cu")
		(uuid "fp-${ref}")
		(transform
			(translate ${x} ${y})
			(rotate ${opts.rot ?? 0})
			(scale 1 1)
		)
		(property "Reference" "${ref}"
			(at 0 -1 ${opts.rot ?? 0})
			(layer "F.SilkS")
			(uuid "pr-${ref}")
		)
		(property "Value" "${opts.value ?? "100n"}"
			(at 0 1 ${opts.rot ?? 0})
			(layer "F.Fab")
			(uuid "pv-${ref}")
		)
		(fp_rect (start ${bx0} ${by0}) (end ${bx1} ${by1}) (layer "F.CrtYd") (uuid "cy-${ref}"))
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py} ${opts.rot ?? 0}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}") (uuid "pad-${ref}-${n}"))`).join("\n\t\t")}
	)`;
};
const seg = (x1: number, y1: number, x2: number, y2: number, net: string, layer = "F.Cu") =>
  `\n	(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.2) (layer "${layer}") (net "${net}") (uuid "sg-${x1}-${y1}-${x2}-${y2}-${net}"))`;

const BOARD = `(kicad_pcb (version 20261025) (generator "pcbnew") (generator_version "10.99")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
	${fpT("J1", 5, 5, [["1", "VIN", 0, 0], ["2", "GND", 1.5, 0]], { box: [-1, -1, 3, 1], value: "CONN" })}
	${fpT("U1", 30, 20, [["1", "VIN", -1, 0], ["2", "SIG", 1, 0], ["3", "GND", 0, 1]], { box: [-2, -2, 2, 2], value: "IC" })}
	${fpT("R1", 20, 10, [["1", "SIG", -0.5, 0], ["2", "SIG2", 0.5, 0]], { value: "10k" })}
	${fpT("R2", 20, 14, [["1", "SIG2", -0.5, 0], ["2", "GND", 0.5, 0]], { value: "1k" })}
	${fpT("C1", 40, 10, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C2", 40, 14, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C3", 40, 18, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${seg(19.5, 10, 10, 10, "SIG")}
	${seg(20.5, 10, 19.5, 14, "SIG2")}
	${seg(39.5, 18, 29, 20, "VIN")}
	${seg(40.5, 18, 40.5, 25, "GND")}
	(via (at 40.5 25) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "via1"))
)`;
const PRO = JSON.stringify({ net_settings: { classes: [{ name: "Default", track_width: 0.15, clearance: 0.13 }] }, board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } } });

const pinRows = (x: number, y: number) => ({ p1: [x, y - 3.81], p2: [x, y + 3.81] });
const sym = (ref: string, value: string, x: number, y: number, nets: [string, string], lib = "Device:C") => {
  const p = pinRows(x, y);
  const lab = (net: string, [px, py]: number[]) => `
	(global_label "${net}" (shape passive) (at ${px} ${py} 180) (effects (font (size 1 1))) (uuid "lb-${ref}-${net}")
		(property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${px} ${py} 0) (effects (font (size 1 1)) (hide yes))))`;
  return `
	(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "sy-${ref}")
		(property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1 1))))
		(property "Value" "${value}" (at ${x + 2} ${y + 2} 0) (effects (font (size 1 1))))
		(property "Footprint" "Lib:${ref.replace(/\d+$/, "")}X" (at ${x} ${y} 0) (effects (font (size 1 1)) (hide yes)))
		(pin "1" (uuid "pn1-${ref}"))
		(pin "2" (uuid "pn2-${ref}"))
		(instances (project "t" (path "/root-uuid" (reference "${ref}") (unit 1)))))${lab(nets[0], p.p1!)}${lab(nets[1], p.p2!)}`;
};
const libSym = (id: string) => `
		(symbol "${id}"
			(symbol "${id.split(":")[1]}_1_1"
				(pin passive line (at 0 3.81 270) (length 2.54) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1)))))
				(pin passive line (at 0 -3.81 90) (length 2.54) (name "~" (effects (font (size 1 1)))) (number "2" (effects (font (size 1 1)))))))`;
const SHEET = `(kicad_sch (version 20250114) (generator "eeschema")
	(uuid "root-uuid")
	(lib_symbols${libSym("Device:C")}${libSym("Device:R")}
	)${sym("C1", "100n", 50, 50, ["VIN", "GND"])}${sym("C2", "100n", 70, 50, ["VIN", "GND"])}${sym("C3", "100n", 90, 50, ["VIN", "GND"])}${sym("R1", "10k", 110, 50, ["SIG", "SIG2"], "Device:R")}${sym("R2", "1k", 130, 50, ["SIG2", "GND"], "Device:R")}
)
`;

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
const runners = (over: Partial<EditRunners> = {}): EditRunners => ({ accept: (dir) => runAcceptance(dir, { drc: async () => clean }), ...over });

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
  test("planMoves: a swap of two parts' poses is two moves and re-seats nothing", () => {
    const { led } = planMoves(BOARD, (r) => r === "J1", [{ ref: "C1", to: [40, 14, 0] }, { ref: "C2", to: [40, 10, 0] }], undefined, []);
    expect(led.moved.map((m) => m.ref)).toEqual(["C1", "C2"]);
    expect(led.displaced).toEqual([]);
    expect(led.inherited_overlaps).toBeUndefined();
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

/** The candidate-flow plan keys: copper (copper_plan), hole (mechanical_hole), stack (stack_plan), on small fixtures. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboard, runAcceptance } from "../src/index";
import { parseBoard } from "../src/board";
import { EditStop, parsePlan, runEdit, type EditRunners } from "../src/edit/index";
import { copperPlan, f6, pyFloat, sha256 } from "../src/edit/copper";
import { crossPoint, interpolate, pointSegDist, project as projectAlong, type P } from "../src/edit/geos";
import { changeFp, holeEdit } from "../src/edit/hole";
import { stackAcceptance, stackBoard, stackupText, withStackup } from "../src/edit/stack";
import { BOARD, PRO, SHEET, fpT, seg } from "./edit-fixture";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const clean = { violations: [], unconnected: 0, parity: 0 };
const runners = (): EditRunners => ({ accept: (dir, pcb) => runAcceptance(dir, { pcb, drc: async () => clean }) });
const seq = () => {
  let i = 0;
  return () => `00000000-0000-4000-8000-${String(++i).padStart(12, "0")}`;
};

// ---- copper fixture: SIG runs R1.1 -> (31,10) -> U1.2 with a dead T branch ending on a one-layer via
const COPPER = `(kicad_pcb (version 20261025) (generator "pcbnew") (generator_version "10.99")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
	${fpT("U1", 30, 20, [["1", "VIN", -1, 0], ["2", "SIG", 1, 0], ["3", "GND", 0, 1]], { box: [-2, -2, 2, 2], value: "IC" })}
	${fpT("R1", 20, 10, [["1", "SIG", -0.5, 0], ["2", "SIG2", 0.5, 0]], { value: "10k" })}
	${fpT("C1", 40, 10, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C2", 40, 14, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${seg(19.5, 10, 31, 10, "SIG")}
	${seg(31, 10, 31, 20, "SIG")}
	${seg(25, 10, 25, 14, "SIG")}
	(via (at 25 14) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "via-dead"))
	(via (at 40.5 14) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "via-gnd"))
	${seg(20.5, 10, 20.5, 16, "SIG2")}
	(zone (net "GND") (net_name "GND") (layers "B.Cu") (uuid "z1") (polygon (pts (xy 0 0) (xy 60 0) (xy 60 40) (xy 0 40))))
)
`;

describe("copper (copper_plan.py)", () => {
  test("prune splits at the T, drops the dead branch and its one-layer via, rewrites the net's tracks as pieces", () => {
    const r = copperPlan(COPPER, { prune_signal_leaves: ["SIG"] }, seq());
    expect(r.ledger.removed.map((x) => x.kind)).toEqual(["single-layer-via", "leaf-track"]);
    expect(r.ledger.removed[1]).toMatchObject({ a: [25, 10], b: [25, 14], layer: "F.Cu", net: "SIG" });
    const b = parseBoard(r.text);
    const sig = b.segments.filter((s) => s.net === "SIG").map((s) => [s.a, s.b]);
    expect(sig).toEqual([[[19.5, 10], [25, 10]], [[25, 10], [31, 10]], [[31, 10], [31, 20]]]);
    expect(b.vias.map((v) => v.net)).toEqual(["GND"]);
    expect(r.text).toContain('(segment (start 19.500000 10.000000) (end 25.000000 10.000000) (width 0.2) (layer "F.Cu") (net "SIG") (uuid "00000000-0000-4000-8000-000000000001"))');
    // other nets untouched, byte for byte
    expect(r.text).toContain(seg(20.5, 10, 20.5, 16, "SIG2").trim());
    expect(r.text.endsWith('(uuid "00000000-0000-4000-8000-000000000003"))\n)\n')).toBe(true);
  });

  test("via_at_pad adds a filled/capped F-B via at the pad centre; refuses where a via already is", () => {
    const r = copperPlan(COPPER, { via_at_pad: [{ ref: "C1", pad: 2, diameter: 0.5, drill: 0.2 }] }, seq());
    expect(r.text).toContain('(via (at 40.500000 10.000000) (size 0.5) (drill 0.2) (layers "F.Cu" "B.Cu") (net "GND") (uuid "00000000-0000-4000-8000-000000000001") (filling yes) (capping yes))');
    expect(() => copperPlan(COPPER, { via_at_pad: [{ ref: "C2", pad: "2", diameter: 0.5, drill: 0.2 }] })).toThrow(/via already exists/);
    expect(() => copperPlan(COPPER, { via_at_pad: [{ ref: "C2", pad: "9", diameter: 0.5, drill: 0.2 }] })).toThrow(/expected one netted pad/);
  });

  test("remove_items takes exactly one copper item per uuid; plane nets refuse signal pruning; the sha guard", () => {
    const r = copperPlan(COPPER, { remove_items: ["via-dead"] });
    expect(r.text).not.toContain("via-dead");
    expect(r.ledger.removed[0]).toMatchObject({ kind: "explicit-item" });
    expect(() => copperPlan(COPPER, { remove_items: ["nope"] })).toThrow(/Expected one copper UUID nope, got 0/);
    expect(() => copperPlan(COPPER, { prune_signal_leaves: ["GND"] })).toThrow(/Refuse to prune plane vias/);
    expect(copperPlan(COPPER, { prune_track_leaves: ["GND"] }).ledger.removed).toEqual([]);
    expect(() => copperPlan(COPPER, { source_sha256: "0".repeat(64) })).toThrow(EditStop);
    expect(() => copperPlan(COPPER, { source_sha256: sha256(COPPER) })).not.toThrow();
  });

  test("numbers print as Python does", () => {
    expect(f6(1 / 128)).toBe("0.007812"); // a tie: half to even
    expect(f6(-0)).toBe("-0.000000");
    expect(pyFloat(1)).toBe("1.0");
    expect(pyFloat(0.15)).toBe("0.15");
    expect(pyFloat(5e-5)).toBe("5e-05");
  });

  test("GEOS segment operations land on shapely's doubles", () => {
    // values from shapely 2.0.3 / GEOS 3.12.1
    const cases: Array<[P, P, P, P, P, number, number]> = [
      [[0.1, 0.2], [3.3, 1.7], [0.5, 2.9], [2.9, -0.3], [1.8942196531791906, 1.0410404624277456], 1.981558281579205, 2.274965576596657],
      [[10.123, 5.0], [12.777, 7.31], [10.0, 7.0], [13.1, 4.9], [11.361320753235331, 6.077814973614776], 1.6416831013449398, 1.5893522605475423],
      [[1, 1], [5, 1], [3, 1], [3, 4], [3, 1], 2, 0],
      [[0, 0], [4, 4], [0, 4], [4, 0], [2, 2], 2.8284271247461903, 2.8284271247461903],
    ];
    for (const [a, b, c, d, ip, pr, dist] of cases) {
      expect(crossPoint(a, b, c, d)).toEqual(ip);
      expect(projectAlong(a, b, ip)).toBe(pr);
      expect(interpolate(a, b, pr)).toEqual(ip);
      expect(pointSegDist(c, a, b)).toBe(dist);
    }
    expect(crossPoint([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
  });
});

// ---- hole fixture: a locating hole as C6's FIT_P2, its keep-out and its library footprint
const HOLE_FP = (indent: string) => `(footprint "Parts:FIT_P2"
${indent}(layer "F.Cu")
${indent}(uuid "fit-p2")
${indent}(transform (translate 10 10) (rotate 0) (scale 1 1))
${indent}(property "Reference" "FIT_P2" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "pr-fit"))
${indent}(property "Value" "Locator_P2_1.6x1.6mm_NPTH" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "pv-fit"))
${indent}(attr board_only exclude_from_pos_files exclude_from_bom)
${indent}(fp_rect (start -1.05 -1.05) (end 1.05 1.05) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "c1"))
${indent}(fp_rect (start -1.05 -1.05) (end 1.05 1.05) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "c2"))
${indent}(pad "" np_thru_hole circle (at 0 0) (size 1.6 1.6) (drill 1.6) (layers "*.Cu" "*.Mask") (uuid "pad-fit")))`;
const HOLE_ZONE = `(zone (net "") (layers "F.Cu" "B.Cu") (uuid "zk") (name "Mechanical FIT_P2 surface copper and via clearance") (hatch edge 0.5)
		(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
		(polygon (pts (xy 8.95 8.95) (xy 11.05 8.95) (xy 11.05 11.05) (xy 8.95 11.05))))`;
const withHole = (b: string) => b.replace(/\n\)\s*$/, `\n\t${HOLE_FP("\t\t")}\n\t${HOLE_ZONE}\n)\n`);

describe("hole (mechanical_hole.py)", () => {
  test("round 1.6 -> oval 2.0 x 1.8: pad, value, courtyards, keep-out and the library footprint; nothing else", () => {
    const board = withHole(BOARD);
    const lib = HOLE_FP("  ");
    const r = holeEdit(board, { ref: "FIT_P2", size_mm: [2.0, 1.8], clearance_mm: 0.25 }, lib);
    for (const t of [r.text, r.lib]) {
      expect(t).toContain('(pad "" np_thru_hole oval (at 0 0) (size 2 1.8) (drill oval 2 1.8)');
      expect(t).toContain('"Locator_P2_2x1.8mm_NPTH"');
      expect(t).toContain("(start -1.25 -1.15) (end 1.25 1.15)");
    }
    expect(r.text).toContain("(polygon (pts (xy 8.75 8.85) (xy 11.25 8.85) (xy 11.25 11.15) (xy 8.75 11.15)))");
    expect(r.centre).toEqual([10, 10]);
    const cut = (t: string) => t.slice(0, t.indexOf('(footprint "Parts:FIT_P2"'));
    expect(cut(r.text)).toBe(cut(board));
    // round stays round
    expect(changeFp(lib, "FIT_P2", [1.8, 1.8], 0.25)).toContain("(pad \"\" np_thru_hole circle (at 0 0) (size 1.8 1.8) (drill 1.8)");
  });

  test("refusals: a rotated hole, a netted or offset pad, a missing keep-out (unless keepout: false)", () => {
    const board = withHole(BOARD);
    expect(() => holeEdit(board.replace("(rotate 0) (scale 1 1))\n\t\t(property \"Reference\" \"FIT_P2\"", "(rotate 90) (scale 1 1))\n\t\t(property \"Reference\" \"FIT_P2\""), { ref: "FIT_P2", size_mm: [2, 1.8] }, HOLE_FP(""))).toThrow(/rotated/);
    expect(() => holeEdit(board.replace('(pad "" np_thru_hole circle (at 0 0)', '(pad "" np_thru_hole circle (at 0.1 0)'), { ref: "FIT_P2", size_mm: [2, 1.8] }, HOLE_FP(""))).toThrow(/offset/);
    const noZone = board.replace(HOLE_ZONE, "");
    expect(() => holeEdit(noZone, { ref: "FIT_P2", size_mm: [2, 1.8] }, HOLE_FP(""))).toThrow(/expected one zone/);
    expect(holeEdit(noZone, { ref: "FIT_P2", size_mm: [2, 1.8], keepout: false }, HOLE_FP("")).text).toContain("(size 2 1.8)");
    expect(() => parsePlan({ id: "h", hole: { ref: "FIT_P2", size_mm: [12, 1] } })).toThrow(/0 < X, Y < 10/);
  });
});

describe("stack (stack_plan.py)", () => {
  const acc = () => ({
    net_classes: {
      classes: {
        PWR_200: { nets: ["A", "B", "C"], inner_track_width: 0.2 },
        USB90: { pairs: [["DP", "DM"]], diff_pair_gap: 0.2 },
        LVDS100: { pairs: [["R0+", "R0-"], ["R1+", "R1-"]], diff_pair_gap: 0.3 },
      },
    },
    supplier_stack: { pair_class_estimate_ohm: 90, keep: 1 },
  });
  test("class updates, splits by nets and by pairs, the acceptance merge and key removals", () => {
    const a = acc() as unknown as Record<string, unknown>;
    stackAcceptance(a, {
      classes: { USB90: { diff_pair_gap: 0.125 } },
      split_classes: {
        PWR_LCD5: { from: "PWR_200", nets: ["B"], updates: { inner_track_width: 0.5 } },
        LVDS100_RX1: { from: "LVDS100", pairs: [["R1+", "R1-"]], updates: { diff_pair_gap: 0.225 } },
      },
      acceptance: { supplier_stack: { material: "NP-155F" } },
      remove_acceptance_paths: ["supplier_stack.pair_class_estimate_ohm"],
    });
    expect(a).toEqual({
      net_classes: {
        classes: {
          PWR_200: { nets: ["A", "C"], inner_track_width: 0.2 },
          USB90: { pairs: [["DP", "DM"]], diff_pair_gap: 0.125 },
          LVDS100: { pairs: [["R0+", "R0-"]], diff_pair_gap: 0.3 },
          PWR_LCD5: { nets: ["B"], inner_track_width: 0.5 },
          LVDS100_RX1: { pairs: [["R1+", "R1-"]], diff_pair_gap: 0.225 },
        },
      },
      supplier_stack: { keep: 1, material: "NP-155F" },
    });
    expect(() => stackAcceptance(acc() as never, { classes: { NOPE: {} } })).toThrow(/NOPE/);
  });

  const STACK = `(kicad_pcb (version 20261025)
	(setup
		(stackup
			(layer "F.Cu" (type "copper") (thickness 0.035))
			(layer "dielectric 1" (type "prepreg") (thickness 0.1) (material "3313") (epsilon_r 4.05) (loss_tangent 0.02))
			(layer "B.Cu" (type "copper") (thickness 0.035))
		)
	)
	(via (at 1 1) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "LCD5") (uuid "v1"))
	(via (at 2 2) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v2"))
)
`;
  test("dielectric epsilon_r and named via removals (with a reason); the stackup carried as text for adopt", () => {
    const r = stackBoard(STACK, { dielectrics: { "dielectric 1": { er: 4.1 } }, remove_vias: [{ uuid: "v1", net: "LCD5", reason: "one-layer barrel" }] });
    expect(r.text).toContain("(epsilon_r 4.1)");
    expect(r.text).not.toContain('"v1"');
    expect(r.text).toContain('"v2"');
    expect(() => stackBoard(STACK, { remove_vias: [{ uuid: "v1", net: "GND", reason: "x" }] })).toThrow(/not unique/);
    expect(() => stackBoard(STACK, { remove_vias: [{ uuid: "v1", net: "LCD5", reason: "" }] })).toThrow(/engineering reason/);
    expect(() => stackBoard(STACK, { dielectrics: { "dielectric 9": { er: 4 } } })).toThrow(/missing dielectric/);
    expect(withStackup(STACK, stackupText(r.text)!)).toBe(STACK.replace("(epsilon_r 4.05)", "(epsilon_r 4.1)"));
    expect(() => parsePlan({ id: "s", stack: { copper_source: "x.kicad_pcb" }, move: [{ ref: "R1", to: [1, 2, 0] }] })).toThrow(/plan of its own/);
  });
});

async function project(board: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "editkeys-"));
  dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), board);
  await writeFile(join(dir, "board.kicad_pro"), PRO);
  await writeFile(join(dir, "board.kicad_sch"), SHEET);
  for (const [n, t] of Object.entries(extra)) {
    await mkdir(join(dir, n, ".."), { recursive: true });
    await writeFile(join(dir, n), t);
  }
  await onboard(dir, { name: "t" });
  return dir;
}

describe("the keys through impact, apply, proof", () => {
  test("copper: the ledger, planned nets (no collateral), nothing to route again", async () => {
    const dir = await project(BOARD);
    const r = await runEdit({ projectDir: dir, plan: { id: "cu", copper: { prune_signal_leaves: ["SIG"], via_at_pad: [{ ref: "C1", pad: "1", diameter: 0.5, drill: 0.2 }] } }, mode: "full", runners: runners() });
    expect(r.impact.keys?.copper?.removed.leaf_tracks).toBe(1);
    expect(r.impactLines.some((l) => l.startsWith("copper via at C1.1 (VIN)"))).toBe(true);
    expect(r.stage).toBe("proof");
    expect(r.applied?.copper).toMatchObject({ added_vias: 1, nets: ["SIG", "VIN"] });
    expect(r.repair?.routeAgain).toEqual([]);
    expect(r.churn).toMatchObject({ collateral_nets: 0, unplanned_moved: [] });
    const ledger = JSON.parse(await readFile(join(r.candidate!.dir, "copper-ledger.json"), "utf8"));
    expect(ledger.source_sha256).toBe(sha256(BOARD));
    expect(ledger.removed[0]).toMatchObject({ kind: "leaf-track", net: "SIG" });
    // a wrong guard is a FAIL at impact, nothing written
    const bad = await runEdit({ projectDir: dir, plan: { id: "cu2", copper: { source_sha256: "0".repeat(64) } }, mode: "full", runners: runners() });
    expect(bad.stage).toBe("impact");
    expect(bad.verdict).toMatch(/^FAIL copper: Source revision mismatch/);
  });

  test("hole: the candidate's library footprint changes, origin.json lists it for adopt, the project stays as it was", async () => {
    const lib = HOLE_FP("  ") + "\n";
    const dir = await project(withHole(BOARD), { "fp-lib-table": '(fp_lib_table (version 7) (lib (name "Parts") (type "KiCad") (uri "${KIPRJMOD}/Parts.pretty") (options "") (descr "")))\n', "Parts.pretty/FIT_P2.kicad_mod": lib });
    const r = await runEdit({ projectDir: dir, plan: { id: "p2", hole: { ref: "FIT_P2", size_mm: [2.0, 1.8] }, accept_before: { A3_parity: "board-only locating hole" } }, mode: "full", runners: runners() });
    expect(r.impact.keys?.hole).toMatchObject({ ref: "FIT_P2", centre: [10, 10], library_file: "Parts.pretty/FIT_P2.kicad_mod" });
    expect(r.stage).toBe("proof");
    const cand = r.candidate!.dir;
    expect(await readFile(join(cand, "Parts.pretty/FIT_P2.kicad_mod"), "utf8")).toContain("(drill oval 2 1.8)");
    expect(await readFile(join(dir, "Parts.pretty/FIT_P2.kicad_mod"), "utf8")).toBe(lib);
    const origin = JSON.parse(await readFile(join(cand, "origin.json"), "utf8"));
    expect(origin.extra).toEqual({ "Parts.pretty/FIT_P2.kicad_mod": sha256(lib) });
    expect(JSON.parse(await readFile(join(cand, "hole-edit.json"), "utf8"))).toMatchObject({ ref: "FIT_P2", size_mm: [2, 1.8], copper_authored: 0 });
    expect(r.diff?.moved).toEqual([]);
    expect(Object.keys(r.diff?.copper_changed_nets ?? {})).toEqual([]);
  });

  test("stack: acceptance classes and the stackup change in the candidate; a removed via's net is planned", async () => {
    const board = BOARD.replace("(gr_rect", '(setup (stackup (layer "F.Cu" (type "copper")) (layer "dielectric 1" (type "core") (thickness 1.5) (epsilon_r 4.5) (loss_tangent 0.02)) (layer "B.Cu" (type "copper"))))\n\t(gr_rect');
    const dir = await project(board);
    const ap = join(dir, ".fabdesk/board/requirements/acceptance.json");
    const acc = JSON.parse(await readFile(ap, "utf8"));
    acc.net_classes.classes["SIGC"] = { nets: ["SIG", "SIG2"], track_width: 0.2 };
    await writeFile(ap, JSON.stringify(acc, null, 1));
    const plan = {
      id: "st",
      stack: {
        split_classes: { SIG2C: { from: "SIGC", nets: ["SIG2"], updates: { track_width: 0.25 } } },
        acceptance: { supplier_stack: { material: "NP-155F" } },
        dielectrics: { "dielectric 1": { er: 4.17 } },
        remove_vias: [{ uuid: "via1", net: "GND", reason: "test: the barrel joins one layer" }],
      },
      accept_before: { A3_parity: "fixture" },
    };
    const r = await runEdit({ projectDir: dir, plan, mode: "full", runners: runners() });
    expect(r.impact.keys?.stack?.dielectrics).toEqual({ "dielectric 1": ["4.5", 4.17] });
    expect(r.stage).toBe("proof");
    const cand = r.candidate!.dir;
    expect(await readFile(r.candidate!.pcb, "utf8")).toContain("(epsilon_r 4.17)");
    const ca = JSON.parse(await readFile(join(cand, ".fabdesk/board/requirements/acceptance.json"), "utf8"));
    expect(ca.net_classes.classes["SIGC"].nets).toEqual(["SIG"]);
    expect(ca.net_classes.classes["SIG2C"]).toEqual({ nets: ["SIG2"], track_width: 0.25 });
    expect(ca.supplier_stack).toEqual({ material: "NP-155F" });
    expect(r.applied?.stack?.nets).toEqual(["GND"]);
    expect(r.churn?.collateral_nets).toBe(0);
    const origin = JSON.parse(await readFile(join(cand, "origin.json"), "utf8"));
    expect(Object.keys(origin.extra)).toEqual([".fabdesk/board/requirements/acceptance.json"]);
    expect(JSON.parse(await readFile(join(cand, "stack-plan.json"), "utf8"))).toMatchObject({ changed_copper: true, copper_source: null });
  });
});

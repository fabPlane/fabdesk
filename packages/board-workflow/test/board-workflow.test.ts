import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAcceptance,
  deriveRequirements,
  designHash,
  locateProject,
  findPairs,
  legacyNetRefs,
  onboard,
  parseBoard,
  parseSexpr,
  profile,
  pyRound,
  readAcceptanceState,
  readProjectSettings,
  readRequirements,
  runAcceptance,
  toAcceptResults,
  valueSi,
} from "../src/index";

const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, extra = "", value = "10k") => `
	(footprint "Lib:${ref}"
		${extra}
		(layer "F.Cu")
		(at ${x} ${y} 90)
		(property "Reference" "${ref}" (at 0 0))
		(property "Value" "${value}" (at 0 0))
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}"))`).join("\n")}
	)`;
const seg = (x1: number, y1: number, x2: number, y2: number, w: number, layer: string, net: string) =>
  `\n	(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width ${w}) (layer "${layer}") (net "${net}"))`;

const BOARD = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "core") (thickness 0.2) (material "FR4") (epsilon_r 4.5))))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	${fp("J1", 5, 5, [["1", "VIN", 0, 0], ["2", "GND", 1, 0]])}
	${fp("R1", 20, 10, [["1", "VIN", -1, 0], ["2", "SIG", 1, 0]], "", "4k7")}
	${fp("U1", 30, 20, [["1", "USB_DP", 0, 0], ["2", "USB_DN", 1, 0], ["3", "VIN", 2, 0], ["4", "GND", 3, 0]], "", "IC")}
	${fp("H1", 2, 2, [])}
	(zone (net "GND") (net_name "GND") (layers "In1.Cu") (uuid "z"))
	(zone (layers "F.Cu") (uuid "keepout"))
	${seg(0, 0, 10, 0, 0.1, "F.Cu", "VIN")}
	${seg(0, 5, 10, 5, 0.15, "F.Cu", "USB_DP")}
	${seg(0, 5.3, 10, 5.3, 0.15, "F.Cu", "USB_DN")}
	(via (at 3 3) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND"))
)`;
const PRO = JSON.stringify({
  net_settings: {
    classes: [
      { name: "Default", track_width: 0.15, clearance: 0.13 },
      { name: "Power", track_width: 0.4 },
      { name: "USB", track_width: 0.15, diff_pair_width: 0.15, diff_pair_gap: 0.2 },
    ],
    netclass_patterns: [{ pattern: "USB_*", netclass: "USB" }],
    netclass_assignments: { VIN: "Power" },
  },
  board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } },
});

describe("s-expression and board model", () => {
  test("parses quoted strings with escapes and nesting", () => {
    expect(parseSexpr('(a "x \\"y\\"" (b 1 2) c)')).toEqual(["a", 'x "y"', ["b", "1", "2"], "c"]);
    expect(() => parseSexpr("(a (b)")).toThrow();
  });
  test("reads footprints, pads, tracks, vias, zones, stackup and outline", () => {
    const b = parseBoard(BOARD);
    expect(b.footprints.size).toBe(4);
    expect(b.pads).toHaveLength(8);
    const u1 = b.pads.find((p) => p.ref === "U1" && p.pad === "2")!;
    expect(u1.x).toBeCloseTo(30 + 1 * Math.cos(Math.PI / 2) + 0, 6); // rotated 90 degrees about the footprint origin
    expect(b.segments).toHaveLength(3);
    expect(b.vias[0]).toMatchObject({ kind: "through", net: "GND" });
    expect(b.zones).toEqual([{ net: "GND", layers: ["In1.Cu"] }]); // the rule area is not copper
    expect(b.copperLayers).toEqual(["F.Cu", "In1.Cu", "B.Cu"]);
    expect(b.stackup[1]).toMatchObject({ thickness: 0.2, epsilonR: 4.5 });
    expect(b.outline).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 30 });
    expect(legacyNetRefs("\n\t\t(net 12)")).toBe(1);
  });
});

describe("onboarding", () => {
  test("pair finding, values", () => {
    expect(findPairs(["USB_DP", "USB_DN", "CLK_P", "CLK_M", "LONE_P", "X"])).toEqual([
      ["CLK_P", "CLK_M"],
      ["USB_DP", "USB_DN"],
    ]);
    expect(valueSi("4k7")).toBeCloseTo(4700);
    expect(valueSi("100n")).toBeCloseTo(1e-7);
    expect(valueSi("DNP")).toBeNull();
  });
  test("derives fixed parts, planes, classes, pairs and taps", () => {
    const d = deriveRequirements(BOARD, readProjectSettings(PRO), { pcbName: "board.kicad_pcb", name: "t" });
    expect(d.fixed).toEqual(["H1", "J1"]);
    expect(d.requirements.acceptance.stack_policy.plane_layers).toEqual(["In1.Cu"]);
    const cls = d.requirements.acceptance.net_classes.classes;
    expect(Object.keys(cls)).toEqual(["PWR_400", "PAIR_USB"]);
    expect(cls["PAIR_USB"]!.pairs).toEqual([["USB_DP", "USB_DN"]]);
    expect(cls["PAIR_USB"]!.layers).toEqual(["F.Cu", "B.Cu"]);
    expect(cls["PWR_400"]!.nets).toEqual(["VIN"]);
    expect(d.requirements.acceptance.net_classes.tap_pads["VIN"]).toMatchObject({ "R1.1": { width: 0.15 } });
    expect(d.requirements.mechanical.anchors[1]).toMatchObject({ reference: "J1", at: ["5", "5"], rotation: ["90"], layer: "F.Cu" });
  });
  test("refuses the pre-10 file format", () => {
    expect(() => deriveRequirements("(kicad_pcb\n\t(segment\n\t\t(net 3)\n\t)\n)", readProjectSettings(PRO), { pcbName: "b" })).toThrow(/pre-10/);
  });
});

describe("acceptance", () => {
  test("plane_layers as {layer: net} (the toolkit's current form) means the same layers as the list", () => {
    const base = { schema: "X", stack_policy: { copper_layers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], ground_net: "GND", via_spans: {} } };
    const asMap = profile({ ...base, stack_policy: { ...base.stack_policy, plane_layers: { "In1.Cu": "GND", "In2.Cu": "GND" } } } as never);
    const asList = profile({ ...base, stack_policy: { ...base.stack_policy, plane_layers: ["In1.Cu", "In2.Cu"] } } as never);
    expect([...asMap.planes].sort()).toEqual(["In1.Cu", "In2.Cu"]);
    expect([...asList.planes].sort()).toEqual(["In1.Cu", "In2.Cu"]);
  });
  const settings = readProjectSettings(PRO);
  const reqs = () => deriveRequirements(BOARD, settings, { pcbName: "b" }).requirements;
  const clean = { violations: [], unconnected: 0, parity: 0 };
  const board = parseBoard(BOARD);

  test("a board passes its own onboarded requirements except where it really fails", () => {
    const r = checkAcceptance(board, reqs(), clean);
    expect(r.summary.A4_circuit && r.summary.A5_anchors && r.summary.A6_stack && r.summary.A9_heights).toBe(true);
    // VIN is 0.1 mm on a 0.4 mm class and not within a pad neck: A7 fails, as the toolkit would say
    expect(r.results.A7_widths).toMatchObject({ pass: false, nets_failing: 1 });
    expect(Object.keys(r.results.A7_widths["undersize_length_mm"] as object)).toEqual(["VIN"]);
    // the pair is coupled (0.3 mm apart) and the right width, but short of 7 mm limit so coupling is not required
    expect(r.results.A8_pairs["pass"]).toBe(true);
  });
  test("A1-A3 come from the DRC input; the PWR proxy findings go to A7", () => {
    const r = checkAcceptance(board, reqs(), {
      violations: [
        { rule: "clearance", severity: "error", description: "x" },
        { rule: "track_width", severity: "error", description: "Track width (rule 'PWR_400 outer width'; min 0.4)" },
        { rule: "silk_overlap", severity: "warning", description: "w" },
      ],
      unconnected: 2,
      parity: 1,
    });
    expect(r.results.A1_connectivity).toMatchObject({ pass: false, unconnected: 2 });
    expect(r.results.A2_drc).toMatchObject({ pass: false, errors: { clearance: 1 }, class_width_proxy_findings_judged_by_A7: 1 });
    expect(r.results.A3_parity).toMatchObject({ pass: false, items: 1 });
  });
  test("A4 A5 A6 A9 failures", () => {
    const q = reqs();
    q.circuit.components[0]!.value = "changed";
    q.circuit.components.push({ reference: "ZZ", value: null, pins: {} });
    q.mechanical.anchors[0]!.at = ["9", "9"];
    q.acceptance.stack_policy.no_track_layers = ["F.Cu"];
    q.acceptance.stack_policy.plane_layers = ["F.Cu"];
    q.acceptance.heights = { F_max_mm: 3, B_max_mm: 3 };
    q.heights.entries = [{ ref: "R1", height_above_surface_mm: 5 }];
    const r = checkAcceptance(board, q, clean);
    expect(r.results.A4_circuit).toMatchObject({ pass: false, missing: ["ZZ"], value_diff: ["H1"] });
    expect(r.results.A5_anchors).toMatchObject({ pass: false, failed: ["H1"] });
    expect(r.results.A6_stack["non_gnd_plane_track_segments"]).toBe(3);
    expect(r.results.A9_heights).toMatchObject({ pass: false, over_limit: { R1: { side: "F", height_mm: 5, limit_mm: 3 } } });
    const na = toAcceptResults(checkAcceptance(board, reqs(), clean)).find((x) => x.code === "A9");
    expect(na?.status).toBe("na");
  });
  test("a tap branch is accepted at its tap width", () => {
    const q = reqs();
    // R1.1 is a tap pad (0.15 mm); a 0.15 mm stub from VIN's trunk to R1 is judged as a tap, not an undersize track
    const b = parseBoard(BOARD.replace(seg(0, 0, 10, 0, 0.1, "F.Cu", "VIN"), seg(19, 10, 19.2, 10, 0.15, "F.Cu", "VIN")));
    expect(checkAcceptance(b, q, clean).results.A7_widths["pass"]).toBe(true);
  });
  test("named PWR classes are courtyard proxies too (PWR_LOGIC_3313), not only PWR_<digits>", () => {
    const r = checkAcceptance(board, reqs(), {
      violations: [
        { rule: "track_width", severity: "error", description: "Track width (rule 'PWR_LOGIC_3313 inner width'; min 0.2)" },
        { rule: "track_width", severity: "error", description: "Track width (rule 'PWR_LCD33_3313 neck in courtyard'; min 0.2)" },
        { rule: "track_width", severity: "error", description: "Track width (rule 'USB90 width'; min 0.1)" },
      ],
      unconnected: 0,
      parity: 0,
    });
    expect(r.results.A2_drc).toMatchObject({ pass: false, errors: { track_width: 1 }, class_width_proxy_findings_judged_by_A7: 2 });
  });
  test("courtyard overlaps are accepted only for the footprint pairs acceptance.json names; gone ones are reported", () => {
    const q = reqs();
    q.acceptance.courtyard_overlap_exceptions = [
      { refs: ["U1", "R1"], gap_mm: 0.2, basis: "measured" },
      { refs: ["J1", "H1"], basis: "measured" },
    ];
    const overlap = (a: string, b: string) => ({ rule: "courtyards_overlap", severity: "error", description: "Courtyards overlap", items: [{ description: `Footprint ${a} [x]` }, { description: `Footprint ${b}` }] });
    const r = checkAcceptance(board, q, {
      violations: [overlap("R1", "U1"), overlap("R1", "J1"), { rule: "courtyards_overlap", severity: "error", description: "Courtyards overlap" }, { ...overlap("R1", "U1"), severity: "warning" }],
      unconnected: 0,
      parity: 0,
    });
    expect(r.results.A2_drc).toEqual({
      pass: false,
      errors: { courtyards_overlap: 2 }, // R1-J1 is not named; an overlap without items names no pair
      class_width_proxy_findings_judged_by_A7: 0,
      accepted_courtyard_overlaps: [["R1", "U1"]],
      courtyard_exceptions_not_present: [["H1", "J1"]],
    });
    expect(toAcceptResults(r).find((x) => x.code === "A2")!.figures["accepted_courtyard_overlaps"]).toBe(1);
    // without the key the result keeps its old shape
    expect(Object.keys(checkAcceptance(board, reqs(), clean).results.A2_drc)).toEqual(["pass", "errors", "class_width_proxy_findings_judged_by_A7"]);
  });
  test("inner_neck_allowance_mm 0: an under-width inner segment fails A7 even within the neck of a pad", () => {
    const q = reqs();
    const vin = Object.values(q.acceptance.net_classes.classes).find((c) => c.nets?.includes("VIN"))!;
    vin.inner_track_width = 0.4;
    // a 0.2 mm inner stub from J1.1 (5,5): within the 1 mm neck allowance, so it passes until the allowance is 0
    const b = parseBoard(BOARD.replace(seg(0, 0, 10, 0, 0.1, "F.Cu", "VIN"), seg(5, 5, 5.5, 5, 0.2, "In1.Cu", "VIN")));
    expect(checkAcceptance(b, q, clean).results.A7_widths["pass"]).toBe(true);
    vin.inner_neck_allowance_mm = 0;
    expect(checkAcceptance(b, q, clean).results.A7_widths).toMatchObject({ pass: false, undersize_length_mm: { VIN: 0.5 } });
    // outer copper keeps its neck allowance
    const outer = parseBoard(BOARD.replace(seg(0, 0, 10, 0, 0.1, "F.Cu", "VIN"), seg(5, 5, 5.5, 5, 0.2, "F.Cu", "VIN")));
    expect(checkAcceptance(outer, q, clean).results.A7_widths["pass"]).toBe(true);
  });
  test("pyRound follows Python on ties and exact values", () => {
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(95.175, 2)).toBe(95.17);
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(-0.125, 2)).toBe(-0.12);
  });
});

describe("onboard + runAcceptance on a project", () => {
  let dir = "";
  afterAll(async () => dir && (await rm(dir, { recursive: true, force: true })));
  test("stores requirements, keeps history by design hash and compares with the onboarded board", async () => {
    dir = await mkdtemp(join(tmpdir(), "bw-"));
    await writeFile(join(dir, "board.kicad_pcb"), BOARD);
    await writeFile(join(dir, "board.kicad_pro"), PRO);
    const ob = await onboard(dir, { name: "t" });
    expect(ob.record.confirmed).toBe(false);
    await expect(onboard(dir)).rejects.toThrow(/already exist/);
    expect((await readRequirements(dir))!.mechanical.anchors).toHaveLength(2);
    expect((await readAcceptanceState(dir)).state).toBe("none");

    const drc = async () => ({ violations: [], unconnected: 0, parity: 0 });
    const first = await runAcceptance(dir, { drc, now: () => new Date("2026-01-01T00:00:00Z") });
    expect(first.baseline).toBeNull(); // the first run is the baseline
    expect(first.previous).toBeNull();
    expect(first.entry.results.map((r) => r.code)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]);
    expect((await readAcceptanceState(dir)).state).toBe("current");

    // an edit that disconnects a pair: A1 now fails, A8 stays; the second run names A1 as new
    const second = await runAcceptance(dir, { drc: async () => ({ violations: [], unconnected: 3, parity: 0 }), now: () => new Date("2026-01-01T00:01:00Z") });
    expect(second.baseline?.newFailures).toEqual(["A1"]);
    expect(second.baseline?.deltas.find((d) => d.code === "A1")).toMatchObject({ change: "regressed", before: { pass: true }, now: { pass: false, figure: 3 } });
    const idx = JSON.parse(await readFile(join(dir, ".fabdesk/board/accept/index.json"), "utf8"));
    expect(idx).toHaveLength(2);
    expect(idx[1]).toMatchObject({ summary: { A1: false }, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    await writeFile(join(dir, "board.kicad_pcb"), BOARD + "\n");
    const st = await readAcceptanceState(dir);
    expect(st).toMatchObject({ state: "stale", regressions: ["A1"] });
    expect(parseBoard(BOARD).routedItems).toBe(4);
  });
});

describe("design hash and project confinement", () => {
  const sheet = (file: string) => `(kicad_sch (sheet (property "Sheetname" "s") (property "Sheetfile" "${file}")))`;
  test("every referenced sheet is hashed: two folders deep and outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-"));
    const dir = join(root, "proj");
    await mkdir(join(dir, "hw", "power"), { recursive: true });
    await mkdir(join(root, "common"), { recursive: true });
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(dir, "board.kicad_sch"), sheet("hw/power/psu.kicad_sch") + sheet("../common/x.kicad_sch"));
    await writeFile(join(dir, "hw", "power", "psu.kicad_sch"), sheet("ldo.kicad_sch"));
    await writeFile(join(dir, "hw", "power", "ldo.kicad_sch"), "(kicad_sch ldo-a)");
    await writeFile(join(root, "common", "x.kicad_sch"), "(kicad_sch x-a)");
    const h0 = await designHash(dir);
    expect(Object.keys(h0.files)).toEqual(expect.arrayContaining(["hw/power/psu.kicad_sch", "hw/power/ldo.kicad_sch", "../common/x.kicad_sch"]));
    await writeFile(join(dir, "hw", "power", "ldo.kicad_sch"), "(kicad_sch ldo-b)");
    const h1 = await designHash(dir);
    expect(h1.design).not.toBe(h0.design);
    await writeFile(join(root, "common", "x.kicad_sch"), "(kicad_sch x-b)");
    expect((await designHash(dir)).design).not.toBe(h1.design);
    await rm(join(root, "common", "x.kicad_sch"));
    expect((await designHash(dir)).files["../common/x.kicad_sch"]).toBe("MISSING");
  });
  test("locateProject refuses a board outside the project, keeps absolute paths inside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-"));
    const dir = join(root, "proj");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(root, "other.kicad_pcb"), "(kicad_pcb)");
    expect((await locateProject(dir, join(dir, "board.kicad_pcb"))).stem).toBe("board");
    await expect(locateProject(dir, "../other.kicad_pcb")).rejects.toThrow(/outside the project/);
    await expect(locateProject(dir, join(root, "other.kicad_pcb"))).rejects.toThrow(/outside the project/);
    await symlink(join(root, "other.kicad_pcb"), join(dir, "link.kicad_pcb"));
    await expect(locateProject(dir, "link.kicad_pcb")).rejects.toThrow(/outside the project/);
  });
  test("automatic discovery confines both the default name and the only board", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-auto-"));
    const dir = join(root, "proj");
    await mkdir(dir);
    const outside = join(root, "other.kicad_pcb");
    await writeFile(outside, "(kicad_pcb)");
    for (const name of ["board.kicad_pcb", "panel.kicad_pcb"]) {
      const link = join(dir, name);
      await symlink(outside, link);
      await expect(locateProject(dir)).rejects.toThrow(/outside the project/);
      await rm(link);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKicadCli } from "@fabdesk/kicad";
import { parseSexpr, release, silk } from "../src";
import { FIXTURE_BOARD } from "./fixtures";

describe("text boxes (measured against KiCad's PCB_TEXT::GetBoundingBox, stable 10.0.6)", () => {
  const close = (a: number[], b: number[], tol = 2e-5) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(tol));
  test("one line: width from the glyph advances and thickness, height 1.17 h + 3.51 t", () => {
    close(silk.textBoxAt("R1", { h: 1, t: 0.1 }), [-1.02619, -0.7605, 1.026191, 0.7605]);
    close(silk.textBoxAt("C18_C4", { h: 1, t: 0.1 }), [-2.859524, -0.7605, 2.859524, 0.7605]);
    close(silk.textBoxAt("WWWW", { h: 1, t: 0.1 }), [-2.335714, -0.7605, 2.335714, 0.7605]);
    close(silk.textBoxAt("1.2V", { h: 1, t: 0.1 }), [-1.669047, -0.7605, 1.669048, 0.7605]);
  });
  test("size and thickness scale it; justification and mirroring move it about the anchor", () => {
    close(silk.textBoxAt("R12", { h: 0.8, t: 0.2 }), [-1.381905, -0.819, 1.381905, 0.819]);
    close(silk.textBoxAt("R12", { h: 1, t: 0.15, hjust: "left", vjust: "bottom" }), [0, -1.45, 3.154762, 0.2465]);
    close(silk.textBoxAt("R12", { h: 1, t: 0.15, hjust: "right", vjust: "top" }), [-3.154762, -0.2465, 0, 1.45]);
    close(silk.textBoxAt("R12", { h: 1, t: 0.15, hjust: "left", mirror: true }), [-3.154762, -0.84825, 0, 0.84825]);
    close(silk.textBoxAt("R12", { h: 1, t: 0.15, angle: 90 }), [-0.84825, -1.577381, 0.84825, 1.577381]);
  });
  test("no thickness stated means an eighth of the size; the pen never exceeds a quarter of it", () => {
    expect(silk.effectivePen(1.27, 0)).toBeCloseTo(0.15875, 6);
    expect(silk.effectivePen(0.001, 0.15)).toBeCloseTo(0.00025, 8);
  });
  test("footprint field text stays upright: 180 turns to 0 (the box falls on the other side of the anchor); 270 turns to 90", () => {
    expect(silk.uprightStyle({ h: 1, t: 0.1, angle: 180 }).angle).toBe(0);
    expect(silk.uprightStyle({ h: 1, t: 0.1, angle: 270 }).angle).toBe(90);
    expect(silk.uprightStyle({ h: 1, t: 0.1, angle: 90 }).angle).toBe(90);
    expect(silk.uprightStyle({ h: 1, t: 0.1, angle: 0 }).angle).toBe(0);
  });
});

describe("geometry", () => {
  const sq: silk.Poly = [[0, 0], [2, 0], [2, 2], [0, 2]];
  test("rect against polygon: inside, edge crossing, apart", () => {
    expect(silk.rectPolyHit([0.5, 0.5, 1, 1], sq, [0, 0, 2, 2])).toBe(true);
    expect(silk.rectPolyHit([1.5, -1, 1.7, 3], sq, [0, 0, 2, 2])).toBe(true);
    expect(silk.rectPolyHit([3, 3, 4, 4], sq, [0, 0, 2, 2])).toBe(false);
    expect(silk.rectDist([3, 0, 4, 1], [0, 0, 2, 2])).toBe(1);
  });
  test("the grid returns each nearby obstacle once and forgets removed ones", () => {
    const g = new silk.Grid<"a">(1);
    const i = g.add("a", "x", sq);
    g.add("a", "y", [[10, 10], [11, 10], [11, 11]]);
    expect([...g.near([0, 0, 3, 3])].map(([, it]) => it!.owner)).toEqual(["x"]);
    g.remove(i);
    expect([...g.near([0, 0, 3, 3])].map(([, it]) => it?.owner)).toEqual([]);
  });
});

const roundTrip = (t: string) => silk.readSilkParts(parseSexpr(t));

describe("board file reading", () => {
  const r = roundTrip(FIXTURE_BOARD);
  test("parts, sides, courtyards, bodies and labels", () => {
    expect(Object.keys(r.parts)).toEqual(["R1", "R2", "R3"]);
    expect(r.parts["R3"]!.side).toBe("B");
    const r1 = r.parts["R1"]!;
    expect(r1.cbox).toEqual([8.52, 9.27, 11.48, 10.73]);
    expect(r1.netted).toBe(true);
    expect(r1.npads).toBe(2);
    expect(r1.label).toMatchObject({ visible: true, on_silk: true, height: 1, stroke: 0.15, angle: 0 });
    // the label hangs 1.43 above the part origin: centre (10, 8.57)
    expect((r1.label.box[0] + r1.label.box[2]) / 2).toBeCloseTo(10, 6);
    expect((r1.label.box[1] + r1.label.box[3]) / 2).toBeCloseTo(8.57, 6);
    // a part turned 90 has its courtyard turned
    expect(r.parts["R2"]!.cbox[2] - r.parts["R2"]!.cbox[0]).toBeCloseTo(1.46, 6);
  });
  test("free silk texts and the outline", () => {
    expect(r.texts.map((t) => t.text)).toEqual(["HELLO"]);
    expect(r.outline).toHaveLength(1);
    expect(silk.polyArea(r.outline[0]!)).toBeCloseTo(600, 6);
  });
  test("a hidden Reference, an unlocked turned label and a missing thickness read as KiCad reads them", () => {
    const t = FIXTURE_BOARD.replace('(property "Reference" "R1" (at 0 -1.43 0) (layer "F.SilkS")', '(property "Reference" "R1" (at 0 -1.43 0) (layer "F.SilkS") (hide yes)').replace('(property "Reference" "R2" (at 0 -1.43 90)', '(property "Reference" "R2" (at 3 0 180) (unlocked yes)').replace('(uuid "10000000-0000-4000-8000-00000000002' + "14" + '") (effects (font (size 1 1) (thickness 0.15)))', "XX");
    const q = roundTrip(t);
    expect(q.parts["R1"]!.label.visible).toBe(false);
    expect(q.parts["R2"]!.label.angle).toBe(180);
  });
});

describe("rewriting only labels", () => {
  test("the written board differs from the source only in Reference properties and moved texts, and reads back where it was put", () => {
    const frames = { R1: { at: [0, 2.5, 0] as [number, number, number], layer: "F.SilkS", height: 0.8, mirror: false, want: [0, 0, 0, 0] as [number, number, number, number] } };
    const w = silk.writeBoard(FIXTURE_BOARD, frames, ["R2"], silk.planOf());
    expect(w.edits).toBe(2);
    expect(silk.masked(w.text)).toBe(silk.masked(FIXTURE_BOARD));
    expect(w.text).not.toBe(FIXTURE_BOARD);
    const q = roundTrip(w.text);
    expect(q.parts["R1"]!.label.height).toBe(0.8);
    expect((q.parts["R1"]!.label.box[1] + q.parts["R1"]!.label.box[3]) / 2).toBeCloseTo(12.5, 6);
    expect(q.parts["R2"]!.label.visible).toBe(false);
  });
  test("the field position is stored relative to the footprint (inverse of its transform), B side included", () => {
    const m = { parts: roundTrip(FIXTURE_BOARD).parts, extra: {} } as unknown as silk.SilkModel;
    const placed = { R2: [0, [13.5, 8.8, 14.5, 9.2], 0, 1] as silk.Placed };
    const f = silk.localFrames(m, placed, silk.planOf()).R2 as { at: number[] };
    // R2 at (14, 10) turned 90: board point (14, 9) is local (x, y) with x c + y s = 0, -x s + y c = -1 -> (1, 0)
    expect(f.at[0]).toBeCloseTo(1, 6);
    expect(f.at[1]).toBeCloseTo(0, 6);
  });
  test("a moving free text keeps everything but its anchor, size and justification", () => {
    const blk = '(gr_text "HELLO" (at 15 16 0) (layer "F.SilkS") (uuid "u") (effects (font (size 1 1) (thickness 0.15)) (justify left mirror)))';
    const out = silk.rewriteText(blk, [20, 5, 90], 0.8, 0.16);
    expect(out).toBe('(gr_text "HELLO" (at 20 5 90) (layer "F.SilkS") (uuid "u") (effects (font (size 0.8 0.8) (thickness 0.16)) (justify mirror)))');
  });
});

/** Judge and solve on a hand-built model: two parts side by side, one pad's exposed copper in the way. */
function model(): silk.SilkModel {
  const rect = (x0: number, y0: number, x1: number, y1: number): silk.Poly => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const part = (x: number, label: Partial<silk.Label> = {}): silk.Part => ({
    side: "F", x, y: 10, rot: 0, courtyard: [rect(x - 1.5, 9.3, x + 1.5, 10.7)], cbox: [x - 1.5, 9.3, x + 1.5, 10.7], body: [x - 1.25, 9.55, x + 1.25, 10.45], netted: true, npads: 2,
    attrs: { board_only: false, dnp: false, no_bom: false },
    label: { visible: false, layer: "F.SilkS", on_silk: true, height: 1, stroke: 0.15, angle: 0, box: [x - 1, 7.5, x + 1, 8.5], ...label },
  });
  return {
    parts: { R1: part(10), R2: part(14) },
    copper: { F: [["R1", rect(8.8, 9.5, 9.5, 10.5)], ["R2", rect(15, 9.5, 15.7, 10.5)]], B: [] },
    silk: { F: [], B: [] },
    outline: [rect(0, 0, 30, 20)],
    holes_outline: [],
    texts: [],
    extra: {},
    textBox: (s, h, w) => { const z = silk.textSize(s, h, w); return [z.w, z.h]; },
    source: { mask_silk: "kicad-gerber", labels: "board-file", text_extent: "measured-table" },
  };
}

describe("check and solver", () => {
  test("unlabelled parts, a label under a part body, over copper, too small, near the edge and far away are each named", () => {
    const m = model();
    expect(silk.judge(m, silk.planOf()).counts).toEqual({ unlabelled: 2 });
    m.parts["R1"]!.label = { ...m.parts["R1"]!.label, visible: true, box: [9, 9.7, 11, 10.3] }; // inside the body
    m.parts["R2"]!.label = { ...m.parts["R2"]!.label, visible: true, height: 0.6, box: [15.1, 9.6, 15.6, 10.4] }; // small, over copper
    const v = silk.judge(m, silk.planOf());
    const kinds = (ref: string) => v.rows.find((r) => r.ref === ref)!.issues.map((i) => i.kind);
    expect(kinds("R1")).toContain("under-part");
    expect(kinds("R2")).toEqual(expect.arrayContaining(["over-copper", "small"]));
    expect(v.bad).toBe(2);
    m.parts["R1"]!.label.box = [9, 2, 11, 3]; // 6.3 mm from its courtyard
    expect(silk.judge(m, silk.planOf()).rows.find((r) => r.ref === "R1")!.issues.map((i) => i.kind)).toContain("far");
  });
  test("a label whose box touches the edge is flagged; the plan's clearances change the verdict", () => {
    const m = model();
    m.parts["R1"]!.label = { ...m.parts["R1"]!.label, visible: true, box: [9, 0.05, 11, 1.05] };
    expect(silk.judge(m, silk.planOf()).rows.find((r) => r.ref === "R1")!.issues.map((i) => i.kind)).toContain("edge");
  });
  test("the solver places every label clear of copper, bodies, edges and each other, and says what blocks one that fits nowhere", () => {
    const m = model();
    const plan = silk.planOf();
    const { placed, why } = silk.solve(m, plan);
    expect(Object.keys(placed).sort()).toEqual(["R1", "R2"]);
    expect(why).toEqual({});
    const [a, b] = [placed["R1"]![1], placed["R2"]![1]];
    expect(silk.overlap(silk.grow(a, plan.clear.label!), b)).toBe(false);
    for (const [ref, [, rect]] of Object.entries(placed)) {
      const w = new silk.World(m, plan);
      expect(w.hits("F", rect, ref).filter(([k]) => k !== "courtyard")).toEqual([]);
      expect(silk.rectDist(rect, m.parts[ref]!.cbox)).toBeLessThanOrEqual(plan.max_gap + 1e-9);
    }
    // nothing fits within max_gap of a part boxed in by copper and the edge
    const tight = model();
    tight.outline = [[[9, 9], [11, 9], [11, 11], [9, 11]]];
    const r = silk.solve(tight, plan);
    expect(Object.keys(r.why).length).toBeGreaterThan(0);
    expect(Object.values(r.why)[0]!.blocked_by_of_60_best["edge"]).toBeGreaterThan(0);
  });
  test("fix mode keeps labels that pass; a pinned label goes where it is told; a plan can skip, hide and keep", () => {
    const m = model();
    const plan = silk.planOf({ mode: "fix", pin: { R2: { at: [14, 6], angle: 0, height: 1 } } });
    m.parts["R1"]!.label = { ...m.parts["R1"]!.label, visible: true, box: [9, 7.2, 11, 8.3] };
    const before = silk.judge(m, plan);
    const fixed = silk.cleanLabels(m, plan, before);
    expect(Object.keys(fixed)).toEqual(["R1"]);
    const { placed } = silk.solve(m, plan, fixed);
    const r2 = placed["R2"]![1];
    expect([(r2[0] + r2[2]) / 2, (r2[1] + r2[3]) / 2]).toEqual([14, 6]);
    expect(silk.wanted("R1", m.parts["R1"]!, silk.planOf({ skip: ["R*"] }))).toBe(false);
    expect(silk.wanted("R2", m.parts["R2"]!, silk.planOf({ labels: "visible" }))).toBe(false);
    expect(silk.wanted("R1", m.parts["R1"]!, silk.planOf({ labels: "visible", keep: ["R1"] }))).toBe(true);
  });
  test("a free text that names a part moves with that part's label (texts: move)", () => {
    const m = model();
    m.texts = [{ owner: "text:u", uuid: "u", text: "R1 TEST", side: "F", height: 1, stroke: 0.15, angle: 0, box: [20, 15, 24, 16] }];
    expect(silk.judge(m, silk.planOf()).text_rows[0]!.issues.map((i) => i.kind)).toContain("detached");
    const { placed } = silk.solve(m, silk.planOf({ texts: "move" }));
    expect(placed["text:u"]).toBeDefined();
    expect(placed["R1"]).toBeUndefined(); // the text is R1's label
  });
});

const cli = await findKicadCli();
describe.skipIf(!cli)("with kicad-cli", () => {
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), "silk-"));
    await writeFile(join(dir, "fx.kicad_pcb"), FIXTURE_BOARD);
    return dir;
  }
  test("the model reads pad mask openings and silk strokes from KiCad's plot, owned by their footprint", async () => {
    const dir = await project();
    const m = await silk.buildSilkModel(FIXTURE_BOARD, { cli: cli!, workDir: join(dir, "w") });
    const owners = (l: Array<[string, silk.Poly]>) => new Set(l.map((x) => x[0]));
    expect([...owners(m.copper.F)].sort()).toEqual(["R1", "R2"]); // R3's openings are on the back
    expect([...owners(m.copper.B)]).toEqual(["R3"]);
    expect(owners(m.silk.F).has("R1")).toBe(true);
    expect(owners(m.silk.F).has("text:a0000000-0000-4000-8000-000000000001")).toBe(true);
    // R1's first pad opening: pad 0.8 x 0.95 at (9.175, 10) plus the 0.05 mask margin
    const pads = m.copper.F.filter(([o]) => o === "R1").flatMap(([, p]) => p);
    expect(Math.min(...pads.map((p) => p[0]))).toBeCloseTo(9.175 - 0.4 - 0.05, 2);
  });
  test("place: only Reference properties change, the result judges clean, and the picture has the board's size", async () => {
    const dir = await project();
    const out = join(dir, "cand");
    const r = await silk.silkPlace({ pcb: join(dir, "fx.kicad_pcb"), out, cli: cli!, pictures: true });
    expect(r.only_labels_changed).toBe(true);
    expect(r.after.bad).toBe(0);
    expect(r.written_vs_solver_mm).toBeLessThan(1e-3);
    expect(r.fit_nowhere).toEqual([]);
    expect((await stat(join(out, "silk-pictures", "after-F.png"))).size).toBeGreaterThan(1000);
    expect(await readdir(out)).toContain("fx.kicad_pcb");
  });
  test("gerbcheck passes the board's own Gerbers and fails a Gerber whose flash moved", async () => {
    const dir = await project();
    const g = join(dir, "g");
    await release.exportCam(cli!, join(dir, "fx.kicad_pcb"), g, release.requiredLayers(FIXTURE_BOARD));
    const ok = await release.gerbCheck({ gerbers: g, pcb: join(dir, "fx.kicad_pcb"), out: join(dir, "c1"), cli: cli!, dpi: 400 });
    expect(Object.keys(ok.layers).sort()).toEqual(["B_Cu", "B_Mask", "B_Paste", "B_Silkscreen", "F_Cu", "F_Mask", "F_Paste", "F_Silkscreen"]);
    expect(ok.pass).toBe(true);
    expect(Object.values(ok.drill).map((d) => d.holes_or_slots)).toEqual([0, 0]); // the fixture has no holes
    const name = (await readdir(g)).find((n) => n.includes("-F_Cu."))!;
    const text = await readFile(join(g, name), "latin1");
    // move every flash of pad R1.1 by 0.3 mm in x
    const bent = text.replace(/(%TO\.P,R1,1[^\n]*\n(?:[^\n]*\n)*?)X(\d+)(Y-?\d+D03\*)/, (_m, a: string, x: string, b: string) => `${a}X${Number(x) + 300000}${b}`);
    expect(bent).not.toBe(text);
    await cp(g, join(dir, "g2"), { recursive: true });
    await writeFile(join(dir, "g2", name), bent, "latin1");
    const bad = await release.gerbCheck({ gerbers: join(dir, "g2"), pcb: join(dir, "fx.kicad_pcb"), out: join(dir, "c2"), cli: cli!, dpi: 400 });
    expect(bad.layers["F_Cu"]!.pass).toBe(false);
    expect(bad.pass).toBe(false);
  }, 60_000); // kicad-cli exports and renders: past 5 s on a loaded machine
  test("fab: with every gate passing, writes a package whose CAM is reproducible and whose Gerbers check out", async () => {
    const dir = await project();
    const out = join(dir, "pkg");
    const pcb = join(dir, "fx.kicad_pcb");
    await writeFile(pcb, FIXTURE_BOARD.replaceAll('(footprint "R_0603_1608Metric"', '(footprint "R_0603_1608Metric" (property "LCSC" "C12345" (at 0 0) (layer "F.Fab") (effects (font (size 1 1))))'));
    const bomDir = join(dir, "bom");
    // Deterministic supplier evidence for the fixture's actual 0603 copper, never a network lookup.
    await release.bomCheck({ project: dir, stem: "fx", out: bomDir, fetch: { shared: null, paceMs: 0, transport: async (url) => {
      if (url.includes("productCode=")) return { result: { productModel: "0603-10k", encapStandard: "0603", productCycle: "normal", smtLabel: "BASE", stockNumber: 90000 } };
      if (url.includes("jlcpcb")) return { data: { componentPageInfo: { list: [{ componentCode: "C12345", stockCount: 80000, componentLibraryType: "base" }] } } };
      return { result: { packageDetail: { title: "R0603", dataStr: { head: { x: 0, y: 0 }, shape: ["PAD~RECT~-3.2480315~0~3.1496063~3.7401575~1~~1~0", "PAD~RECT~3.2480315~0~3.1496063~3.7401575~1~~2~0"] } }, dataStr: { shape: [] } } };
    } } });
    const allPass = Object.fromEntries(["A1_connectivity", "A2_drc", "A3_parity", "A4_circuit", "A5_anchors", "A6_stack", "A7_widths", "A8_pairs", "A9_heights"].map((k) => [k, true]));
    const r = await release.releaseFab({
      project: dir, stem: "fx", pcb, schematic: null, out, cli: cli!, step: false, bomDir, bomBoardSha: release.sha256(await readFile(pcb)),
      gates: { review: async () => ({ state: "pass" }), acceptance: async () => ({ summary: allPass }) },
    });
    const man = r.manifest as { reproducible: { pass: boolean; files: number }; gerbcheck: { pass: boolean }; release_gate: string; jlc: { placements: number; no_lcsc_code: string[] }; files: Record<string, string> };
    expect(man.release_gate).toContain("interconnect: none");
    expect(man.reproducible.pass).toBe(true);
    expect(man.gerbcheck.pass).toBe(true);
    expect(man.jlc.placements).toBe(3);
    expect(man.jlc.no_lcsc_code).toEqual([]);
    expect(Object.keys(man.files)).toEqual(expect.arrayContaining(["fx-gerbers.zip", "via-process-bindings.json", "acceptance-gate.json", "fx-pos.csv"]));
    expect(Object.keys(man.files).some((f) => f.startsWith("repro"))).toBe(false);
    expect((await readdir(join(out, "gerbers"))).some((n) => n.includes("F_Cu"))).toBe(true);
  }, 120_000);
});

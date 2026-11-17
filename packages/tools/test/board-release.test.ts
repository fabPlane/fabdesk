import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, setInterconnectGate, type CoreServices, type ProjectHandle } from "../src";
import { recordAcceptance, recordReviewGate } from "../src/board-state";
import { bomDirOf, readBomState } from "../src/release-state";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const BOARD = (extra = "") => `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "R_0402" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 0 0) (layer "F.Fab"))
    (property "LCSC" "C25744" (at 0 0 0) (layer "F.Fab"))
    (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A"))
    (pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "B")))
  ${extra}
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05)) (layer "Edge.Cuts")))`;

const record = (rec: unknown) => ({ url: "u", post: null, fetched: "2026-11-12T00:00:00Z", body: rec });
const EDA = { result: { packageDetail: { title: "R0402", dataStr: { head: { x: 0, y: 0 }, shape: ["PAD~RECT~-2~0~2~2.4~1~~1~0", "PAD~RECT~2~0~2~2.4~1~~2~0"] } }, dataStr: { shape: [] } } };
const LCSC = { result: { productModel: "0402WGF1002TCE", brandNameEn: "UNI-ROYAL", encapStandard: "0402", productCycle: "normal", smtLabel: "BASE", stockNumber: 90000, productDescEn: "10k 1%" } };
const JLC = { data: { componentPageInfo: { list: [{ componentCode: "C25744", stockCount: 80000, componentLibraryType: "base" }] } } };

async function seedCache(project: ProjectHandle) {
  const cache = join(bomDirOf(project.dir), "cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "lcsc-C25744.json"), JSON.stringify(record(LCSC)));
  await writeFile(join(cache, "jlc-C25744.json"), JSON.stringify(record(JLC)));
  await writeFile(join(cache, "eda-C25744.json"), JSON.stringify(record(EDA)));
}

async function setup(boardText = BOARD(), overrides: Partial<CoreServices> = {}) {
  const project = await tempProject("rel");
  await writeFile(join(project.dir, "board.kicad_pcb"), boardText);
  const services = mockServices([project], overrides);
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await registry.invoke(name, args, (ref) => factory({ def: registry.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }))) as { text?: string; json?: any; isError?: boolean };
  return { project, services, registry, call };
}

afterEach(() => setInterconnectGate(null));

describe("cam (the CAM set without the release gates)", () => {
  test("refuses a non-empty out folder and one outside the project", async () => {
    const { project, call } = await setup();
    await mkdir(join(project.dir, "fab"), { recursive: true });
    await writeFile(join(project.dir, "fab", "old.gbr"), "x");
    await expect(call("board_release", { action: "cam" })).rejects.toThrow(/fab exists and is not empty/);
    await expect(call("board_release", { action: "cam", out: "../elsewhere" })).rejects.toThrow(/escapes the project/);
  });
});

describe("registration", () => {
  test("board_release and board_silk are in the board toolset with underscore names and an action", () => {
    const reg = createRegistry();
    for (const n of ["board_release", "board_silk"]) {
      const def = reg.get(n)!;
      expect(def.toolset).toBe("board");
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(Object.keys(def.inputSchema)).toContain("action");
    }
    expect(reg.byToolset("board").map((t) => t.name)).toEqual(expect.arrayContaining(["board_job", "board_check", "board_release", "board_silk"]));
  });
});

describe("board_release", () => {
  test("bom (offline, from the evidence cache) names the lines, the JLC rotation and keeps the check tied to the board", async () => {
    const { project, call } = await setup();
    await seedCache(project);
    const r = await call("board_release", { action: "bom", offline: true });
    expect(r.text).toContain("BOM check: 1 lines / 1 placements: RESOLVED 1");
    expect(r.json.summary).toEqual({ RESOLVED: 1 });
    expect((await readBomState(project.dir, join(project.dir, "board.kicad_pcb"))).state).toBe("current");
    const cpl = await readFile(join(bomDirOf(project.dir), "cpl-jlc.csv"), "utf8");
    expect(cpl).toContain("R1,C25744,F,90,0,90");
    // a changed board makes it stale
    await writeFile(join(project.dir, "board.kicad_pcb"), BOARD() + " ");
    expect((await readBomState(project.dir, join(project.dir, "board.kicad_pcb"))).state).toBe("stale");
    const c = await call("board_release", { action: "check" });
    expect(c.text).toContain("BOM check is of an earlier board");
  });

  test("check: where each gate stands; ready only when review settled, A1-A9 pass and no via lacks fill and cap", async () => {
    const { project, call } = await setup(BOARD(`(via micro (at 26 16) (size 0.3) (drill 0.1) (layers "F.Cu" "In1.Cu") (net "A") (uuid "v"))`));
    let r = await call("board_release", { action: "check" });
    expect(r.json.ready).toBe(false);
    expect(r.text).toContain("2 review gate: not run");
    expect(r.text).toContain("3 acceptance: not measured");
    expect(r.text).toContain("1 need fill+cap, 1 missing natively");
    const sha = (await import("node:crypto")).createHash("sha256").update(await readFile(join(project.dir, "board.kicad_pcb"))).digest("hex");
    await recordReviewGate(project.dir, { current: true, open: 0, mustFix: 0 });
    await recordAcceptance(project.dir, { at: new Date().toISOString(), sha256: sha, results: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"].map((code) => ({ code, status: "pass", figures: {}, evidence: [] })) as never });
    r = await call("board_release", { action: "check" });
    expect(r.text).toContain("2 review gate: passes");
    expect(r.text).toContain("3 acceptance: A1-A9 pass");
    expect(r.json.ready).toBe(false); // the microvia is still unfilled
    await writeFile(join(project.dir, "board.kicad_pcb"), BOARD());
    const sha2 = (await import("node:crypto")).createHash("sha256").update(await readFile(join(project.dir, "board.kicad_pcb"))).digest("hex");
    await recordReviewGate(project.dir, { current: true, open: 0, mustFix: 0 });
    await recordAcceptance(project.dir, { at: new Date().toISOString(), sha256: sha2, results: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"].map((code) => ({ code, status: "pass", figures: {}, evidence: [] })) as never });
    r = await call("board_release", { action: "check" });
    expect(r.json.ready).toBe(false); // a current BOM is still required
    await seedCache(project);
    await call("board_release", { action: "bom", offline: true });
    r = await call("board_release", { action: "check" });
    expect(r.json.ready).toBe(true);
    const decisionsPath = join(bomDirOf(project.dir), "bom-decisions.json");
    const decisions = JSON.parse(await readFile(decisionsPath, "utf8"));
    decisions.records[0].status = "UNRESOLVED";
    await writeFile(decisionsPath, JSON.stringify(decisions));
    expect((await call("board_release", { action: "check" })).json.ready).toBe(false);
  });

  test("vias lists the vias that need fill+cap; apply writes the attributes through adopt and checks again", async () => {
    // a through via in R1's pad 2 (board 10,9.5 at rot 90) and one in the open
    const vias = `(via (at 10 9.5) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "A") (uuid "v1"))
  (via (at 20 15) (size 0.4) (drill 0.2) (layers "F.Cu" "B.Cu") (net "B") (uuid "v2"))`;
    const adopted: string[] = [];
    const { project, call } = await setup(BOARD(vias), {
      boardAdopt: {
        adopt: async (i: { target: string; candidate: string }) => {
          adopted.push(i.candidate);
          await writeFile(i.target, await readFile(i.candidate, "utf8"));
          return { delta: { removed: {}, added: {}, changed: { KOT_PCB_VIA: 1 } }, residual: { removed: {}, added: {}, changed: {} }, targetSha256Before: "a", targetSha256After: "b", timingsMs: {}, kicadCli: "kicad-cli" };
        },
      },
    });
    let r = await call("board_release", { action: "vias" });
    expect(r.text).toContain("1 in pads; 1 need fill+cap, 1 lack it");
    expect(r.text).toContain("through via A @ 10,9.5 drill 0.2 in R1.2");
    expect(r.json.missing).toHaveLength(1);
    expect(adopted).toHaveLength(0); // listing writes nothing
    await expect(call("board_release", { action: "vias", apply: true })).rejects.toThrow("filled/capped fabrication attributes");
    await mkdir(join(project.dir, ".fabdesk/board/requirements"), { recursive: true });
    await writeFile(join(project.dir, ".fabdesk/board/requirements/acceptance.json"), JSON.stringify({ manufacturing_rules: { filled_capped_vias: { allow: true, basis: "specified Type VII supplier process" } } }));
    r = await call("board_release", { action: "vias", apply: true });
    expect(adopted).toHaveLength(1);
    expect(r.json.applied).toBe(1);
    expect(r.json.stillMissing).toBe(0);
    expect(r.text).toContain("every via that needs fill+cap has it");
    const board = await readFile(join(project.dir, "board.kicad_pcb"), "utf8");
    expect(board.match(/\(filling yes\)/g)).toHaveLength(1);
    expect(board).toMatch(/\(uuid "v1"\)/);
    r = await call("board_release", { action: "vias" });
    expect(r.text).toContain("Every via that needs fill+cap has it");
  });

  test("fab refuses in order, names the gate, and writes no package; a host's interconnect gate runs first", async () => {
    const { project, call } = await setup();
    const out = "exports/pkg";
    let r = await call("board_release", { action: "fab", out });
    expect(r.json).toMatchObject({ released: false, gate: "review" });
    expect(r.text).toContain("NOT RELEASED (review)");
    expect(await stat(join(project.dir, out)).catch(() => null)).toBeNull();
    setInterconnectGate(async () => ({ pass: false, text: "J1 interface not PASS" }));
    r = await call("board_release", { action: "fab", out });
    expect(r.json).toMatchObject({ released: false, gate: "interconnect" });
    expect(r.text).toContain("J1 interface not PASS");
    expect(await stat(join(project.dir, out)).catch(() => null)).toBeNull();
    // out must stay inside the project
    await expect(call("board_release", { action: "fab", out: "../elsewhere" })).rejects.toThrow(/escapes the project/);
  });

  test("fab: a bad exception is NOT RELEASED, not a tool error; a refused release saves no proxies; a review of another board does not pass", async () => {
    const { project, call } = await setup();
    let r = await call("board_release", { action: "fab", accept: ["A8_pairs=../decisions.json#x"], proxies: { C1: { proxy: "C2" } } });
    expect(r.isError).toBeFalsy();
    expect(r.json).toMatchObject({ released: false, gate: "acceptance" });
    expect(await stat(join(project.dir, ".fabdesk", "board", "release", "jlc-footprint-proxies.json")).catch(() => null)).toBeNull();
    // a saved pass is not what fab trusts: it computes the review gate from the review records
    await recordReviewGate(project.dir, { current: true, open: 0, mustFix: 0 });
    r = await call("board_release", { action: "fab" });
    expect(r.json).toMatchObject({ released: false, gate: "review" });
  });

  test("proxies are saved with the project and used by the package check", async () => {
    const { project, call } = await setup();
    await call("board_release", { action: "check", proxies: { C1: { proxy: "C2", why: "same 0402 package" } } });
    const saved = JSON.parse(await readFile(join(project.dir, ".fabdesk", "board", "release", "jlc-footprint-proxies.json"), "utf8"));
    expect(saved).toEqual({ C1: { proxy: "C2", why: "same 0402 package" } });
  });
});

describe("export_pos emits the JLC-simulated CPL for a placed board", () => {
  const gerber = `%FSLAX46Y46*%
%MOMM*%
%ADD10R,0.500000X0.600000*%
%LPD*%
G01*
%TO.P,R1,1*%
D10*
X10000000Y-10600000D03*
%TO.P,R1,2*%
X10000000Y-9600000D03*
%TD*%
M02*
`;
  test("pad-centre position from our copper, the rotation JLC's footprint needs, and a placement check", async () => {
    const base = mockServices([]);
    const { project, call } = await setup(BOARD(), {
      kicad: {
        ...base.kicad,
        exportPos: async (_cli, o) => {
          await writeFile(o.output, 'Ref,Val,Package,PosX,PosY,Rot,Side\n"R1","10k","R_0402",10.000000,-10.000000,90.000000,top\n');
          return { paths: [o.output] };
        },
        exportGerbers: async (_cli, o) => {
          await mkdir(o.outDir, { recursive: true });
          await writeFile(join(o.outDir, "board-F_Cu.gbr"), gerber);
          return { paths: [] };
        },
      },
    });
    await seedCache(project);
    await call("board_release", { action: "bom", offline: true });
    const r = await call("export_pos");
    expect(r.text).toContain("JLC placement exports/positions-jlc.csv");
    expect(r.text).toContain("source current BOM check");
    const cpl = await readFile(join(project.dir, "exports", "positions-jlc.csv"), "utf8");
    // pads at (10,-10.6) and (10,-9.6): the pad box centre is (10,-10.1), not the footprint origin (10,-10)
    expect(cpl.trim().split(/\r?\n/)).toEqual(["Designator,Mid X,Mid Y,Layer,Rotation", "R1,10.000000,-10.100000,Top,90"]);
    expect(r.json.jlc).toMatchObject({ placements: 1, pass: 1, fail: 0, source: "current BOM check" });
    expect(await readFile(join(project.dir, "exports", "bom-jlc.csv"), "utf8")).toContain("R1,0402,C25744");
  });

  test("without a current BOM check it uses the evidence cache and says so; a blank board gets no JLC file", async () => {
    const base = mockServices([]);
    const mk = (board: string) => setup(board, { kicad: { ...base.kicad, exportPos: async (_c, o) => (await writeFile(o.output, "Ref,Val,Package,PosX,PosY,Rot,Side\n"), { paths: [o.output] }), exportGerbers: async () => ({ paths: [] }) } });
    const a = await mk(BOARD());
    const r = await a.call("export_pos");
    expect(r.text).toContain("evidence cache (no current BOM check)");
    const b = await mk("(kicad_pcb (version 20241229))");
    const r2 = await b.call("export_pos");
    expect(r2.text).toContain("Exported exports/positions.csv (physical_purchase)");
  });
});

test("fabrication gate preserves legacy exports and records explicit waivers", async () => {
  const { fabricationGate, packageWaivers } = await import("../src/fabrication-gate");
  const dir = await mkdtemp(join(tmpdir(), "fabrication-waiver-"));
  await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
  expect(await fabricationGate(dir, "export_gerbers")).toBeNull();
  await mkdir(join(dir, ".fabdesk/board"), { recursive: true });
  await writeFile(join(dir, ".fabdesk/board/onboard.json"), "{}");
  for (const tool of ["export_gerbers", "board_release cam"]) {
    await expect(fabricationGate(dir, tool)).rejects.toThrow("Review stage none");
    const w = await fabricationGate(dir, tool, "Owner authorized a prototype without review");
    expect(w?.tool).toBe(tool);
    expect(w?.designHash).toMatch(/^[a-f0-9]{64}$/);
  }
  const out = join(dir, "exports/package");
  await mkdir(out, { recursive: true });
  await packageWaivers(dir, out);
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  expect(manifest.reviewWaivers).toHaveLength(2);
});

test("actual Gerber and CAM entry points refuse an onboarded design with no review", async () => {
  const { project, call } = await setup();
  await mkdir(join(project.dir, ".fabdesk/board"), { recursive: true });
  await writeFile(join(project.dir, ".fabdesk/board/onboard.json"), "{}");
  await expect(call("export_gerbers")).rejects.toThrow("fabrication refused");
  await expect(call("board_release", { action: "cam" })).rejects.toThrow("fabrication refused");
});

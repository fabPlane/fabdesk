import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, ToolError, type BoardAdoptResult, type CoreServices } from "../src";
import { edit } from "@fabdesk/board-workflow";
import { adoptCandidate, designFileHashes } from "../src/board-adopt";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const empty = { removed: {}, added: {}, changed: {} };
const result = (over: Partial<BoardAdoptResult> = {}): BoardAdoptResult => ({
  delta: { removed: { KOT_PCB_TRACE: 10 }, added: { KOT_PCB_TRACE: 14 }, changed: { KOT_PCB_FOOTPRINT: 1 } },
  residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: { commit: 89 }, kicadCli: "kicad-cli", ...over,
});

async function setup(adopt?: (i: { target: string; candidate: string }) => Promise<BoardAdoptResult>, recovery?: <T>(dir: string, replace: () => Promise<T>) => Promise<T>) {
  const project = await tempProject("adopt");
  const seen: Array<{ target: string; candidate: string }> = [];
  const base = mockServices([project]);
  const services: CoreServices = {
    ...base,
    ...(recovery ? { design: { ...base.design, withSavedFilesRecovery: recovery } } : {}),
    boardAdopt: { adopt: async (i) => (seen.push(i), adopt ? adopt(i) : result()) },
  };
  const def = createRegistry().get("board_job")!;
  const ctx = () => contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
  return { project, seen, ctx, services };
}
const sha = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

describe("adoptCandidate", () => {
  test("retains a checkpoint, applies the PCB delta once and reports it", async () => {
    const { project, seen, ctx } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    const candidate = join(await mkdtemp(join(tmpdir(), "cand-")), "c.kicad_pcb");
    await writeFile(candidate, "(kicad_pcb)");
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "test" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe(join(project.dir, "board.kicad_pcb"));
    expect(r.text).toContain("removed trace 10; added trace 14; changed footprint 1");
    expect(r.text).toContain("residual none");
    expect(r.clean).toBe(true);
    expect(r.data.checkpointId).toMatch(/^task-/);
  });

  test("applies onto the board it is given, never board.kicad_pcb by default", async () => {
    const { project, seen, ctx } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb main)");
    await writeFile(join(project.dir, "panel.kicad_pcb"), "(kicad_pcb panel)");
    const candidate = join(await mkdtemp(join(tmpdir(), "cand-")), "panel.kicad_pcb");
    await writeFile(candidate, "(kicad_pcb panel edited)");
    await adoptCandidate(await ctx(), { candidate, board: "panel.kicad_pcb", reason: "panel" });
    expect(seen.map((s) => s.target)).toEqual([join(project.dir, "panel.kicad_pcb")]);
    await expect(adoptCandidate(await ctx(), { candidate, board: "missing.kicad_pcb", reason: "x" })).rejects.toThrow(/target board not found in the project: missing.kicad_pcb/);
    await expect(adoptCandidate(await ctx(), { candidate, board: "../elsewhere.kicad_pcb", reason: "x" })).rejects.toThrow(/escapes the project/);
    expect(seen).toHaveLength(1);
  });

  test("refuses a non-board candidate and the target itself", async () => {
    const { project, ctx } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    await expect(adoptCandidate(await ctx(), { candidate: "c.txt", board: "board.kicad_pcb", reason: "x" })).rejects.toThrow(/must be a .kicad_pcb/);
    await expect(adoptCandidate(await ctx(), { candidate: join(project.dir, "board.kicad_pcb"), board: "board.kicad_pcb", reason: "x" })).rejects.toThrow(/is the target/);
  });

  test("carries origin.json's extra files (an edit's library footprint, acceptance.json) and the stackup the KiCad commit cannot", async () => {
    const { project, ctx } = await setup();
    const stack = (er: string) => `(kicad_pcb\n  (setup\n    (stackup\n      (layer "dielectric 1" (type "core") (epsilon_r ${er}))))\n  (footprint "x"))\n`;
    await writeFile(join(project.dir, "board.kicad_pcb"), stack("4.5"));
    await mkdir(join(project.dir, "Parts.pretty"), { recursive: true });
    await writeFile(join(project.dir, "Parts.pretty/FIT_P2.kicad_mod"), "old hole");
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    const candidate = join(dir, "board.kicad_pcb");
    await writeFile(candidate, stack("4.17"));
    await mkdir(join(dir, "Parts.pretty"), { recursive: true });
    await writeFile(join(dir, "Parts.pretty/FIT_P2.kicad_mod"), "new hole");
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: await designFileHashes(project.dir), extra: { "Parts.pretty/FIT_P2.kicad_mod": await sha("old hole") } }));
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "hole" });
    expect(r.data.designFiles).toEqual(["Parts.pretty/FIT_P2.kicad_mod"]);
    expect(await readFile(join(project.dir, "Parts.pretty/FIT_P2.kicad_mod"), "utf8")).toBe("new hole");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(stack("4.17"));
    expect(r.text).toContain("stackup written from the candidate");
    // Isolate a library-only stale change from the already adopted stackup.
    await writeFile(join(project.dir, "board.kicad_pcb"), stack("4.5"));
    // the project's library footprint moved on since the candidate: refused, nothing written
    await writeFile(join(project.dir, "Parts.pretty/FIT_P2.kicad_mod"), "someone else's hole");
    await expect(adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "hole" })).rejects.toThrow(/Parts.pretty\/FIT_P2.kicad_mod changed in the project/);
  });

  test("carries changed schematic sheets, keeps the previous copy, and refuses when the project moved on", async () => {
    const { project, ctx } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(project.dir, "board.kicad_sch"), "original sheet");
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    const candidate = join(dir, "c.kicad_pcb");
    await writeFile(candidate, "(kicad_pcb edited)");
    await writeFile(join(dir, "board.kicad_sch"), "edited sheet");
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: await designFileHashes(project.dir) }));
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" });
    expect(r.data.designFiles).toEqual(["board.kicad_sch"]);
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("edited sheet");
    expect(r.text).toContain("previous copies");

    // the project's sheet moved on after another candidate was computed
    await writeFile(join(project.dir, "board.kicad_sch"), "someone else's newer sheet");
    const dir2 = await mkdtemp(join(tmpdir(), "cand-"));
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "c.kicad_pcb"), "(kicad_pcb 2)");
    await writeFile(join(dir2, "board.kicad_sch"), "yet another");
    await writeFile(join(dir2, "origin.json"), JSON.stringify({ project: project.dir, files: { "board.kicad_pcb": await sha("(kicad_pcb)"), "board.kicad_sch": await sha("edited sheet") } }));
    await expect(adoptCandidate(await ctx(), { candidate: join(dir2, "c.kicad_pcb"), board: "board.kicad_pcb", reason: "late" })).rejects.toThrow(/changed in the project since/);
  });

  async function withSheetCandidate(project: { dir: string }) {
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb original)");
    await writeFile(join(project.dir, "board.kicad_sch"), "original sheet");
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    await writeFile(join(dir, "c.kicad_pcb"), "(kicad_pcb edited)");
    await writeFile(join(dir, "board.kicad_sch"), "edited sheet");
    await writeFile(join(dir, "power.kicad_sch"), "new sheet");
    const req = join(".fabdesk", "board", "requirements");
    await mkdir(join(project.dir, req), { recursive: true });
    await mkdir(join(dir, req), { recursive: true });
    await writeFile(join(project.dir, req, "circuit.json"), "old circuit");
    await writeFile(join(dir, req, "circuit.json"), "edited circuit");
    await writeFile(join(dir, req, "mechanical.json"), "new anchors");
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: await designFileHashes(project.dir) }));
    return join(dir, "c.kicad_pcb");
  }

  test("adopts edited and new requirements along with the sheets", async () => {
    const { project, ctx } = await setup();
    const candidate = await withSheetCandidate(project);
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "ECO" });
    expect(r.data.designFiles).toContain(join(".fabdesk", "board", "requirements", "circuit.json"));
    expect(await readFile(join(project.dir, ".fabdesk/board/requirements/circuit.json"), "utf8")).toBe("edited circuit");
    expect(await readFile(join(project.dir, ".fabdesk/board/requirements/mechanical.json"), "utf8")).toBe("new anchors");
  });

  test("refuses stale requirements, including a concurrently created requirement", async () => {
    for (const name of ["circuit.json", "mechanical.json"]) {
      const { project, ctx, seen } = await setup();
      const candidate = await withSheetCandidate(project);
      await writeFile(join(project.dir, ".fabdesk/board/requirements", name), "newer requirement");
      await expect(adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "ECO" })).rejects.toThrow(/changed in the project since/);
      expect(seen).toHaveLength(0);
      expect(await readFile(join(project.dir, ".fabdesk/board/requirements", name), "utf8")).toBe("newer requirement");
      expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("original sheet");
    }
  });

  test("refuses a newer PCB both before admission and after saved-file recovery", async () => {
    for (const duringRecovery of [false, true]) {
      const { project, ctx, services, seen } = await setup();
      const candidate = await withSheetCandidate(project);
      const change = () => writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb newer)");
      if (duringRecovery) services.design.withSavedFilesRecovery = async (_dir, apply) => { await change(); return apply(); };
      else await change();
      await expect(adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "ECO" })).rejects.toThrow(/board.kicad_pcb changed/);
      expect(seen).toHaveLength(0);
      expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb newer)");
      expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("original sheet");
    }
  });

  test("all or nothing: a failing KiCad commit puts the sheets (and a half-written board) back and says so", async () => {
    const { project, ctx } = await setup(async (i) => {
      await writeFile(i.target, "(kicad_pcb half written)");
      throw new Error("IPC commit refused");
    });
    const candidate = await withSheetCandidate(project);
    const err = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("IPC commit refused");
    expect(err?.message).toContain("The project was restored");
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("original sheet");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb original)");
    expect(await readFile(join(project.dir, "power.kicad_sch")).catch(() => null)).toBeNull();
    expect(await readFile(join(project.dir, ".fabdesk/board/requirements/circuit.json"), "utf8")).toBe("old circuit");
    expect(await readFile(join(project.dir, ".fabdesk/board/requirements/mechanical.json")).catch(() => null)).toBeNull();
  });

  test("when the restore itself fails, the error names each file that differs and where its copy was", async () => {
    const { project, ctx } = await setup(async (i) => {
      await writeFile(i.target, "(kicad_pcb half written)");
      await rm(join(project.dir, ".fabdesk", "board", "adopt"), { recursive: true, force: true });
      throw new Error("IPC lost");
    });
    const candidate = await withSheetCandidate(project);
    const err = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("Restoring the project also failed");
    expect(err?.message).toContain("board.kicad_pcb (previous copy: .fabdesk/board/adopt/");
    expect(err?.message).toContain("board.kicad_sch (previous copy:");
    expect(err?.message).not.toContain("power.kicad_sch");
  });

  // what the bundled KiCad (bridge) or an old kicad-cli says about a board saved by KiCad nightly
  const tooNew = "FabPlane PCB bridge 502 on /sessions: socket /x/api.sock closed by peer\n--- kicad-cli output ---\n[err] Failed to load board: KiCad was unable to open this file because it was created with a more recent version than the one you are running.\n[err] \n[err] To open it you will need to upgrade KiCad to version 10.99 or later (file format dated 20261025 or later).";

  test("a bridge that cannot open the board (newer file format) holds no session on it: the KiCad commit goes ahead with the selected kicad-cli", async () => {
    const { project, seen, ctx } = await setup(undefined, async () => {
      throw new Error(tooNew);
    });
    const candidate = await withSheetCandidate(project);
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" });
    expect(seen).toHaveLength(1);
    expect(r.data.via).toBe("ipc");
    expect(r.text).toContain("the PCB bridge's KiCad cannot open this board (it needs KiCad 10.99 or later, file format 20261025), so no live KiCad session holds it; applied as one KiCad commit with kicad-cli");
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("edited sheet");
  });

  test("no KiCad here opens the board: the candidate is written as a file, read back, with the sheets and the same checkpoint", async () => {
    const { project, seen, ctx } = await setup(async () => {
      throw new ToolError(`KiCad could not open the board: ${tooNew}`, "precondition");
    }, async () => {
      throw new Error(tooNew);
    });
    const big = `(kicad_pcb (version 20261025)\n\t(footprint "L:X" (uuid "00000000-0000-4000-8000-000000000001") (at 1 2))\n\t(segment (start 0 0) (end 1 0) (uuid "00000000-0000-4000-8000-000000000002"))\n)\n`;
    const candidate = await withSheetCandidate(project);
    await writeFile(join(project.dir, "board.kicad_pcb"), big);
    const originPath = join(candidate, "..", "origin.json");
    const origin = JSON.parse(await readFile(originPath, "utf8"));
    origin.files["board.kicad_pcb"] = await sha(big);
    await writeFile(originPath, JSON.stringify(origin));
    const moved = big.replace("(at 1 2)", "(at 5 2)").replace(/\t\(segment[^\n]*\n/, "\t(via (at 3 3) (uuid \"00000000-0000-4000-8000-000000000003\"))\n");
    await writeFile(candidate, moved);
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" });
    expect(seen).toHaveLength(1);
    expect(r.data.via).toBe("file");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(moved);
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("edited sheet");
    expect(r.text).toContain("written as a file, not as a KiCad commit");
    expect(r.text).toContain("cannot open this board: it needs KiCad 10.99 or later");
    expect(r.text).toContain("removed trace 1; added via 1; changed footprint 1");
    expect(r.data.checkpointId).toMatch(/^task-/);
    expect(r.clean).toBe(true);
  });

  test("any other bridge or KiCad failure still refuses: nothing is written as a file", async () => {
    const bridgeDown = await setup(undefined, async () => {
      throw new Error("FabPlane PCB bridge 502 on /sessions: socket closed by peer");
    });
    const c1 = await withSheetCandidate(bridgeDown.project);
    await expect(adoptCandidate(await bridgeDown.ctx(), { candidate: c1, board: "board.kicad_pcb", reason: "edit" })).rejects.toThrow(/socket closed by peer/);
    expect(bridgeDown.seen).toHaveLength(0);
    expect(await readFile(join(bridgeDown.project.dir, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb original)");
    const cliBroken = await setup(async () => {
      throw new ToolError("KiCad could not open the board: segmentation fault", "precondition");
    });
    const c2 = await withSheetCandidate(cliBroken.project);
    await expect(adoptCandidate(await cliBroken.ctx(), { candidate: c2, board: "board.kicad_pcb", reason: "edit" })).rejects.toThrow(/segmentation fault.*The project was restored/s);
    expect(await readFile(join(cliBroken.project.dir, "board.kicad_pcb"), "utf8")).toBe("(kicad_pcb original)");
    expect(await readFile(join(cliBroken.project.dir, "board.kicad_sch"), "utf8")).toBe("original sheet");
  });

  test("the candidate's DRC exclusions go into the project file (that key only), and not after the project's moved on", async () => {
    const { project, ctx } = await setup();
    const ex = (k: string) => ({ board: { design_settings: { drc_exclusions: [[k, "Intentional Overlap"]], rules: { min_clearance: 0.1 } } }, net_settings: { classes: [{ name: "Default", clearance: 0.2 }] } });
    const projPro = `${JSON.stringify(ex("old|1|2|a|b"), null, 2)}\n`;
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(project.dir, "board.kicad_pro"), projPro);
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    const candidate = join(dir, "board.kicad_pcb");
    await writeFile(candidate, "(kicad_pcb edited)");
    // the candidate's project file differs in other ways too (scoring rules): only the exclusions are carried
    const cand = ex("new|1|2|c|b");
    cand.net_settings.classes[0]!.clearance = 0.13;
    await writeFile(join(dir, "board.kicad_pro"), JSON.stringify(cand));
    const was = edit.exclusionsText(edit.readDrcExclusions(projPro));
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: await designFileHashes(project.dir), exclusions: { file: "board.kicad_pro", sha256: await sha(was) } }));
    const r = await adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" });
    expect(r.data.drcExclusions).toBe(1);
    expect(r.text).toContain("DRC exclusions written to board.kicad_pro from the candidate");
    const now = await readFile(join(project.dir, "board.kicad_pro"), "utf8");
    expect(now).toBe(projPro.replace("old|1|2|a|b", "new|1|2|c|b"));
    // a project whose exclusions moved on since the candidate was computed is refused
    await writeFile(join(project.dir, "board.kicad_pro"), `${JSON.stringify(ex("someone|else|a|b"), null, 2)}\n`);
    await expect(adoptCandidate(await ctx(), { candidate, board: "board.kicad_pcb", reason: "edit" })).rejects.toThrow(/DRC exclusions in board.kicad_pro changed in the project since/);
  });
});

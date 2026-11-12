import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, type BoardAdoptResult, type CoreServices } from "../src";
import { adoptCandidate } from "../src/board-adopt";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const empty = { removed: {}, added: {}, changed: {} };
const result = (over: Partial<BoardAdoptResult> = {}): BoardAdoptResult => ({
  delta: { removed: { KOT_PCB_TRACE: 10 }, added: { KOT_PCB_TRACE: 14 }, changed: { KOT_PCB_FOOTPRINT: 1 } },
  residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: { commit: 89 }, kicadCli: "kicad-cli", ...over,
});

async function setup(adopt?: (i: { target: string; candidate: string }) => Promise<BoardAdoptResult>) {
  const project = await tempProject("adopt");
  const seen: Array<{ target: string; candidate: string }> = [];
  const services: CoreServices = {
    ...mockServices([project]),
    boardAdopt: { adopt: async (i) => (seen.push(i), adopt ? adopt(i) : result()) },
  };
  const def = createRegistry().get("board_job")!;
  const ctx = () => contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
  return { project, seen, ctx };
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

  test("carries changed schematic sheets, keeps the previous copy, and refuses when the project moved on", async () => {
    const { project, ctx } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(project.dir, "board.kicad_sch"), "original sheet");
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    const candidate = join(dir, "c.kicad_pcb");
    await writeFile(candidate, "(kicad_pcb edited)");
    await writeFile(join(dir, "board.kicad_sch"), "edited sheet");
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: { "board.kicad_sch": await sha("original sheet") } }));
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
    await writeFile(join(dir2, "origin.json"), JSON.stringify({ project: project.dir, files: { "board.kicad_sch": await sha("edited sheet") } }));
    await expect(adoptCandidate(await ctx(), { candidate: join(dir2, "c.kicad_pcb"), board: "board.kicad_pcb", reason: "late" })).rejects.toThrow(/changed in the project since/);
  });

  async function withSheetCandidate(project: { dir: string }) {
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb original)");
    await writeFile(join(project.dir, "board.kicad_sch"), "original sheet");
    const dir = await mkdtemp(join(tmpdir(), "cand-"));
    await writeFile(join(dir, "c.kicad_pcb"), "(kicad_pcb edited)");
    await writeFile(join(dir, "board.kicad_sch"), "edited sheet");
    await writeFile(join(dir, "power.kicad_sch"), "new sheet");
    await writeFile(join(dir, "origin.json"), JSON.stringify({ project: project.dir, files: { "board.kicad_sch": await sha("original sheet") } }));
    return join(dir, "c.kicad_pcb");
  }

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
});

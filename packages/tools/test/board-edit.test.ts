import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { onboard, runAcceptance } from "@fabdesk/board-workflow";
import { createRegistry, type BoardAdoptResult, type CoreServices } from "../src";
import { BOARD, PRO, SHEET } from "../../board-workflow/test/edit-fixture";
import { ResourceGovernor, setGovernor } from "../src/resources";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const empty = { removed: {}, added: {}, changed: {} };
const adoptResult = (): BoardAdoptResult => ({ delta: { removed: { KOT_PCB_FOOTPRINT: 1 }, added: {}, changed: {} }, residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: { commit: 5 }, kicadCli: "kicad-cli" });

async function setup(route?: (dir: string) => Promise<void>) {
  const project = await tempProject("edit");
  await writeFile(join(project.dir, "board.kicad_pcb"), BOARD);
  await writeFile(join(project.dir, "board.kicad_pro"), PRO);
  await writeFile(join(project.dir, "board.kicad_sch"), SHEET);
  await onboard(project.dir, { name: "t" });
  const adopted: Array<{ target: string; candidate: string }> = [];
  const base = mockServices([project]);
  const drcRuns: string[] = [];
  const services: CoreServices = {
    ...base,
    ...(route ? { design: { ...base.design, route: async (dir: string) => (await route(dir), { message: "routed" }) } } : {}),
    boardAdopt: { adopt: async (i) => (adopted.push(i), adoptResult()) },
    kicad: {
      ...base.kicad,
      // a candidate whose C3 sits at 50,30 has lost its copper: two open connections; everything else is clean
      runDrc: async (_cli, o) => {
        drcRuns.push(o.board);
        const cut = (await readFile(o.board, "utf8")).includes("(translate 50.0000 30.0000)");
        await mkdir(join(o.outFile, ".."), { recursive: true });
        await writeFile(o.outFile, JSON.stringify({ violations: [], unconnected_items: cut ? [{}, {}] : [{ excluded: true }], schematic_parity: [] }));
        return { violations: [], unconnected: [], schematicParity: [] } as never;
      },
    },
  };
  const def = createRegistry().get("board_edit")!;
  const run = async (args: object) => {
    const ctx = await contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
    return (def.handler as unknown as (a: object, c: unknown) => Promise<{ text: string; json: Record<string, unknown>; isError?: boolean }>)({ mode: "full", adopt: false, ...args }, ctx);
  };
  return { project, run, adopted, drcRuns, services };
}

describe("board_edit", () => {
  test("is a board-toolset tool with a plan, a mode and adopt", () => {
    const def = createRegistry().get("board_edit")!;
    expect(def.toolset).toBe("board");
    expect(Object.keys(def.inputSchema)).toEqual(["plan", "mode", "adopt", "candidate", "pcb"]);
  });

  test("a bad nested plan field is named on every entry path, not \"Invalid input at plan\"", async () => {
    const def = createRegistry().get("board_edit")!;
    const plan = { id: "via", stack: { remove_vias: [{ uuid: "80bbae6c", reason: "via in U1 pad 9" }] } };
    const parsed = z.object(def.inputSchema as z.ZodRawShape).safeParse({ plan });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((i) => i.message).join("\n")).toContain("plan.stack.remove_vias[0].net: expected string, received undefined");
    const { project, run } = await setup();
    await expect(run({ mode: "impact", plan: JSON.stringify(plan) })).rejects.toThrow("plan.stack.remove_vias[0].net: expected string");
    await writeFile(join(project.dir, "via-plan.json"), JSON.stringify(plan));
    await expect(run({ mode: "impact", plan: "via-plan.json" })).rejects.toThrow("plan.stack.remove_vias[0].net: expected string");
  });

  test("impact needs no KiCad run and writes nothing", async () => {
    const { project, run, drcRuns } = await setup();
    const r = await run({ mode: "impact", plan: { id: "rm", remove: ["C3"] } });
    expect(r.text).toContain("PASS impact");
    expect(r.text).toContain("part  C3 '100n'");
    expect(r.json["stage"]).toBe("impact");
    expect(drcRuns).toEqual([]);
    const stop = await run({ mode: "impact", plan: JSON.stringify({ id: "rm", remove: ["R2"] }) });
    expect(stop.text).toContain("STOP review: unconnected pins");
    expect(stop.isError).toBeFalsy();
    await expect(run({ plan: "not-json.json" })).rejects.toThrow(/cannot read the plan/);
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe(SHEET);
  });

  test("full: the unedited project is scored once and cached, the candidate is proven, adopt writes sheets and the board", async () => {
    const { project, run, adopted, drcRuns } = await setup();
    const r = await run({ plan: { id: "rm", remove: ["C3"] }, adopt: true });
    expect(r.json["stage"]).toBe("proof");
    expect(r.text).toMatch(/Proof \((strict|no new failure)/);
    expect(r.text).toContain("Planned vs collateral: 1 removed, 0 added");
    expect(drcRuns).toHaveLength(3); // baseline, candidate proof, persisted target check
    expect(drcRuns.at(-1)).toBe(join(project.dir, "board.kicad_pcb"));
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.target).toBe(join(project.dir, "board.kicad_pcb"));
    expect(adopted[0]!.candidate).toContain(".fabdesk/board/edits/rm-");
    // the sheets the candidate changed were written (the PCB goes over IPC, mocked here)
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).not.toContain('"C3"');
    expect(r.text).toMatch(/Adopted/);
    // a second edit of the same source reuses the before-score: one DRC run, not two
    const project2 = await setup();
    await project2.run({ plan: { id: "one", remove: ["C3"] } });
    const n = project2.drcRuns.length;
    await project2.run({ plan: { id: "two", remove: ["C2"] } });
    expect(project2.drcRuns.length - n).toBe(1);
  });

  test("adopted ECO passes A4/A5 against the live requirements", async () => {
    const { project, run, services } = await setup();
    services.boardAdopt = { adopt: async ({ target, candidate }) => { await copyFile(candidate, target); return adoptResult(); } };
    await run({ plan: { id: "rm-live", remove: ["C3"] }, adopt: true });
    const after = await runAcceptance(project.dir, { drc: async () => ({ violations: [], unconnected: 0, parity: 0 }) });
    expect(after.result.summary.A4_circuit).toBe(true);
    expect(after.result.summary.A5_anchors).toBe(true);
  });

  test("on a 4 GiB host edit releases its 2 GiB reservation before repair and adoption", async () => {
    const stages: string[] = [];
    class ConstrainedGovernor extends ResourceGovernor {
      override async admit(input: Parameters<ResourceGovernor["admit"]>[0]) {
        expect(this.running.size).toBe(0);
        stages.push(input.label);
        return super.admit({ ...input, memGiB: input.label === "board_edit" ? 2 : 3 });
      }
    }
    const g = new ConstrainedGovernor(async () => ({ memTotalGiB: 4, memAvailableGiB: 4, swapUsedGiB: 0, load1: 0, cpus: 4, disk: [] }));
    setGovernor(g);
    try {
      const { run, adopted } = await setup(async (dir) => {
        const f = join(dir, "board.kicad_pcb");
        await writeFile(f, (await readFile(f, "utf8")).replace("(translate 50.0000 30.0000)", "(translate 50.0000 30.0001)"));
      });
      await run({ plan: { id: "constrained", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, adopt: true });
      expect(adopted).toHaveLength(1);
      expect(stages.filter((s) => s === "board_edit")).toHaveLength(2);
      expect(stages.at(-1)).toBe("adopt");
      expect(stages.some((s) => s !== "board_edit" && s !== "adopt")).toBe(true);
      expect(g.running.size).toBe(0);
    } finally { setGovernor(null); }
  });

  test("a candidate that opened connections is returned with them, and adopt is refused", async () => {
    const { run, adopted } = await setup();
    const r = await run({ plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, adopt: true });
    // the last-mile bench ran its chain on the candidate (finish, then the KRT steps, which need KRT); nothing closed, so the board stays as edited
    expect(r.text).toContain("Repair (route stage): last mile left the board as edited (open 2); steps: finish: nothing kept (no gain);");
    expect(r.text).toContain("nets cut by the edit: GND, VIN. Workspace .fabdesk/board/edits/");
    expect(r.text).toMatch(/FAIL/);
    expect(r.text).toContain("adopt refused: the proof does not pass");
    expect(adopted).toEqual([]);
    expect((r.json["proof"] as { figures: { open: number } }).figures.open).toBe(2);
  });

  test("nets the edit cut are reconnected by the last-mile finish step before the proof", async () => {
    const { run, adopted } = await setup(async (dir) => {
      // the router closes both opens: the board comes back without the marker the fake DRC reads as "copper lost"
      const f = join(dir, "board.kicad_pcb");
      await writeFile(f, (await readFile(f, "utf8")).replace("(translate 50.0000 30.0000)", "(translate 50.0000 30.0001)"));
    });
    const r = await run({ plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, adopt: true });
    expect(r.text).toContain("Repair (route stage): last mile: open 2 -> 0");
    expect(r.text).toContain("steps: finish: kept, open 0;");
    expect((r.json["proof"] as { figures: { open: number } }).figures.open).toBe(0);
    expect(r.text).not.toContain("adopt refused: the proof does not pass");
    expect(adopted).toHaveLength(1);
  });
});

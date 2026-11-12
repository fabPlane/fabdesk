import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { onboard } from "@fabdesk/board-workflow";
import { createRegistry, type BoardAdoptResult, type CoreServices } from "../src";
import { BOARD, PRO, SHEET } from "../../board-workflow/test/edit-fixture";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const empty = { removed: {}, added: {}, changed: {} };
const adoptResult = (): BoardAdoptResult => ({ delta: { removed: { KOT_PCB_FOOTPRINT: 1 }, added: {}, changed: {} }, residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: { commit: 5 }, kicadCli: "kicad-cli" });

async function setup() {
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
  return { project, run, adopted, drcRuns };
}

describe("board_edit", () => {
  test("is a board-toolset tool with a plan, a mode and adopt", () => {
    const def = createRegistry().get("board_edit")!;
    expect(def.toolset).toBe("board");
    expect(Object.keys(def.inputSchema)).toEqual(["plan", "mode", "adopt", "candidate", "pcb"]);
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
    expect(drcRuns).toHaveLength(2); // before (in the candidate copy), after
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

  test("a candidate that opened connections is returned with them, and adopt is refused", async () => {
    const { run, adopted } = await setup();
    const r = await run({ plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, adopt: true });
    expect(r.text).toContain("Repair: no route stage ran. 2 net(s) lost copper and must be routed again in the candidate: GND, VIN");
    expect(r.text).toMatch(/FAIL/);
    expect(r.text).toContain("adopt refused: the proof does not pass");
    expect(adopted).toEqual([]);
    expect((r.json["proof"] as { figures: { open: number } }).figures.open).toBe(2);
  });
});

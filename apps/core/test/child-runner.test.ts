/**
 * The board child process end to end: the core starts itself with `board-child`, the task runs there, progress and the
 * result come back, a task error keeps its class name, cancel kills the child.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboard } from "@fabdesk/board-workflow";
import { ChildTaskError } from "@fabdesk/tools";
import { createRunChild, selfCommand } from "../src/child-runner";
import { BOARD, PRO } from "../../../packages/board-workflow/test/edit-fixture";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project() {
  const d = await mkdtemp(join(tmpdir(), "child-edit-"));
  dirs.push(d);
  await writeFile(join(d, "board.kicad_pcb"), BOARD);
  await writeFile(join(d, "board.kicad_pro"), PRO);
  await onboard(d, { name: "t" });
  return d;
}

describe("board child process", () => {
  test("selfCommand: the runtime plus the entry script in development, the binary alone when compiled", () => {
    expect(selfCommand("/usr/bin/bun", MAIN)).toEqual(["/usr/bin/bun", MAIN]);
    expect(selfCommand("/opt/fabdesk/fabdesk-core", "/$bunfs/root/fabdesk-core")).toEqual(["/opt/fabdesk/fabdesk-core"]);
  });

  test("an edit's impact runs in the child; progress and the result come back", async () => {
    const dir = await project();
    const run = createRunChild([process.execPath, MAIN]);
    const notes: string[] = [];
    const r = (await run("edit", { projectDir: dir, plan: { id: "mv", move: [{ ref: "C3", to: [50, 30, 90] }], displace: { radius: 3 } }, mode: "impact", kicadCli: null }, { onProgress: (_p, n) => notes.push(n) })) as { stage: string; verdict: string; planId: string; impact: { board: string } };
    expect(r.stage).toBe("impact");
    expect(r.verdict).toMatch(/^PASS/);
    expect(r.planId).toBe("mv");
    expect(r.impact.board).toContain("board.kicad_pcb");
    expect(notes).toContain("impact");
  }, 60_000);

  test("a task error comes back with its class name; an unknown task fails by name", async () => {
    const dir = await project();
    const run = createRunChild([process.execPath, MAIN]);
    // proof with no candidate: the pipeline's EditStop
    const err = await run("edit", { projectDir: dir, plan: { id: "none", move: [{ ref: "C3", to: [50, 30, 90] }] }, mode: "proof", kicadCli: null }, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ChildTaskError);
    expect((err as ChildTaskError).errorName).toBe("EditStop");
    expect((err as Error).message).toContain("no candidate");
    await expect(run("nope" as never, {}, {})).rejects.toThrow(/unknown child task nope/);
  }, 60_000);

  test("cancel kills the child", async () => {
    const dir = await project();
    const run = createRunChild([process.execPath, "-e", "await new Promise((r) => setTimeout(r, 60000))", "--"]);
    const ac = new AbortController();
    const p = run("edit", { projectDir: dir }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toThrow(/cancelled/);
  }, 20_000);
});

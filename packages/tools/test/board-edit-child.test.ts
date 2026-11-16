/**
 * board_edit with a host that runs heavy compute in a child process (`services.runChild`): impact/apply/proof go to the
 * child, repair stays here between apply and proof, an EditStop from the child is a decision for the agent.
 */
import { describe, expect, test } from "bun:test";
import { ChildTaskError, type EditChildInput } from "../src/child-tasks";
import { runEditOutOfCore } from "../src/tools/board-edit";
import { governor } from "../src/resources";
import { ToolError } from "../src/registry";

const ctx = (run: (task: string, input: unknown) => Promise<unknown>) =>
  ({ services: { runChild: (t: string, i: unknown) => run(t, i) }, progress: () => {}, signal: new AbortController().signal }) as never;

describe("board_edit out of the core", () => {
  test("full: apply then proof run in the child, with the candidate from apply; nothing cut means no repair", async () => {
    const calls: EditChildInput[] = [];
    const run = async (task: string, input: unknown) => {
      expect(task).toBe("edit");
      expect([...governor().running.values()].map((j) => j.label)).toContain("board_edit");
      const i = input as EditChildInput;
      calls.push(i);
      if (i.mode === "apply") return { stage: "apply", verdict: "PASS apply", stop: false, phases: { impact: 1, apply: 2 }, candidate: { dir: "/p/.fabdesk/board/edits/x", pcb: "/p/.fabdesk/board/edits/x/board.kicad_pcb", origin: "o" }, repair: { available: false, routeAgain: [] } };
      return { stage: "proof", verdict: "PASS no new failure", stop: false, phases: { proof: 3 }, candidate: { dir: i.candidate, pcb: `${i.candidate}/board.kicad_pcb` } };
    };
    const r = await runEditOutOfCore(ctx(run), { projectDir: "/p", plan: { id: "x" }, mode: "full" }, { path: "/usr/bin/kicad-cli", version: "10" });
    expect(calls.map((c) => c.mode)).toEqual(["apply", "proof"]);
    expect(calls[1]!.candidate).toBe("/p/.fabdesk/board/edits/x");
    expect(calls[0]!.kicadCli).toBe("/usr/bin/kicad-cli");
    expect(r.stage).toBe("proof");
    expect([...governor().running.values()].map((j) => j.label)).not.toContain("board_edit");
    expect(r.phases).toEqual({ impact: 1, apply: 2, proof: 3 });
    expect(r.repair).toEqual({ available: true, routeAgain: [] });
  });

  test("impact and proof are one child call; a STOP at apply ends the run; EditStop becomes a precondition", async () => {
    const modes: string[] = [];
    const stopAtApply = async (_t: string, i: unknown) => {
      modes.push((i as EditChildInput).mode);
      return { stage: "apply", verdict: "STOP: fixed part in the way", stop: true, phases: {} };
    };
    const r = await runEditOutOfCore(ctx(stopAtApply), { projectDir: "/p", plan: { id: "x" }, mode: "full" }, null);
    expect(modes).toEqual(["apply"]);
    expect(r.stop).toBe(true);
    const stop = async () => {
      throw new ChildTaskError("FAIL proof: no candidate for plan x", "EditStop");
    };
    await expect(runEditOutOfCore(ctx(stop), { projectDir: "/p", plan: { id: "x" }, mode: "proof" }, null)).rejects.toBeInstanceOf(ToolError);
    const missing = async () => {
      throw new ChildTaskError("no such file", "Error", "ENOENT");
    };
    const err = await runEditOutOfCore(ctx(missing), { projectDir: "/p", plan: { id: "x" }, mode: "impact" }, null).catch((e) => e);
    expect(err).not.toBeInstanceOf(ToolError); // a system error code is not a ToolError code
    const notFound = async () => {
      throw new ChildTaskError("no board", "ToolError", "not_found");
    };
    const nf = await runEditOutOfCore(ctx(notFound), { projectDir: "/p", plan: { id: "x" }, mode: "impact" }, null).catch((e) => e);
    expect(nf).toBeInstanceOf(ToolError);
    expect((nf as ToolError).code).toBe("not_found");
    expect([...governor().running.values()].map((j) => j.label)).not.toContain("board_edit");
  });
});

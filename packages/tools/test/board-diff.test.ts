import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { assertGitRef, pickDesignPaths } from "../src/tools/board-diff";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { PCB_FROM, PCB_TO } from "../../board-diff/test/fixtures";

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout;
}

describe("board revision tools", () => {
  test("assertGitRef rejects path traversal", () => {
    expect(() => assertGitRef("../etc/passwd")).toThrow(/invalid git revision/);
    expect(() => assertGitRef("main:foo")).toThrow(/invalid git revision/);
    expect(assertGitRef("HEAD")).toBe("HEAD");
    expect(assertGitRef("worktree")).toBe("worktree");
    expect(assertGitRef("abc1234")).toBe("abc1234");
  });

  test("pickDesignPaths prefers canonical fabdesk names", () => {
    expect(
      pickDesignPaths(["nested/board.kicad_pcb", "board.kicad_pcb", "circuit.netlist.json", "foo.kicad_sch"]),
    ).toEqual({
      pcb: "board.kicad_pcb",
      schematic: "foo.kicad_sch",
      netlist: "circuit.netlist.json",
    });
  });

  test("diffs two git commits of a KiCad board", async () => {
    const project = await tempProject("diff-git");
    const services = mockServices([project]);
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const invoke = (name: string, args: Record<string, unknown>) =>
      registry.invoke(name, args, (ref) =>
        factory({
          def: registry.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );

    await git(project.dir, ["init"]);
    await git(project.dir, ["config", "user.email", "diff@test"]);
    await git(project.dir, ["config", "user.name", "Diff Test"]);
    await git(project.dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_FROM);
    await git(project.dir, ["add", "board.kicad_pcb", "circuit.netlist.json", "fabdesk.json"]);
    await git(project.dir, ["commit", "-m", "from"]);
    const from = (await git(project.dir, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_TO);
    await git(project.dir, ["add", "board.kicad_pcb"]);
    await git(project.dir, ["commit", "-m", "to"]);
    const to = (await git(project.dir, ["rev-parse", "HEAD"])).trim();

    const listed = await invoke("board_revision_list", { limit: 10 });
    const revisions = (listed.json as { revisions: Array<{ ref: string }> }).revisions;
    expect(revisions[0]?.ref).toBe("worktree");
    expect(revisions.some((r) => r.ref === from)).toBe(true);
    expect(revisions.some((r) => r.ref === to)).toBe(true);

    const result = await invoke("board_revision_diff", { from, to });
    expect(result.text).toContain("Added: C1");
    expect(result.text).toContain("Removed: R2");
    const report = result.json as {
      summary: { added: number; removed: number };
      files: { pcbStructured: string };
    };
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
    expect(await Bun.file(join(project.dir, "reports/board-diff.json")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, report.files.pcbStructured)).exists()).toBe(true);
  });

  test("compares worktree against itself without git", async () => {
    const project = await tempProject("diff-wt");
    await mkdir(join(project.dir, "unused"), { recursive: true });
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_FROM);
    const services = mockServices([project]);
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const result = await registry.invoke(
      "board_revision_diff",
      { from: "worktree", to: "worktree" },
      (ref) =>
        factory({
          def: registry.get("board_revision_diff")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(result.text).toContain("Components +0 / -0 / ~0");
  });
});

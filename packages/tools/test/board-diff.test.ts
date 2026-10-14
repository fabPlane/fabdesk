import { describe, expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { assertGitRef, pickDesignFile, pickDesignPaths, projectRelGitPaths } from "../src/tools/board-diff";
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

  test("projectRelGitPaths strips a repo-root listing and keeps a cwd-scoped listing", () => {
    expect(
      projectRelGitPaths(["widget/board.kicad_pcb", "widget/circuit.netlist.json", "sibling.kicad_pcb"], "widget"),
    ).toEqual(["board.kicad_pcb", "circuit.netlist.json"]);
    expect(projectRelGitPaths(["board.kicad_pcb", "circuit.netlist.json"], "widget")).toEqual([
      "board.kicad_pcb",
      "circuit.netlist.json",
    ]);
    expect(projectRelGitPaths(["board.kicad_pcb"], "")).toEqual(["board.kicad_pcb"]);
  });

  test("pickDesignFile matches basename and project-relative paths", () => {
    expect(pickDesignFile(["projects/widget/board.kicad_pcb", "other.kicad_pcb"], "board.kicad_pcb", /\.kicad_pcb$/i)).toBe(
      "projects/widget/board.kicad_pcb",
    );
    expect(pickDesignFile(["nested/board.kicad_sch"], "board.kicad_sch", /\.kicad_sch$/i)).toBe("nested/board.kicad_sch");
    expect(pickDesignFile(["vendor/lib.kicad_pcb"], "board.kicad_pcb", /\.kicad_pcb$/i)).toBe("vendor/lib.kicad_pcb");
    expect(pickDesignFile([], "board.kicad_pcb", /\.kicad_pcb$/i)).toBeUndefined();
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

  test("nested git repo only sees the project folder; missing preferred board is not replaced by a sibling PCB", async () => {
    const project = await tempProject("widget");
    const repoRoot = join(project.dir, "..");
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

    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "diff@test"]);
    await git(repoRoot, ["config", "user.name", "Diff Test"]);
    await git(repoRoot, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(repoRoot, "sibling.kicad_pcb"), PCB_FROM);
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_FROM);
    await git(repoRoot, ["add", "."]);
    await git(repoRoot, ["commit", "-m", "from"]);
    const from = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_TO);
    await git(repoRoot, ["add", "."]);
    await git(repoRoot, ["commit", "-m", "to"]);
    const to = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();

    const result = await invoke("board_revision_diff", { from, to });
    expect(result.text).toContain("Added: C1");
    expect(result.text).toContain("Removed: R2");
    const report = result.json as { from: { paths: { pcb?: string } }; to: { paths: { pcb?: string } } };
    expect(report.from.paths.pcb).toBe("board.kicad_pcb");
    expect(report.to.paths.pcb).toBe("board.kicad_pcb");

    const listed = await invoke("board_revision_list", { limit: 5 });
    expect((listed.json as { revisions: Array<{ ref: string }> }).revisions[0]?.ref).toBe("worktree");

    await unlink(join(project.dir, "board.kicad_pcb"));
    const boardless = await invoke("board_revision_diff", { from: "worktree", to: "worktree" });
    const boardlessReport = boardless.json as { to: { paths: { pcb?: string } } };
    expect(boardlessReport.to.paths.pcb).toBeUndefined();
    expect(boardless.text).toContain("Components +0 / -0 / ~0");

    const vsHead = await invoke("board_revision_diff", { from: to, to: "worktree" });
    const vsHeadReport = vsHead.json as {
      to: { paths: { pcb?: string } };
      diff: { components: { added: Array<{ ref: string }> } };
    };
    expect(vsHeadReport.to.paths.pcb).toBeUndefined();
    expect(vsHeadReport.diff.components.added.map((c) => c.ref)).not.toContain("R2");
  });
});

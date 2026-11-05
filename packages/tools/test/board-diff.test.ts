import { describe, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, makeContext } from "../src";
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
    // Keep a valid empty design so the missing PCB is not confused with an absent project.
    await writeFile(join(project.dir, "circuit.netlist.json"), JSON.stringify({ components: [], nets: [] }));
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

describe("comparison points and explicit members", () => {
  test("non-Git comparison points preserve native bytes and reject tampering", async () => {
    const project = await tempProject("saved-diff"), services = mockServices([project]), registry = createRegistry(), factory = contextFactory(services, project);
    const invoke = (name: string, args: Record<string, unknown>) => registry.invoke(name, args, ref => factory({ def: registry.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_FROM);
    const saved = await invoke("board_revision_checkpoint", { label: "Before resizing" });
    const ref = (saved.json as { revision: { ref: string } }).revision.ref;
    expect(ref).toMatch(/^saved:[a-f0-9]{64}$/);
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(PCB_FROM);
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB_TO);
    expect((await invoke("board_revision_diff", { from: ref, to: "worktree" })).text).toContain("Added: C1");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(PCB_TO);
    expect((await invoke("board_revision_list", {})).text).toContain("1 saved comparison");
    const path = join(project.dir, ".fabdesk/board-revisions", ref.slice(6) + ".json");
    const tampered = JSON.parse(await readFile(path, "utf8")); tampered.sources.kicadPcb = PCB_TO;
    await writeFile(path, JSON.stringify(tampered));
    await expect(invoke("board_revision_diff", { from: ref, to: "worktree" })).rejects.toThrow(/changed/);
  });

  test("member comparison reports stay in their leaf, reject another source and refuse fallback", async () => {
    const root = await tempProject("member-diff"), services = mockServices([root]), registry = createRegistry();
    const leaf = join(root.dir, "boards/io"), sibling = join(root.dir, "boards/lcd");
    await mkdir(leaf, { recursive: true }); await mkdir(sibling, { recursive: true });
    await writeFile(join(leaf, "board.kicad_pcb"), PCB_FROM); await writeFile(join(sibling, "board.kicad_pcb"), PCB_TO);
    const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
    const invoke = (name: string, args: Record<string, unknown>, source = board) => registry.invoke(name, { ...args, board: source }, (_ref, _def, captured) => makeContext({ services, project: { ...root, dir: leaf }, board: captured!, boardRoot: root, runInScope: operation => operation() }));
    const saved = await invoke("board_revision_checkpoint", {}), ref = (saved.json as { revision: { ref: string } }).revision.ref;
    await writeFile(join(leaf, "board.kicad_pcb"), PCB_TO);
    const diff = await invoke("board_revision_diff", { from: ref, to: "worktree" });
    expect(diff.text).toContain("Added: C1");
    expect((diff.json as { _board: { sourceId: string } })._board.sourceId).toBe("io");
    expect(await Bun.file(join(leaf, "reports/board-diff.json")).exists()).toBe(true);
    expect(await Bun.file(join(root.dir, "reports/board-diff.json")).exists()).toBe(false);
    expect(await Bun.file(join(sibling, "reports/board-diff.json")).exists()).toBe(false);
    await expect(invoke("board_revision_diff", { from: ref, to: "worktree" }, { ...board, sourceId: "lcd" })).rejects.toThrow(/does not belong/);
    await unlink(join(leaf, "board.kicad_pcb")); await mkdir(join(leaf, "unrelated")); await writeFile(join(leaf, "unrelated/board.kicad_pcb"), PCB_FROM);
    await expect(invoke("board_revision_diff", { from: "worktree", to: "worktree" })).rejects.toThrow(/no board/);
    expect(await readFile(join(sibling, "board.kicad_pcb"), "utf8")).toBe(PCB_TO);
  });

  test("member Git history requires the same declared source location", async () => {
    const root = await tempProject("member-history"), services = mockServices([root]), registry = createRegistry();
    const leaf = join(root.dir, "boards/io"); await mkdir(leaf, { recursive: true });
    const declaration = { contract: "fabplane.assembly.v1", sources: [{ id: "io", name: "IO", location: "project", directory: "boards/previous" }], instances: [{ id: "io", sourceId: "io", name: "IO" }], connections: [] };
    await writeFile(join(root.dir, "fabplane.assembly.json"), JSON.stringify(declaration)); await writeFile(join(leaf, "board.kicad_pcb"), PCB_FROM);
    await git(root.dir, ["init"]); await git(root.dir, ["config", "user.name", "Diff Test"]); await git(root.dir, ["config", "user.email", "diff@test"]); await git(root.dir, ["config", "commit.gpgsign", "false"]);
    await git(root.dir, ["add", "."]); await git(root.dir, ["commit", "-m", "Prior mapping"]);
    const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
    const invoke = () => registry.invoke("board_revision_diff", { from: "HEAD", to: "worktree", board }, (_ref, _def, captured) => makeContext({ services, project: { ...root, dir: leaf }, board: captured!, boardRoot: root, runInScope: operation => operation() }));
    await expect(invoke()).rejects.toThrow(/not declared at the same location/);
    declaration.sources[0]!.directory = "boards/io";
    await writeFile(join(root.dir, "fabplane.assembly.json"), JSON.stringify(declaration)); await git(root.dir, ["add", "."]); await git(root.dir, ["commit", "-m", "Explicit IO"]);
    await writeFile(join(leaf, "board.kicad_pcb"), PCB_TO);
    expect((await invoke()).text).toContain("Added: C1");
  });
});

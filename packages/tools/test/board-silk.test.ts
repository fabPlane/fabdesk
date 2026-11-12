import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findKicadCli } from "@fabdesk/kicad";
import { createRegistry, type BoardAdoptResult, type CoreServices } from "../src";
import { FIXTURE_BOARD } from "../../board-workflow/test/fixtures";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const cli = await findKicadCli();
const empty = { removed: {}, added: {}, changed: {} };

describe.skipIf(!cli)("board_silk (kicad-cli)", () => {
  async function setup(adopt?: (i: { target: string; candidate: string }) => Promise<BoardAdoptResult>) {
    const project = await tempProject("silk");
    await writeFile(join(project.dir, "board.kicad_pcb"), FIXTURE_BOARD);
    const base = mockServices([project]);
    const seen: Array<{ target: string; candidate: string }> = [];
    const services: CoreServices = {
      ...base,
      kicad: { ...base.kicad, resolveCli: async () => cli! },
      boardAdopt: { adopt: async (i) => (seen.push(i), adopt ? adopt(i) : { delta: empty, residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: {}, kicadCli: cli!.path }) },
    };
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const call = async (args: Record<string, unknown>) => (await registry.invoke("board_silk", args, (ref) => factory({ def: registry.get("board_silk")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }))) as { text?: string; json?: any };
    return { project, call, seen };
  }

  test("check names what is wrong with each label and keeps the record", async () => {
    const { project, call } = await setup();
    const r = await call({ action: "check" });
    expect(r.text).toContain("silk board: 3 labels on silk");
    expect(r.json.labels).toBe(3);
    expect(r.json.textCounts).toBeDefined();
    expect((await stat(join(project.dir, r.json.record))).isFile()).toBe(true);
    // the plan sets the rules: a huge copper clearance makes labels fail that passed
    const strict = await call({ action: "check", plan: { judge: { copper: 5 } } });
    expect(strict.json.bad).toBeGreaterThanOrEqual(r.json.bad);
  });

  test("place writes a candidate with origin.json and does not touch the project; adopt applies it once", async () => {
    const { project, call, seen } = await setup();
    const before = await readFile(join(project.dir, "board.kicad_pcb"), "utf8");
    const r = await call({ action: "place", pictures: false });
    expect(r.json.onlyLabelsChanged).toBe(true);
    expect(r.json.after.bad).toBe(0);
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(before);
    expect(seen).toHaveLength(0);
    const cand = join(project.dir, r.json.candidate);
    const origin = JSON.parse(await readFile(join(cand, "..", "origin.json"), "utf8"));
    expect(origin.project).toBe(project.dir);
    const a = await call({ action: "place", pictures: false, adopt: true, reason: "labels" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe(join(project.dir, "board.kicad_pcb"));
    expect(a.text).toContain("residual none");
  });

  test("dry run solves and reports without writing; show draws pictures", async () => {
    const { project, call } = await setup();
    const d = await call({ action: "place", dryRun: true });
    expect(d.text).toContain("dry run:");
    const s = await call({ action: "show", side: "F", dpi: 200 });
    expect((await stat(join(project.dir, s.json.pictures[0]))).size).toBeGreaterThan(500);
  });
});

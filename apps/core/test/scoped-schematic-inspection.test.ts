import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, inspectProjectBoardSources } from "@fabdesk/tools";
import { inspectSchematicHierarchy } from "@fabdesk/kicad";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import type { ProjectStore } from "../src/projects";
async function fixture(native = false) {
  const project = await tempProject("scoped-schematic"), root = await realpath(project.dir), declaration = join(root, "fabplane.assembly.json");
  for (const id of ["a", "b"]) {
    await mkdir(join(root, "boards", id), { recursive: true });
    await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), join(root, "boards", id, "board.kicad_pcb"));
    await writeFile(join(root, "boards", id, "board.kicad_sch"), `(kicad_sch (version 20250114) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4") (lib_symbols))`);
  }
  await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: [{ id: "left", sourceId: "a", name: "Left" }, { id: "right", sourceId: "a", name: "Right" }, { id: "other", sourceId: "b", name: "Other" }], connections: [] }));
  if (native) {
    const path = join(root, "boards/a/board.kicad_sch"), original = await readFile(path, "utf8");
    const sheet = '(sheet (at 50 50) (size 25 15) (uuid "00000000-0000-0000-0000-000000000002") (property "Sheetname" "Child" (at 50 49.3 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "child.kicad_sch" (at 50 65.7 0) (effects (font (size 1.27 1.27)))))';
    await writeFile(path, original.slice(0, -1) + sheet + ")");
    await writeFile(join(root, "boards/a/child.kicad_sch"), original.replace("000000000001", "000000000003"));
  }
  const data = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: data.manifestSha256! }, base = mockServices([project]); let calls = 0, mutate = false, incomplete = false;
  const services = mockServices([project], { kicad: { ...base.kicad,
    resolveCli: async () => ({ path: native ? process.env["FABPLANE_KICAD_CLI"]! : "/mock/cli", version: "10.99.0" }),
    inspectSchematicHierarchy: async (cli, opts) => {
      calls++; expect(opts.projectDir).toBe(join(root, "boards/a")); expect(opts.rootSchematic).toBe(join(root, "boards/a/board.kicad_sch")); expect(opts.ownedFilesOnly).toBe(true);
      const result = native ? await inspectSchematicHierarchy(cli, opts) : await base.kicad.inspectSchematicHierarchy(cli, opts);
      if (mutate) await writeFile(declaration, (await readFile(declaration, "utf8")) + "\n");
      return incomplete ? { ...result, complete: false, issues: [{ kind: "missing" as const, path: "child.kicad_sch", detail: "Missing native sheet" }] } : result;
    },
  } });
  const registry = createRegistry(), factory = createContextFactory({ services, projects: { resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (args: Record<string, unknown>) => registry.invoke("schematic_inspect", { project: project.id, ...args }, (projectRef, def, selected) => factory({ projectRef, def, ...(selected ? { board: selected } : {}), signal: new AbortController().signal, progress: () => {} }));
  return { project, root, board, invoke, calls: () => calls, incomplete: () => { incomplete = true; }, mutate: () => { mutate = true; } };
}
test("member hierarchy inspection requires explicit scope and rejects live authoring or object selectors", async () => {
  const f = await fixture(); try {
    await expect(f.invoke({})).rejects.toThrow("explicit assembly board source");
    for (const args of [{ detail: "authoring" }, { detail: "full" }, { references: ["R1"] }, { sheet: "/child/" }, { objectIds: ["native"] }, { netNames: ["GND"] }]) await expect(f.invoke({ board: f.board, ...args })).rejects.toThrow("summary only");
    expect(f.calls()).toBe(0);
    await expect(f.invoke({ board: { ...f.board, manifestSha256: "0".repeat(64) } })).rejects.toThrow("membership changed");
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
});
async function inspect(native: boolean) {
  const f = await fixture(native); try {
    const original = await readFile(join(f.root, "boards/a/board.kicad_sch")), other = await readFile(join(f.root, "boards/b/board.kicad_sch"));
    const result = await f.invoke({ board: f.board });
    expect(result.isError).toBe(false);
    if (native) expect(result.json).toMatchObject({ hierarchy: { referencedFiles: ["board.kicad_sch", "child.kicad_sch"], counts: { sheets: 2 } } });
    expect(result.json).toMatchObject({ scope: "complete-saved-hierarchy", ownership: "independent-source-snapshot", _board: { projectId: f.project.id, ...f.board }, hierarchy: { complete: true } });
    expect(await readFile(join(f.root, "boards/a/board.kicad_sch"))).toEqual(original); expect(await readFile(join(f.root, "boards/b/board.kicad_sch"))).toEqual(other);
    f.mutate(); await expect(f.invoke({ board: f.board })).rejects.toThrow("ownership changed");
    expect(await readFile(join(f.root, "boards/a/board.kicad_sch"))).toEqual(original);
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
}
test("source-bound saved inspection rechecks declaration after measurement without source writes", () => inspect(false));
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad inspects the selected member snapshot and preserves native sources", () => inspect(true));

test("incomplete member inventory returns source-bound issues without presenting a successful electrical check", async () => {
  const f = await fixture(); try {
    f.incomplete(); const result = await f.invoke({ board: f.board });
    expect(result.isError).toBe(false); expect(result.text).toContain("INCOMPLETE");
    expect(result.json).toMatchObject({ _board: { projectId: f.project.id, ...f.board }, hierarchy: { complete: false, issues: [{ kind: "missing", path: "child.kicad_sch" }] } });
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
});

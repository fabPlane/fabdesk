import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRegistry, inspectProjectBoardSources } from "@fabdesk/tools";
import { exportOwnedSchematicSvg, inspectSchematicHierarchy } from "@fabdesk/kicad";
import { AssemblySchematicPreviewRevision } from "@fabdesk/protocol";
import { ownedPreviewFixture } from "../../../packages/kicad/test/owned-schematic-fixture";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import type { ProjectStore } from "../src/projects";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(native = false) {
  const project = await tempProject("scoped-schematic-preview"), root = await realpath(project.dir), nativeFixture = await ownedPreviewFixture(native);
  for (const id of ["a", "b"]) { const dir = join(root, "boards", id); await mkdir(join(dir, "renders"), { recursive: true }); await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), join(dir, "board.kicad_pcb")); }
  const leaf = join(root, "boards/a"); for (const name of ["board.kicad_sch", "board.kicad_pro", "child.kicad_sch"]) await cp(join(nativeFixture.dir, name), join(leaf, name));
  await mkdir(join(root, "renders"), { recursive: true });
  await writeFile(join(leaf, "renders/schematic.revision.json"), "previous receipt"); await writeFile(join(root, "renders/schematic.svg"), "unrelated root preview");
  const declaration = join(root, "fabplane.assembly.json"); await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: [{ id: "left", sourceId: "a", name: "Left" }, { id: "right", sourceId: "a", name: "Right" }, { id: "other", sourceId: "b", name: "Other" }], connections: [] }));
  const membership = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: membership.manifestSha256! }, hierarchy = await inspectSchematicHierarchy(nativeFixture.cli, { projectDir: leaf, rootSchematic: join(leaf, "board.kicad_sch"), ownedFilesOnly: true });
  const controller = new AbortController(); let fault: "none" | "source" | "metadata" | "membership" | "cancel" | "missing-file" = "none", calls = 0;
  const base = mockServices([project]), services = mockServices([project], { kicad: { ...base.kicad, resolveCli: async () => nativeFixture.cli, inspectSchematicHierarchy,
    exportOwnedSchematicSvg: async (cli, opts) => {
      calls++; expect(opts.projectDir).toBe(leaf); const result = await exportOwnedSchematicSvg(cli, opts);
      if (fault === "source" || fault === "metadata") { const path = join(leaf, fault === "source" ? "child.kicad_sch" : "board.kicad_pro"); await writeFile(path, (await readFile(path, "utf8")) + "\n"); }
      if (fault === "membership") await writeFile(declaration, (await readFile(declaration, "utf8")) + "\n");
      if (fault === "cancel") controller.abort();
      if (fault === "missing-file") result.sourceFiles = result.sourceFiles.filter(file => file.path !== "child.kicad_sch");
      return result;
    },
  } });
  const registry = createRegistry(), factory = createContextFactory({ services, projects: { resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (args: Record<string, unknown>) => registry.invoke("render_schematic_svg", { project: project.id, ...args }, (projectRef, def, selected) => factory({ projectRef, def, ...(selected ? { board: selected } : {}), signal: controller.signal, progress: () => {} }));
  const cleanup = async () => { await rm(project.dir, { recursive: true, force: true }); await rm(nativeFixture.dir, { recursive: true, force: true }); };
  return { project, root, leaf, board, declaration, hierarchy, invoke, cleanup, calls: () => calls, fault: (next: typeof fault) => { fault = next; } };
}
test("member schematic render requires captured scope and the complete inspected hierarchy revision", async () => {
  const f = await fixture(); try {
    await expect(f.invoke({})).rejects.toThrow("explicit assembly"); await expect(f.invoke({ board: f.board })).rejects.toThrow("expectedHierarchyRevision");
    await expect(f.invoke({ board: f.board, expectedHierarchyRevision: "0".repeat(64) })).rejects.toThrow("changed or is unavailable"); expect(f.calls()).toBe(0);
    expect(await readFile(join(f.leaf, "renders/schematic.revision.json"), "utf8")).toBe("previous receipt");
  } finally { await f.cleanup(); }
});
async function publication(native: boolean) {
  const f = await fixture(native); try {
    const args = { board: f.board, expectedHierarchyRevision: f.hierarchy.aggregateRevision }, result = await f.invoke(args), receiptBytes = await readFile(join(f.leaf, "renders/schematic.revision.json")), receipt = AssemblySchematicPreviewRevision.parse(JSON.parse(receiptBytes.toString()));
    expect(result.json).toMatchObject({ _board: { projectId: f.project.id, ...f.board }, revision: f.hierarchy.aggregateRevision });
    expect(receipt.boardSource).toEqual({ projectId: f.project.id, ...f.board }); expect(receipt.sheets).toHaveLength(2); expect(receipt.sourceFiles).toHaveLength(3);
    const saved = new Map<string, Buffer>(); for (const sheet of receipt.sheets) { const bytes = await readFile(join(f.leaf, sheet.path)); expect(sha(bytes)).toBe(sheet.sha256); saved.set(sheet.path, bytes); }
    const originals = new Map<string, Buffer>(); for (const path of ["child.kicad_sch", "board.kicad_pro"]) originals.set(path, await readFile(join(f.leaf, path))); const declaration = await readFile(f.declaration);
    for (const fault of ["source", "metadata", "membership", "missing-file", "cancel"] as const) {
      f.fault(fault); await expect(f.invoke(args)).rejects.toThrow(); expect(await readFile(join(f.leaf, "renders/schematic.revision.json"))).toEqual(receiptBytes);
      for (const [path, bytes] of saved) expect(await readFile(join(f.leaf, path))).toEqual(bytes);
      for (const [path, bytes] of originals) await writeFile(join(f.leaf, path), bytes); await writeFile(f.declaration, declaration);
    }
    expect(await readFile(join(f.root, "renders/schematic.svg"), "utf8")).toBe("unrelated root preview");
  } finally { await f.cleanup(); }
}
test("member publication keeps earlier immutable pages and receipt after changed files, declaration, incomplete coverage or cancellation", () => publication(false));
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad renders and publishes two source-bound pages without replacing earlier previews on failure", () => publication(true), 30_000);

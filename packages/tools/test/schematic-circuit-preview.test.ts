import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderRootCircuitPreview } from "../src/schematic-circuit-preview";
import { mockServices, tempProject, contextFactory } from "./mock-services";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="20mm" viewBox="36 56 30 20" data-fabplane-schematic-view="circuit"><rect x="40" y="60" width="10" height="10"/></svg>';
async function fixture(changeChild = false) {
  const project = await tempProject("circuit-view"), base = mockServices([project]);
  await writeFile(join(project.dir, "board.kicad_sch"), "root"); await writeFile(join(project.dir, "child.kicad_sch"), "child");
  const hierarchy = await base.kicad.inspectSchematicHierarchy({ path: "mock", version: "mock" }, { projectDir: project.dir, rootSchematic: join(project.dir, "board.kicad_sch") });
  hierarchy.projectFile = null; hierarchy.referencedFiles = ["board.kicad_sch", "child.kicad_sch"]; hierarchy.sheets[0]!.sha256 = sha("root"); hierarchy.sheets.push({ ...hierarchy.sheets[0]!, nativePath: "child.kicad_sch", hierarchyPath: "/Child/", identity: "child", sha256: sha("child") });
  const services = mockServices([project], { kicad: { ...base.kicad, inspectSchematicHierarchy: async () => hierarchy,
    exportOwnedSchematicSvg: async (_cli, options) => { expect(options.circuit).toBe(true); expect(options.hierarchy).toBe(hierarchy); return { sourceRevision: hierarchy.aggregateRevision, sourceFiles: [{ path: "board.kicad_sch", sha256: sha("root") }, { path: "child.kicad_sch", sha256: sha("child") }], sheets: [{ name: "root.svg", svg: new TextEncoder().encode(svg) }, { name: "child.svg", svg: new TextEncoder().encode(svg) }] }; },
    rasterizeSvg: async (...args) => { if (changeChild) await writeFile(join(project.dir, "child.kicad_sch"), "edited child"); return base.kicad.rasterizeSvg(...args); },
  } });
  const ctx = await contextFactory(services, project)({ projectRef: project.id, def: { name: "render_schematic_svg" } as never, signal: new AbortController().signal, progress() {} });
  return { project, ctx };
}
test("working circuit previews keep full native hierarchy and write distinct versioned SVG/PNG artifacts", async () => {
  const f = await fixture(); const first = await renderRootCircuitPreview(f.ctx, 320), second = await renderRootCircuitPreview(f.ctx, 320);
  expect(first.json).toMatchObject({ presentation: "circuit", sourceFiles: [{ path: "board.kicad_sch" }, { path: "child.kicad_sch" }] });
  const paths = (first.json as { sheets: string[] }).sheets, newer = (second.json as { sheets: string[] }).sheets;
  expect(paths).toHaveLength(2); expect(newer[0]).not.toBe(paths[0]); expect(await readFile(paths[0]!, "utf8")).toBe(svg);
  expect(await readFile(join(f.project.dir, "board.kicad_sch"), "utf8")).toBe("root"); expect(await readFile(join(f.project.dir, "child.kicad_sch"), "utf8")).toBe("child");
});
test("child edits during rasterization keep the earlier working preview and remove unpublished staging files", async () => {
  const f = await fixture(true);
  await mkdir(join(f.project.dir, "renders"), { recursive: true });
  await writeFile(join(f.project.dir, "renders/schematic.svg"), "previous svg"); await writeFile(join(f.project.dir, "renders/schematic.png"), "previous png");
  await expect(renderRootCircuitPreview(f.ctx, 320)).rejects.toThrow("native sheet changed");
  expect(await readFile(join(f.project.dir, "renders/schematic.svg"), "utf8")).toBe("previous svg"); expect(await readFile(join(f.project.dir, "renders/schematic.png"), "utf8")).toBe("previous png");
  expect(await readdir(join(f.project.dir, "renders/schematic"))).toEqual([]);
});

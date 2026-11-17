import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMATIC_PREVIEW_REVISION_PATH, PCB_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { createRegistry } from "../src";
import { canonicalReportStatus } from "../src/canonical-report-status";
import { contextFactory, mockServices, tempProject } from "./mock-services";
const hash = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");
async function fixture(change = false) {
  const project = await tempProject("publish-handoff");
  const board = join(project.dir, "board.kicad_pcb"),
    schematic = join(project.dir, "board.kicad_sch");
  await writeFile(
    board,
    '(kicad_pcb (footprint "Test" (property "Reference" "U1")) (footprint "Test" (property "Reference" "R1") (model "resistor.step")))',
  );
  await writeFile(schematic, "root");
  await writeFile(join(project.dir, "child.kicad_sch"), "child");
  const base = mockServices([project]);
  const services = mockServices([project], {
    kicad: {
      ...base.kicad,
      inspectSchematicHierarchy: async (cli) => {
        const h = await base.kicad.inspectSchematicHierarchy(cli, {
          projectDir: project.dir,
          rootSchematic: schematic,
        });
        h.projectFile = null;
        h.referencedFiles = ["board.kicad_sch", "child.kicad_sch"];
        h.sheets[0]!.pageNumber = 1;
        h.sheets.push({
          ...h.sheets[0]!,
          hierarchyPath: "/child/",
          identity: "child",
          nativePath: "child.kicad_sch",
          pageNumber: 2,
        });
        h.aggregateRevision = hash(
          (await readFile(schematic)) +
            ":" +
            (await readFile(join(project.dir, "child.kicad_sch"))),
        );
        return h;
      },
      exportOwnedSchematicSvg: async (_cli, { hierarchy, circuit, projectDir }) => {
        expect(projectDir).toBe(project.dir);
        expect(circuit).toBe(false);
        return {
          sourceRevision: hierarchy.aggregateRevision,
          sourceFiles: await Promise.all(
            hierarchy.referencedFiles.map(async (path) => ({
              path,
              sha256: hash(await readFile(join(project.dir, path))),
            })),
          ),
          sheets: hierarchy.sheets.map((sheet) => ({
            name: sheet.identity + ".svg",
            svg: new TextEncoder().encode(
              '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>',
            ),
            nativeSheet: {
              identity: sheet.identity,
              nativePath: sheet.nativePath,
              hierarchyPath: sheet.hierarchyPath,
              pageNumber: sheet.pageNumber!,
            },
          })),
        };
      },
      exportPcbSvg: async (_cli, { output }) => {
        await writeFile(output, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      },
      exportGlb: async (_cli, options) => {
        expect(options.board).toBe(board);
        expect(options.modelProjectDir).toBe(project.dir);
        await writeFile(options.output, "new model");
        if (change) await writeFile(join(project.dir, "child.kicad_sch"), "edited child");
        return { fused: false, warnings: ["model warning"] };
      },
    },
  });
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const ctx = await factory({
    def: registry.get("render_publish")!,
    signal: new AbortController().signal,
    progress() {},
  });
  const run = () => registry.invoke("render_publish", {}, () => ctx);
  return { project, run, ctx };
}
test("handoff publishes source-bound views and canonical reports, disclosing declared model coverage", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.json).toMatchObject({
    checksPass: true,
    modelCoverage: { total: 2, declared: 1, missing: ["U1"], loadVerification: "unverified" },
  });
  expect(await readFile(join(f.project.dir, "renders/board.glb"), "utf8")).toBe("new model");
  const receipt = JSON.parse(
    await readFile(join(f.project.dir, SCHEMATIC_PREVIEW_REVISION_PATH), "utf8"),
  );
  expect(receipt.sourceFiles).toHaveLength(2);
  expect(receipt.sheets).toHaveLength(2);
  expect(await readFile(join(f.project.dir, PCB_PREVIEW_REVISION_PATH), "utf8")).toContain(
    "sourceSha256",
  );
  expect(await canonicalReportStatus(f.ctx)).toEqual({
    drc: { status: "current" },
    erc: { status: "current" },
  });
  await writeFile(join(f.project.dir, "board.kicad_pcb"), "edited PCB");
  await writeFile(join(f.project.dir, "child.kicad_sch"), "edited child");
  expect(await canonicalReportStatus(f.ctx)).toMatchObject({
    drc: { status: "stale" },
    erc: { status: "stale" },
  });
  await expect(createRegistry().invoke("export_zip", {}, () => f.ctx)).rejects.toThrow(
    "reports are stale",
  );
});
test("an edit during completion aborts without replacing prior canonical views or reports", async () => {
  const f = await fixture(true);
  await mkdir(join(f.project.dir, "renders"), { recursive: true });
  await mkdir(join(f.project.dir, "reports"), { recursive: true });
  for (const path of [
    "renders/pcb.svg",
    "renders/schematic.svg",
    "renders/board.glb",
    "reports/drc.json",
    "reports/erc.json",
  ])
    await writeFile(join(f.project.dir, path), "previous");
  await expect(f.run()).rejects.toThrow("changed");
  for (const path of [
    "renders/pcb.svg",
    "renders/schematic.svg",
    "renders/board.glb",
    "reports/drc.json",
    "reports/erc.json",
  ])
    expect(await readFile(join(f.project.dir, path), "utf8")).toBe("previous");
});

test("a stable failing measurement is published as a failing handoff, never a clean pass", async () => {
  const f = await fixture();
  f.ctx.services.kicad.runErc = async () => ({
    violations: [],
    counts: { errors: 2, warnings: 0 },
  });
  const result = await f.run();
  expect(result.isError).toBe(true);
  expect(result.json).toMatchObject({ checksPass: false, erc: { errors: 2 } });
  expect(result.text).toContain("Checks need attention");
  expect(
    JSON.parse(await readFile(join(f.project.dir, "reports/erc.json"), "utf8")).counts.errors,
  ).toBe(2);
});

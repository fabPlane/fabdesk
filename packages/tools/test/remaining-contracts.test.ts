import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capabilityScore, createRegistry, makeContext } from "../src";
import { mockServices, tempProject } from "./mock-services";

test("discovery prioritizes exact names and explicit aliases without returning unrelated operations", () => {
  const tool = (name: string) => ({ name, title: "review board", description: "board_review mentioned in prose", toolset: "circuit" });
  expect(capabilityScore("board_review", tool("board_review"))).toBe(10000);
  expect(capabilityScore("board_review", tool("schematic_review"))).toBe(0);
  expect(capabilityScore("render_3d", tool("render_glb"))).toBe(10000);
  expect(capabilityScore("export_pdf", tool("export_schematic_pdf"))).toBe(10000);
});
test("compiler schema and validation cannot invoke design mutation", async () => {
  const project = await tempProject("source-contract");
  const services = mockServices([project]); services.design.build = async () => { throw Error("must not build"); };
  const registry = createRegistry(); const call = (args: unknown) => registry.invoke("circuit_source", args, () => makeContext({ services, project }));
  const schema = await call({ action: "schema" }); expect(schema.json).toHaveProperty("example");
  const example = (schema.json as { example: unknown }).example;
  await writeFile(join(project.dir, "circuit.netlist.json"), JSON.stringify(example));
  const before = await readdir(project.dir);
  expect((await call({ action: "validate" })).json).toMatchObject({ valid: true, nativeChecks: "not_run" });
  expect(await readdir(project.dir)).toEqual(before);
  await writeFile(join(project.dir, "circuit.netlist.json"), JSON.stringify({ netlist: { components: [], nets: [{ name: "missing", nodes: [{ ref: "R9", pin: "1" }] }] } }));
  expect((await call({ action: "validate" })).json).toMatchObject({ valid: false });
});
test("default fabrication inventory excludes auxiliary leftovers from a subsequent ZIP", async () => {
  const project = await tempProject("cam-inventory");
  await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
  const services = mockServices([project]);
  services.kicad.exportGerbers = async (_cli, options) => { expect(options.preset).toBe("production"); const file = join(options.outDir, "F_Cu.gbr"); await writeFile(file, "copper"); return { paths: [file] }; };
  const registry = createRegistry(); const call = (name: string) => registry.invoke(name, {}, () => makeContext({ services, project }));
  await mkdir(join(project.dir, "exports/gerbers"), { recursive: true });
  await writeFile(join(project.dir, "exports/gerbers/old-courtyard.gbr"), "old auxiliary");
  await call("export_gerbers"); await call("export_zip");
  const zip = await readFile(join(project.dir, "exports/fabrication.zip"));
  expect(zip.includes(Buffer.from("F_Cu.gbr"))).toBe(true);
  expect(zip.includes(Buffer.from("old-courtyard.gbr"))).toBe(false);
});

test("loaded model coverage comes from measured geometry rather than declarations", async () => {
  const project = await tempProject("actual-model-coverage");
  await writeFile(join(project.dir, "board.kicad_pcb"), '(kicad_pcb (footprint "Test" (property "Reference" "U1") (model "missing.step")))');
  const services = mockServices([project]);
  services.kicad.exportGlb = async (_cli, { output }) => { await writeFile(output, "model"); return { fused: false, warnings: [] }; };
  services.kicad.measureMechanical = async () => ({
    source: { pcbRevision: await import("../src/pcb-preview-revision").then(m => m.pcbPreviewFileHash(join(project.dir, "board.kicad_pcb"))) },
    footprints: [{ ref: "U1", dnp: false, status: "no-geometry", models: [{ load: { status: "missing-file" } }] }],
  }) as never;
  const output = await createRegistry().invoke("render_glb", {}, () => makeContext({ services, project }));
  expect(output.json).toMatchObject({ modelCoverage: { declared: 1, loaded: 0, loadVerification: "measured", unavailable: [{ ref: "U1", status: "no-geometry" }] } });
});

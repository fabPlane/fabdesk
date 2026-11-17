import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portableHandoff } from "../src/portable-handoff";
import { zipFiles } from "../src/tools/export";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { createRegistry } from "../src";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const project = await tempProject("portable-handoff"), services = mockServices([project]);
  const registry = createRegistry(), ctx = await contextFactory(services, project)({ def: registry.get("export_zip")!, signal: new AbortController().signal, progress() {} });
  for (const path of ["exports/gerbers", "renders", "reports", "Parts.pretty"]) await mkdir(join(project.dir, path), { recursive: true });
  const files: Record<string,string> = {
    "board.kicad_pcb": "(kicad_pcb)", "board.kicad_sch": "schematic", "board.kicad_pro": "{}", "Parts.pretty/X.kicad_mod": "footprint", "fp-lib-table": '(fp_lib_table (lib (name "Parts") (uri "${KIPRJMOD}/Parts.pretty")))',
    "renders/pcb.svg": "svg", "renders/board.glb": "glb", "exports/schematic.pdf": "pdf", "exports/positions.contract.json": "{}", "exports/bom.csv": "bom", "exports/bom.coverage.json": JSON.stringify({ complete:true, inputs:[{path:"board.kicad_sch",sha256:hash("schematic")}],absentInputs:[] }),
    "reports/drc.json": JSON.stringify({ pcbRevision: { sha256: hash("(kicad_pcb)") } }), "reports/erc.json": JSON.stringify({ measurement: { checkedRevision: "a".repeat(64), evidenceLevel: "measured", revisionStable: true } }),
    "renders/pcb.svg.revision.json": JSON.stringify({ sourceSha256: hash("(kicad_pcb)"), artifactSha256: hash("svg") }), "renders/board.glb.revision.json": JSON.stringify({ sourceSha256: hash("(kicad_pcb)"), artifactSha256: hash("glb") }),
    "renders/schematic.revision.json": JSON.stringify({ sourceFiles: [{ path: "board.kicad_sch", sha256: hash("schematic") }] }), "exports/schematic.pdf.revision.json": JSON.stringify({ artifactSha256: hash("pdf"), inputs: [{ path: "board.kicad_sch", sha256: hash("schematic") }] }),
    "exports/gerbers/gerbers.inventory.json": JSON.stringify({ pcbSha256: hash("(kicad_pcb)"), files: [] }), "exports/gerbers/drills.inventory.json": JSON.stringify({ pcbSha256: hash("(kicad_pcb)"), files: [] }),
  };
  for (const [path,value] of Object.entries(files)) await writeFile(join(project.dir,path),value);
  return {project,ctx};
}
test("product handoff ZIP includes native/library dependencies and source inventory, excluding backups", async () => {
  const {project,ctx} = await fixture();
  await writeFile(join(project.dir,"exports/old.bak"), "backup");
  const r = await portableHandoff(ctx,"handoff.zip",zipFiles);
  const files = (r.json as {files:string[]}).files;
  for (const name of ["board.kicad_pcb","board.kicad_sch","board.kicad_pro","Parts.pretty/X.kicad_mod","handoff-inventory.json","exports/schematic.pdf"]) expect(files).toContain(name);
  expect(files).not.toContain("exports/old.bak"); expect((await readFile(join(project.dir,"exports/handoff.zip"))).readUInt32LE()).toBe(0x04034b50);
});
test("changed source during archive assembly preserves the previous archive", async () => {
  const {project,ctx} = await fixture(); await writeFile(join(project.dir,"exports/handoff.zip"),"previous");
  await expect(portableHandoff(ctx,"handoff.zip",async (out,entries) => { await zipFiles(out,entries); await writeFile(join(project.dir,"board.kicad_sch"),"changed"); })).rejects.toThrow("changed during packaging");
  expect(await readFile(join(project.dir,"exports/handoff.zip"),"utf8")).toBe("previous");
});
test("stale views and changed PDF payload cannot enter an editable handoff", async () => {
  const {project,ctx} = await fixture(); await writeFile(join(project.dir,"exports/schematic.pdf"),"tampered");
  await expect(portableHandoff(ctx,"handoff.zip",zipFiles)).rejects.toThrow("PDF artifact");
});

import { snapshotProjectDependencies } from "../src/project-dependencies";
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
  for (const path of ["exports/gerbers", "renders", "reports", "Parts.pretty", "renders/schematic/current"]) await mkdir(join(project.dir, path), { recursive: true });
  const files: Record<string,string> = {
    "board.kicad_pcb": "(kicad_pcb)", "board.kicad_sch": "schematic", "board.kicad_pro": "{}", "Parts.pretty/X.kicad_mod": "footprint", "fp-lib-table": '(fp_lib_table (lib (name "Parts") (uri "${KIPRJMOD}/Parts.pretty")))',
    "renders/schematic/current/root.svg": "schematic svg", "renders/pcb.svg": "svg", "renders/board.glb": "glb", "exports/schematic.pdf": "pdf", "exports/positions.contract.json": "{}", "exports/bom.csv": "bom", "exports/positions.csv": "positions", "exports/positions.csv.revision.json": JSON.stringify({basis:"pcb",artifactSha256:hash("positions"),inputs:[{path:"board.kicad_pcb",sha256:hash("(kicad_pcb)")}]}), "exports/bom.coverage.json": JSON.stringify({ complete:true, export:{artifactSha256:hash("bom")}, inputs:[{path:"board.kicad_sch",sha256:hash("schematic")}],absentInputs:[] }),
    "reports/drc.json": JSON.stringify({ pcbRevision: { sha256: hash("(kicad_pcb)") } }), "reports/erc.json": JSON.stringify({ measurement: { checkedRevision: "a".repeat(64), evidenceLevel: "measured", revisionStable: true } }),
    "renders/pcb.svg.revision.json": JSON.stringify({ sourceSha256: hash("(kicad_pcb)"), artifactSha256: hash("svg") }), "renders/board.glb.revision.json": JSON.stringify({ sourceSha256: hash("(kicad_pcb)"), artifactSha256: hash("glb") }),
    "renders/schematic.revision.json": JSON.stringify({ sourceFiles: [{ path: "board.kicad_sch", sha256: hash("schematic") }] }), "exports/schematic.pdf.revision.json": JSON.stringify({ artifactSha256: hash("pdf"), inputs: [{ path: "board.kicad_sch", sha256: hash("schematic") }] }),
    "exports/gerbers/gerbers.inventory.json": JSON.stringify({ pcbSha256: hash("(kicad_pcb)"), files: ["board-F_Cu.gtl"] }), "exports/gerbers/drills.inventory.json": JSON.stringify({ pcbSha256: hash("(kicad_pcb)"), files: ["board-PTH.drl"] }),
  };
  for (const name of ["board-F_Cu.gtl","board-PTH.drl"]) { files[`exports/gerbers/${name}`]="native CAM";files[`exports/gerbers/${name}.revision.json`]=JSON.stringify({basis:"pcb",artifactSha256:hash("native CAM"),inputs:[{path:"board.kicad_pcb",sha256:hash("(kicad_pcb)")}]}); }
  for (const [path,value] of Object.entries(files)) await writeFile(join(project.dir,path),value);
  const projectDependencies = await snapshotProjectDependencies(project.dir);
  const generatedAt = new Date().toISOString();
  for (const [name, contract, artifact] of [["pcb.svg", "fabplane.pcb-preview-revision.v1", "svg"], ["board.glb", "fabplane.board-model-revision.v1", "glb"]]) {
    await writeFile(join(project.dir, `renders/${name}.revision.json`), JSON.stringify({ contract, source: "board.kicad_pcb", artifact: `renders/${name}`, sourceSha256: hash("(kicad_pcb)"), artifactSha256: hash(artifact!), generatedAt, dependencySnapshot: projectDependencies, ...(name === "board.glb" ? { dependencies: "unverified" } : {}) }));
  }
  await writeFile(join(project.dir, "renders/schematic.revision.json"), JSON.stringify({
    contract: "fabplane.schematic-preview-revision.v1", projectId: project.id, sourceRevision: "a".repeat(64),
    sourceFiles: [{ path: "board.kicad_sch", sha256: hash("schematic") }],
    sheets: [{ path: "renders/schematic/current/root.svg", name: "root", sha256: hash("schematic svg"), nativeSheet: { identity: "root", hierarchyPath: "/", nativePath: "board.kicad_sch", pageNumber: 1 } }],
    generatedAt, dependencies: "unverified", dependencySnapshot: projectDependencies,
  }));
  for (const name of ["drc","erc"]) { const path=join(project.dir,`reports/${name}.json`);await writeFile(path,JSON.stringify({...JSON.parse(await readFile(path,"utf8")),projectDependencies})); }
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

for (const file of ["exports/positions.csv","exports/gerbers/board-F_Cu.gtl"]) test(`handoff rejects altered or stale production payload: ${file}`,async()=>{
 const {project,ctx}=await fixture();await writeFile(join(project.dir,file),"altered payload");
 await expect(portableHandoff(ctx,"handoff.zip",zipFiles)).rejects.toThrow("stale or altered");
});
test("handoff requires the actual placement CSV and excludes internal library files",async()=>{
 const {rm}=await import("node:fs/promises"),{project,ctx}=await fixture();
 await mkdir(join(project.dir,"Parts.pretty/.git"));await writeFile(join(project.dir,"Parts.pretty/.git/config"),"dummy secret");await writeFile(join(project.dir,"Parts.pretty/.env"),"dummy secret");await writeFile(join(project.dir,"Parts.pretty/old.bak"),"dummy backup");
 const output=await portableHandoff(ctx,"handoff.zip",zipFiles),files=(output.json as {files:string[]}).files;
 expect(files.some(path=>path.includes(".env")||path.includes(".git/")||path.endsWith(".bak"))).toBe(false);
 await rm(join(project.dir,"exports/positions.csv"));await expect(portableHandoff(ctx,"handoff.zip",zipFiles)).rejects.toThrow("exports/positions.csv");
});

for (const view of ["pcb.svg", "board.glb", "schematic"]) test(`handoff requires measured current dependencies for ${view}`, async () => {
  const { project, ctx } = await fixture();
  const path = join(project.dir, `renders/${view}.revision.json`);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  delete receipt.dependencySnapshot;
  await writeFile(path, JSON.stringify(receipt));
  await writeFile(join(project.dir, "exports/handoff.zip"), "previous");
  await expect(portableHandoff(ctx, "handoff.zip", zipFiles)).rejects.toThrow("dependencies are stale or unverified");
  expect(await readFile(join(project.dir, "exports/handoff.zip"), "utf8")).toBe("previous");
});
test("fresh checks do not make old views current after a local library changes", async () => {
  const { project, ctx } = await fixture();
  await writeFile(join(project.dir, "Parts.pretty/X.kicad_mod"), "changed footprint");
  const projectDependencies = await snapshotProjectDependencies(project.dir);
  for (const name of ["drc", "erc"]) {
    const path = join(project.dir, `reports/${name}.json`);
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), projectDependencies }));
  }
  await expect(portableHandoff(ctx, "handoff.zip", zipFiles)).rejects.toThrow("dependencies are stale or unverified");
});
for (const missing of [true, false]) test(`handoff rejects ${missing ? "missing" : "altered"} schematic sheet bytes`, async () => {
  const { project, ctx } = await fixture();
  const path = join(project.dir, "renders/schematic/current/root.svg");
  if (missing) await (await import("node:fs/promises")).rm(path);
  else await writeFile(path, "altered schematic drawing");
  await writeFile(join(project.dir, "exports/handoff.zip"), "previous");
  await expect(portableHandoff(ctx, "handoff.zip", zipFiles)).rejects.toThrow("schematic view is missing or altered");
  expect(await readFile(join(project.dir, "exports/handoff.zip"), "utf8")).toBe("previous");
});

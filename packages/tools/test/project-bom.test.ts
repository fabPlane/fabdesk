import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, makeContext, type ToolContext } from "../src";
import { readProjectBom } from "../src/project-bom";
import { DEMO_NETLIST, mockServices, tempProject } from "./mock-services";
const header = "Reference,Value,Footprint,MPN,Manufacturer,QUANTITY,DNP,EXCLUDE_FROM_BOM,EXCLUDE_FROM_BOARD\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(assembly = false) {
  const project = await tempProject("project-bom"), services = mockServices([project]);
  const ctx = makeContext({ services, project });
  if (assembly) {
    for (const id of ["io", "unused"]) {
      await mkdir(join(project.dir, "boards", id), { recursive: true });
      await writeFile(join(project.dir, "boards", id, "board.kicad_pcb"), `PCB ${id}`);
      await writeFile(join(project.dir, "boards", id, "board.kicad_sch"), `SCH ${id}`);
    }
    await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify({ contract: "fabplane.assembly.v1", sources: [{ id: "io", name: "I/O", location: "project", directory: "boards/io" }, { id: "unused", name: "Unused", location: "project", directory: "boards/unused" }, { id: "missing", name: "Missing", location: "unresolved", provenance: { repository: "https://example.com/board", path: "missing" } }], instances: [{ id: "left", sourceId: "io", name: "Left" }, { id: "right", sourceId: "io", name: "Right" }, { id: "unknown", sourceId: "missing", name: "Unknown" }], connections: [] }));
  }
  services.kicad.exportOwnedSchematicBom = async (_cli, options) => {
    const text = await readFile(join(options.projectDir, "board.kicad_sch"), "utf8");
    return { sourceRevision: digest(text), sourceFiles: [{ path: "board.kicad_sch", sha256: digest(text) }], csv: header + "R1,1k,Resistor:R,,,1,,,\nR2,10k,Resistor:R,,,1,yes,,\n" };
  };
  return { project, services, ctx, invoke: (name: string, args = {}) => createRegistry().invoke(name, args, () => ctx) };
}
test("assembly quantities use explicit instances, ignore undeclared root netlists and disclose missing/unused sources", async () => {
  const { ctx, project } = await fixture(true);
  const before = await readFile(join(project.dir, "boards/io/board.kicad_sch"), "utf8");
  const result = await readProjectBom(ctx);
  expect(result.lines).toEqual([expect.objectContaining({ refs: ["left:R1", "right:R1"], qty: 2 })]);
  expect(result.coverage.map(source => [source.status, source.multiplier, source.componentCount])).toEqual([["native-schematic", 2, 1], ["unused", 0, 0], ["unavailable", 1, 0]]);
  expect(result.complete).toBe(false);
  expect(result.inputs.some(input => input.path === "circuit.netlist.json")).toBe(false);
  expect(await readFile(join(project.dir, "boards/io/board.kicad_sch"), "utf8")).toBe(before);
});
test("native schematic takes precedence over netlist; hardware is counted once", async () => {
  const { ctx, project } = await fixture();
  await writeFile(join(project.dir, "board.kicad_sch"), "native");
  await writeFile(join(project.dir, "project.parts.json"), JSON.stringify({ schema: 1, parts: [{ id: "h1", ref: "H1", kind: "fastener", name: "Screw", qty: 8 }] }));
  const result = await readProjectBom(ctx);
  expect(result.complete).toBe(true); expect(result.lines.map(line => [line.refs, line.qty])).toEqual([[["R1"], 1], [["H1"], 8]]);
  expect(result.inputs.some(input => input.path === "circuit.netlist.json")).toBe(false);
});
test("netlist-only export requires reviewed partial coverage and refuses a stale displayed revision", async () => {
  const { ctx, project, invoke } = await fixture(); const snapshot = await readProjectBom(ctx);
  expect(snapshot.coverage[0]?.status).toBe("saved-netlist"); expect(snapshot.complete).toBe(false);
  await expect(invoke("export_bom")).rejects.toThrow("coverage");
  await invoke("export_bom", { expectedRevision: snapshot.revision, allowPartial: true });
  expect(await readFile(join(project.dir, "exports/bom.csv"), "utf8")).toContain("pcb,pcb,R1,1k,1");
  expect(JSON.parse(await readFile(join(project.dir, "exports/bom.coverage.json"), "utf8")).revision).toBe(snapshot.revision);
  await writeFile(join(project.dir, "circuit.netlist.json"), JSON.stringify({ ...DEMO_NETLIST, netlist: { ...DEMO_NETLIST.netlist, components: [] } }));
  await expect(invoke("export_bom", { expectedRevision: snapshot.revision, allowPartial: true })).rejects.toThrow("changed");
});
test("changed native inputs during collection reject the mixed snapshot, and aliases never provide parts", async () => {
  const { ctx, project, services } = await fixture();
  await writeFile(join(project.dir, "board.kicad_sch"), "native");
  const delegate = services.kicad.exportOwnedSchematicBom;
  services.kicad.exportOwnedSchematicBom = async (...args) => { const result = await delegate(...args); await writeFile(join(project.dir, "board.kicad_sch"), "changed"); return result; };
  await expect(readProjectBom(ctx)).rejects.toThrow("changed");
  await symlink(join(project.dir, "circuit.netlist.json"), join(project.dir, "project.parts.json"));
  await expect(readProjectBom(ctx)).rejects.toThrow();
});
test("native export failure stays explicit and never falls back to an old design netlist", async () => {
  const { ctx, project, services } = await fixture();
  await writeFile(join(project.dir, "board.kicad_sch"), "native");
  services.kicad.exportOwnedSchematicBom = async () => { throw new Error("native CLI unavailable"); };
  const result = await readProjectBom(ctx);
  expect(result.lines).toEqual([]); expect(result.coverage[0]?.status).toBe("failed"); expect(result.coverage[0]?.reason).toContain("unavailable"); expect(result.complete).toBe(false);
  await expect(readProjectBom({ ...ctx, board: { sourceId: "io", manifestSha256: "a".repeat(64) } } as ToolContext)).rejects.toThrow("project scope");
});


test("declared schematic-only boards contribute parts before a PCB is created", async () => {
  const { ctx, project } = await fixture(true);
  const path = join(project.dir, "boards/io/board.kicad_pcb");
  await rm(path);
  const before = await readFile(join(project.dir, "boards/io/board.kicad_sch"), "utf8");
  const result = await readProjectBom(ctx);
  expect(result.lines).toEqual([expect.objectContaining({ refs: ["left:R1", "right:R1"], qty: 2 })]);
  expect(result.coverage[0]).toMatchObject({ status: "native-schematic", multiplier: 2, componentCount: 1 });
  expect(result.absentInputs).toContain("boards/io/board.kicad_pcb");
  expect(await readFile(join(project.dir, "boards/io/board.kicad_sch"), "utf8")).toBe(before);
  expect(await Bun.file(path).exists()).toBe(false);
});

test("a schematic-only source alias is refused without using its saved netlist", async () => {
  const { ctx, project } = await fixture(true);
  await rm(join(project.dir, "boards/io/board.kicad_pcb"));
  await rm(join(project.dir, "boards/io/board.kicad_sch"));
  await symlink(join(project.dir, "boards/unused/board.kicad_sch"), join(project.dir, "boards/io/board.kicad_sch"));
  await writeFile(join(project.dir, "boards/io/circuit.netlist.json"), JSON.stringify(DEMO_NETLIST));
  const result = await readProjectBom(ctx);
  expect(result.lines).toEqual([]);
  expect(result.coverage[0]?.status).toBe("failed");
  expect(result.inputs.some(input => input.path === "boards/io/circuit.netlist.json")).toBe(false);
});

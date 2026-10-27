import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const project = await tempProject("assembly-agent-context"); roots.push(dirname(project.dir));
  const services = mockServices([project]);
  services.design.query = async () => { throw new Error("Status must not open a native board"); };
  const registry = createRegistry();
  const invoke = () => registry.invoke("project_status", {}, ref => contextFactory(services, project)({ def: registry.get("project_status")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  return { project, invoke };
}

test("legacy project status keeps its existing single-root meaning", async () => {
  const { invoke } = await fixture(), result = await invoke();
  expect(result.text).toContain("Board: 2 layers"); expect(result.text).toContain("Last DRC: never");
  expect(result.json).not.toHaveProperty("assembly"); expect(result.json).not.toHaveProperty("nativeStatusScope");
});

test("agent status includes explicit sources, repeated instances and links without claiming native compatibility", async () => {
  const { project, invoke } = await fixture();
  await mkdir(join(project.dir, "boards/io"), { recursive: true });
  await writeFile(join(project.dir, "boards/io/board.kicad_pcb"), "local io source");
  await writeFile(join(project.dir, "board.kicad_pcb"), "unrelated root source");
  await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify({
    contract: "fabplane.assembly.v1",
    sources: [{ id: "io", name: "I/O", location: "project", directory: "boards/io" }, { id: "lcd", name: "LCD R2.6", location: "unresolved", provenance: { repository: "https://github.com/example/lcd", ref: "revision", path: "variants/lcd.kicad_pcb" } }],
    instances: [{ id: "left", sourceId: "io", name: "Left I/O" }, { id: "right", sourceId: "io", name: "Right I/O" }, { id: "display", sourceId: "lcd", name: "Display" }],
    connections: [{ id: "ribbon", name: "Ribbon", a: { instanceId: "left", connector: "J1" }, b: { instanceId: "display", connector: "J2" } }],
  }));
  const files = await readdir(project.dir), result = await invoke();
  expect(result.text).toContain("Assembly instances: 3; source boards: 2; declared connections: 1");
  expect(result.text).toContain("Source files available: 1/2. Geometry, schematic parity and connection compatibility are unverified");
  expect(result.text).toContain("Native assembly-member editing is unavailable");
  expect(result.text).toContain("Root project defaults: 2 layers"); expect(result.text).toContain("Root last DRC: never");
  expect(result.json).toMatchObject({ nativeStatusScope: "project-root", assembly: { status: "inspected", editing: "unavailable", membership: { mode: "assembly", sources: [{ status: "available", pcbPath: "boards/io/board.kicad_pcb" }, { status: "unresolved" }] } } });
  expect(await readdir(project.dir)).toEqual(files);
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("unrelated root source");
});

test("invalid and dangling assembly declarations remain unavailable instead of becoming a root board", async () => {
  const { project, invoke } = await fixture();
  const path = join(project.dir, "fabplane.assembly.json"); await writeFile(path, "{}");
  for (const dangling of [false, true]) {
    if (dangling) { await rm(path); await symlink("absent.json", path); }
    const result = await invoke();
    expect(result.json).toMatchObject({ nativeStatusScope: "project-root", assembly: { status: "unavailable", editing: "unavailable" } });
    expect(result.text).toContain("Assembly membership could not be verified");
    expect(result.text).toContain("project-root status does not describe its member boards");
    expect(result.text).not.toContain("Source files available");
  }
});

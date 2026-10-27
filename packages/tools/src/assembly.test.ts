import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ASSEMBLY_MANIFEST_PATH, ProjectBoardSources } from "@fabdesk/protocol";
import { inspectProjectBoardSources } from "./assembly";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const dir = await realpath(await mkdtemp(join(tmpdir(), "fabplane-assembly-"))); roots.push(dir); return { id: "project", dir }; }
const local = (id: string) => ({ id, name: id, location: "project", directory: `boards/${id}` });
function assembly(sources: unknown[]) { return { contract: "fabplane.assembly.v1", sources, instances: sources.map((s, i) => ({ id: `instance-${i}`, sourceId: (s as { id: string }).id, name: `Board ${i}` })), connections: [] }; }
async function manifest(dir: string, sources: unknown[]) { await writeFile(join(dir, ASSEMBLY_MANIFEST_PATH), JSON.stringify(assembly(sources))); }
async function board(dir: string, id: string) { await mkdir(join(dir, "boards", id), { recursive: true }); await writeFile(join(dir, "boards", id, "board.kicad_pcb"), `(kicad_pcb (generator "${id}"))`); }

test("legacy root remains a single board and inspection writes nothing", async () => {
  const project = await fixture(); await writeFile(join(project.dir, "board.kicad_pcb"), "root source");
  const before = await readdir(project.dir), result = await inspectProjectBoardSources(project);
  expect(ProjectBoardSources.safeParse(result).success).toBe(true);
  expect(result.mode).toBe("single"); expect(result.assembly).toBeNull(); expect(result.editing).toBe("single-board-only");
  expect(result.sources[0]?.pcbSha256).toBe(createHash("sha256").update("root source").digest("hex"));
  expect(await readdir(project.dir)).toEqual(before); expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("root source");
});
test("only declared sources appear; repeated instances do not duplicate editable sources", async () => {
  const project = await fixture(); await board(project.dir, "io"); await board(project.dir, "lcd"); await board(project.dir, "historical");
  await mkdir(join(project.dir, "boards/io/renders")); await writeFile(join(project.dir, "boards/io/renders/pcb.svg"), "<svg/>");
  const value = assembly([local("io"), local("lcd")]); value.instances.push({ id: "io-second", sourceId: "io", name: "Second I/O" });
  await writeFile(join(project.dir, ASSEMBLY_MANIFEST_PATH), JSON.stringify(value));
  const result = await inspectProjectBoardSources(project);
  expect(result.mode).toBe("assembly"); expect(result.sources.map(s => s.source.id)).toEqual(["io", "lcd"]);
  expect(result.sources.every(s => s.status === "available")).toBe(true); expect(result.assembly?.instances).toHaveLength(3);
  expect(result.sources[0]?.previewPath).toBe("boards/io/renders/pcb.svg");
  expect(result.sources[0]?.pcbSha256).not.toBe(result.sources[1]?.pcbSha256);
});
test("missing and externally referenced members stay explicit without fetching or creating files", async () => {
  const project = await fixture(); await manifest(project.dir, [local("missing"), { id: "carrier", name: "Carrier", location: "unresolved", provenance: { repository: "https://github.com/example/carrier", ref: "revision", path: "variant/board.kicad_pcb" } }]);
  const result = await inspectProjectBoardSources(project);
  expect(result.sources.map(s => s.status)).toEqual(["missing", "unresolved"]); expect(await readdir(project.dir)).toEqual([ASSEMBLY_MANIFEST_PATH]);
});
test("invalid or oversized manifests fail instead of falling back to an unrelated root board", async () => {
  const project = await fixture(); await writeFile(join(project.dir, "board.kicad_pcb"), "unrelated");
  for (const content of ["{", JSON.stringify(assembly([{ ...local("io"), directory: "../escape" }])), " ".repeat(512 * 1024 + 1)]) {
    await writeFile(join(project.dir, ASSEMBLY_MANIFEST_PATH), content);
    await expect(inspectProjectBoardSources(project)).rejects.toThrow(/manifest|fabplane.assembly/);
  }
});
test("source directory and PCB symlink aliases cannot become independent editable sources", async () => {
  const project = await fixture(); await board(project.dir, "io");
  await symlink(join(project.dir, "boards/io"), join(project.dir, "boards/alias"));
  await mkdir(join(project.dir, "boards/file-alias")); await symlink(join(project.dir, "boards/io/board.kicad_pcb"), join(project.dir, "boards/file-alias/board.kicad_pcb"));
  const outside = await fixture(); await board(outside.dir, "private"); await symlink(join(outside.dir, "boards/private"), join(project.dir, "boards/outside"));
  await manifest(project.dir, [local("io"), local("alias"), local("file-alias"), local("outside")]);
  const result = await inspectProjectBoardSources(project);
  expect(result.sources.map(s => s.status)).toEqual(["available", "blocked", "blocked", "blocked"]);
  expect(result.sources.slice(1).every(s => s.pcbSha256 === undefined && s.pcbPath === undefined)).toBe(true);
});
test("hard-linked native files block both owners and symbolic or dangling manifests fail closed", async () => {
  const project = await fixture(); await board(project.dir, "io"); await mkdir(join(project.dir, "boards/alias"));
  await link(join(project.dir, "boards/io/board.kicad_pcb"), join(project.dir, "boards/alias/board.kicad_pcb"));
  await manifest(project.dir, [local("io"), local("alias")]);
  expect((await inspectProjectBoardSources(project)).sources.map(s => s.status)).toEqual(["blocked", "blocked"]);
  await rm(join(project.dir, ASSEMBLY_MANIFEST_PATH)); await symlink("missing.json", join(project.dir, ASSEMBLY_MANIFEST_PATH));
  await expect(inspectProjectBoardSources(project)).rejects.toThrow("manifest");
});

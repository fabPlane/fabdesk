import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, realpath, rm, rename, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProjectBoardSources } from "@fabdesk/tools";
import { assertNativeBoardOwnership, resolveNativeBoardBinding, withNativeBoardBinding } from "../src/assembly-board-binding";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fabplane-board-binding-"))); roots.push(dir);
  for (const id of ["a", "b"]) { await mkdir(join(dir, "boards", id), { recursive: true }); await writeFile(join(dir, "boards", id, "board.kicad_pcb"), `native ${id}`); }
  const manifest = { contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: ["a", "b"].map(id => ({ id, name: id, sourceId: id })), connections: [] };
  await writeFile(join(dir, "fabplane.assembly.json"), JSON.stringify(manifest));
  const project = { id: "project", dir }, inspection = await inspectProjectBoardSources(project);
  return { project, manifest, selector: { sourceId: "a", manifestSha256: inspection.manifestSha256! } };
}

test("one captured source stays immutable when caller selector or project objects change", async () => {
  const { project, selector } = await fixture(), binding = await resolveNativeBoardBinding(project, selector);
  const captured = binding.boardDir; selector.sourceId = "b"; selector.manifestSha256 = "0".repeat(64); project.dir += "/elsewhere";
  expect(Object.isFrozen(binding)).toBe(true); expect(binding.sourceId).toBe("a");
  await withNativeBoardBinding(binding, () => assertNativeBoardOwnership(captured));
  await expect(withNativeBoardBinding(binding, () => assertNativeBoardOwnership(join(binding.rootDir, "boards/b")))).rejects.toThrow("ownership changed");
});
test("stale membership and undeclared sources reject before any native operation", async () => {
  const { project, selector } = await fixture();
  await expect(resolveNativeBoardBinding(project, { ...selector, manifestSha256: "0".repeat(64) })).rejects.toThrow("membership changed");
  await expect(resolveNativeBoardBinding(project, { ...selector, sourceId: "missing" })).rejects.toThrow("source is missing");
});
test("manifest retargeting after binding prevents the pre-save callback", async () => {
  const { project, selector, manifest } = await fixture(), binding = await resolveNativeBoardBinding(project, selector);
  let saved = false;
  await expect(withNativeBoardBinding(binding, async () => {
    manifest.sources[0]!.directory = "boards/b";
    await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify(manifest));
    await assertNativeBoardOwnership(binding.boardDir); saved = true;
  })).rejects.toThrow("ownership changed");
  expect(saved).toBe(false);
});
test("directory replacement and new source aliases invalidate ownership", async () => {
  for (const kind of ["directory", "symlink", "hardlink"] as const) {
    const { project, selector } = await fixture(), binding = await resolveNativeBoardBinding(project, selector), pcb = join(binding.boardDir, "board.kicad_pcb");
    if (kind === "directory") { await rename(binding.boardDir, `${binding.boardDir}-old`); await mkdir(binding.boardDir); await writeFile(pcb, "replacement"); }
    if (kind === "symlink") { await rm(pcb); await symlink(join(project.dir, "boards/b/board.kicad_pcb"), pcb); }
    if (kind === "hardlink") await link(pcb, join(project.dir, "alias.kicad_pcb"));
    await expect(binding.assertCurrent(binding.boardDir)).rejects.toThrow("ownership changed");
  }
});
test("concurrent and nested async operations retain their own source scope", async () => {
  const { project, selector } = await fixture(), a = await resolveNativeBoardBinding(project, selector), b = await resolveNativeBoardBinding(project, { ...selector, sourceId: "b" });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withNativeBoardBinding(a, async () => { await gate; await assertNativeBoardOwnership(a.boardDir); await expect(assertNativeBoardOwnership(b.boardDir)).rejects.toThrow("ownership changed"); });
  const second = withNativeBoardBinding(b, async () => { await assertNativeBoardOwnership(b.boardDir); await withNativeBoardBinding(a, () => assertNativeBoardOwnership(a.boardDir)); await assertNativeBoardOwnership(b.boardDir); release(); });
  await Promise.all([first, second]);
  await assertNativeBoardOwnership("legacy-unscoped-directory");
});
test("a queued operation cannot start after the captured declaration changes", async () => {
  const { project, selector, manifest } = await fixture(), binding = await resolveNativeBoardBinding(project, selector);
  await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify({ ...manifest, connections: [] }, null, 2));
  let ran = false;
  await expect(withNativeBoardBinding(binding, async () => { ran = true; })).rejects.toThrow("ownership changed");
  expect(ran).toBe(false);
});

test("native project and library companion aliases also block a captured save", async () => {
  for (const filename of ["board.kicad_sch", "board.kicad_pro", "fp-lib-table", "sym-lib-table"]) {
    const { project, selector } = await fixture(), binding = await resolveNativeBoardBinding(project, selector);
    const other = join(project.dir, "shared-companion"); await writeFile(other, "shared");
    await symlink(other, join(binding.boardDir, filename));
    await expect(binding.assertCurrent(binding.boardDir)).rejects.toThrow("ownership changed");
    await expect(resolveNativeBoardBinding(project, selector)).rejects.toThrow("ownership changed");
  }
});

import { describe, test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat, symlink, link, chmod, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { OutputTrash } from "../src/output-trash";
import { tempProject } from "../../../packages/tools/test/mock-services";
import type { ProjectHandle } from "@fabdesk/tools";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(busy: (id: string) => string | null = () => null) {
  const project = await tempProject("output-trash"); roots.push(dirname(project.dir));
  await writeFile(join(project.dir, "board.kicad_pcb"), "native PCB source");
  await writeFile(join(project.dir, "board.kicad_sch"), "native schematic source");
  const trash = new OutputTrash(busy);
  const put = async (path: string, value = "output bytes") => { await mkdir(dirname(join(project.dir, path)), { recursive: true }); await writeFile(join(project.dir, path), value); };
  return { project, trash, put };
}
async function selected(trash: OutputTrash, project: ProjectHandle, paths: string[]) {
  return (await trash.review(project, paths)).files.filter(row => row.eligible).map(row => ({ path: row.path, token: row.token! }));
}

describe("recoverable output trash", () => {
  test("moves only the reviewed format and restores exact bytes; sources, other formats and receipts remain", async () => {
    const { project, trash, put } = await fixture();
    await put("exports/product-video.mp4", "movie"); await put("exports/product-video.gif", "gif"); await put("renders/top.png", "top");
    const before = await readFile(join(project.dir, "board.kicad_pcb"));
    const moved = await trash.move(project, await selected(trash, project, ["exports/product-video.mp4"]));
    expect(moved).toMatchObject([{ path: "exports/product-video.mp4", ok: true }]);
    expect(await lstat(join(project.dir, "exports/product-video.mp4")).catch(() => null)).toBeNull();
    expect(await readFile(join(project.dir, "exports/product-video.gif"), "utf8")).toBe("gif");
    const entries = await trash.list(project); expect(entries).toHaveLength(1); expect(entries[0]!.sha256).toBe(hash("movie"));
    expect(await trash.restore(project, [entries[0]!.id])).toMatchObject([{ ok: true }]);
    expect(await readFile(join(project.dir, "exports/product-video.mp4"), "utf8")).toBe("movie");
    expect(await trash.list(project)).toHaveLength(0); expect(await readFile(join(project.dir, "board.kicad_pcb"))).toEqual(before);
    expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("native schematic source");
  });
  test("mixed selection excludes sources, metadata, aliases, read-only files and private frames without changing selection ownership", async () => {
    const { project, trash, put } = await fixture();
    await put("renders/top.png"); await put("renders/read-only.png"); await chmod(join(project.dir, "renders/read-only.png"), 0o444);
    await put("renders/shared.png"); await link(join(project.dir, "renders/shared.png"), join(project.dir, "external-copy.png"));
    await symlink(join(project.dir, "renders/top.png"), join(project.dir, "renders/alias.png"));
    await put("exports/.product-video-frames/frame-0001.png");
    const review = await trash.review(project, ["renders/top.png", "board.kicad_pcb", "fabdesk.json", "renders/read-only.png", "renders/shared.png", "renders/alias.png", "exports/.product-video-frames/frame-0001.png"]);
    expect(review.files.filter(row => row.eligible).map(row => row.path)).toEqual(["renders/top.png"]);
    expect(review.files.find(row => row.path.endsWith("read-only.png"))!.reason).toContain("Read-only");
    expect(review.files.find(row => row.path.endsWith("alias.png"))!.reason).toContain("protected");
    expect(await readFile(join(project.dir, "renders/top.png"), "utf8")).toBe("output bytes"); // review is read-only
  });
  test("live saved video inputs and package inputs are protected; variants do not cascade into dependencies", async () => {
    const { project, trash, put } = await fixture();
    await put("renders/board.glb", "mesh"); await put("exports/product-video.mp4", "movie"); await put("exports/product-video.gif", "gif");
    await put("exports/product-video.json", JSON.stringify({ revision: { contract: "fabplane.video-input-revision.v1", inputs: [{ path: "renders/board.glb", sha256: hash("mesh") }], outputs: [{ path: "exports/product-video.mp4", sha256: hash("movie") }, { path: "exports/product-video.gif", sha256: hash("gif") }] } }));
    await put("exports/gerbers/board.gtl", "copper"); await put("exports/package.zip", "zip");
    await put("exports/package.zip.revision.json", JSON.stringify({ contract: "fabplane.output-revision.v1", projectId: project.id, artifact: "exports/package.zip", artifactSha256: hash("zip"), basis: "saved-files", inputs: [{ path: "exports/gerbers/board.gtl", sha256: hash("copper") }], generatedAt: new Date().toISOString(), dependencies: "unverified" }));
    const review = await trash.review(project, ["renders/board.glb", "exports/gerbers/board.gtl", "exports/product-video.mp4"]);
    expect(review.files.map(row => row.eligible)).toEqual([false, false, true]); expect(review.files[0]!.reason).toContain("product-video.json");
    await trash.move(project, await selected(trash, project, ["exports/product-video.mp4"]));
    expect((await trash.review(project, ["renders/board.glb"])).files[0]!.eligible).toBe(false); // remaining GIF still depends on mesh
    await trash.move(project, await selected(trash, project, ["exports/product-video.gif"]));
    expect((await trash.review(project, ["renders/board.glb"])).files[0]!.eligible).toBe(true);
    expect(await readFile(join(project.dir, "renders/board.glb"), "utf8")).toBe("mesh");
  });
  test("changed reviewed bytes cause an honest partial failure; successful files remain recoverable", async () => {
    const { project, trash, put } = await fixture(); await put("renders/a.png", "A"); await put("renders/b.png", "B");
    const files = await selected(trash, project, ["renders/a.png", "renders/b.png"]); await put("renders/b.png", "changed B");
    const results = await trash.move(project, files); expect(results.map(row => row.ok)).toEqual([true, false]); expect(results[1]!.reason).toContain("changed");
    expect(await readFile(join(project.dir, "renders/b.png"), "utf8")).toBe("changed B"); expect(await trash.list(project)).toHaveLength(1);
  });
  test("project work blocks review, move and restore, including work starting after confirmation", async () => {
    let active: string | null = null;
    const { project, trash, put } = await fixture(() => active); await put("renders/a.png");
    const files = await selected(trash, project, ["renders/a.png"]); active = "Active project task";
    expect((await trash.review(project, ["renders/a.png"])).files[0]!.reason).toBe(active);
    expect((await trash.move(project, files))[0]!.ok).toBe(false);
    active = null; const moved = await trash.move(project, files); expect(moved[0]!.ok).toBe(true);
    active = "Agent editing source"; expect((await trash.restore(project, [moved[0]!.id!]))[0]).toMatchObject({ ok: false, reason: active });
    expect(await trash.list(project)).toHaveLength(1);
  });
  test("restore never overwrites a regenerated path and rejects changed recovery bytes", async () => {
    const { project, trash, put } = await fixture(); await put("renders/a.png", "old");
    const moved = await trash.move(project, await selected(trash, project, ["renders/a.png"])); const id = moved[0]!.id!;
    await put("renders/a.png", "new");
    expect((await trash.restore(project, [id]))[0]!.reason).toContain("not overwritten"); expect(await readFile(join(project.dir, "renders/a.png"), "utf8")).toBe("new");
    expect(await trash.list(project)).toHaveLength(1);
    await rm(join(project.dir, "renders/a.png")); await writeFile(join(project.dir, ".fabdesk/output-trash", id, "payload"), "tampered");
    expect((await trash.restore(project, [id]))[0]!.reason).toContain("bytes changed");
    expect(await lstat(join(project.dir, "renders/a.png")).catch(() => null)).toBeNull();
  });
  test("source membership changes invalidate confirmation and undeclared nested outputs cannot borrow parent ownership", async () => {
    const { project, trash, put } = await fixture(); await put("boards/a/board.kicad_pcb", "member source"); await put("boards/a/renders/top.png", "member image");
    const assembly = { contract: "fabplane.assembly.v1", sources: [{ id: "a", name: "Board A", location: "project", directory: "boards/a" }], instances: [{ id: "a1", sourceId: "a", name: "A1" }], connections: [] };
    await put("fabplane.assembly.json", JSON.stringify(assembly));
    const files = await selected(trash, project, ["boards/a/renders/top.png"]); expect(files).toHaveLength(1);
    assembly.sources[0]!.name = "Renamed source"; await put("fabplane.assembly.json", JSON.stringify(assembly));
    expect((await trash.move(project, files))[0]!.reason).toContain("ownership changed");
    await put("boards/undeclared/renders/top.png"); expect((await trash.review(project, ["boards/undeclared/renders/top.png"])).files[0]!.eligible).toBe(false);
  });
  test("malformed dependency receipts stop removal and concurrent requests cannot move the same file twice", async () => {
    const { project, trash, put } = await fixture(); await put("renders/a.png");
    const files = await selected(trash, project, ["renders/a.png"]);
    const both = await Promise.all([trash.move(project, files), trash.move(project, files)]); expect(both.flat().filter(row => row.ok)).toHaveLength(1); expect(await trash.list(project)).toHaveLength(1);
    await put("renders/b.png"); await put("exports/product-video.json", "{bad");
    const blocked = (await trash.review(project, ["renders/b.png"])).files[0]!; expect(blocked.eligible).toBe(false); expect(blocked.reason).toContain("dependency review unavailable");
  });
});

test("damaged recovery metadata cannot silently turn a nonempty Trash into an empty result", async () => {
  const { project, trash, put } = await fixture(); await put("renders/a.png", "original");
  const moved = await trash.move(project, await selected(trash, project, ["renders/a.png"]));
  const entry = join(project.dir, ".fabdesk/output-trash", moved[0]!.id!);
  const record = JSON.parse(await readFile(join(entry, "entry.json"), "utf8"));
  record.id = "00000000-0000-4000-8000-000000000000";
  await writeFile(join(entry, "entry.json"), JSON.stringify(record));
  await expect(trash.list(project)).rejects.toThrow("Trash identity mismatch");
  await writeFile(join(entry, "entry.json"), "{broken");
  await expect(trash.list(project)).rejects.toThrow("saved bytes are retained");
  expect(await readFile(join(entry, "payload"), "utf8")).toBe("original");
});

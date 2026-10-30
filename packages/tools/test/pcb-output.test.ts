import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { OutputRevision } from "@fabdesk/protocol";
import { withPcbOutput } from "../src/pcb-output";
import { createRegistry, makeContext } from "../src";
import { mockServices, tempProject } from "./mock-services";
const SAMPLE = join(import.meta.dir, "../../kicad/test/fixtures/stencil-sample.kicad_pcb");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const project = await tempProject("pcb-output"), services = mockServices([project]);
  await cp(SAMPLE, join(project.dir, "board.kicad_pcb"));
  return { project, services, ctx: makeContext({ project, services }), sha: hash(await readFile(join(project.dir, "board.kicad_pcb"))) };
}

test("a source edit during export retains every old output and native edit", async () => {
  const { project, ctx, sha } = await fixture();
  await mkdir(join(project.dir, "exports")); await writeFile(join(project.dir, "exports/positions.csv"), "old");
  await expect(withPcbOutput(ctx, sha, async staged => {
    await mkdir(join(staged.requireProject().dir, "exports"));
    await writeFile(join(staged.requireProject().dir, "exports/positions.csv"), "new");
    await writeFile(join(project.dir, "board.kicad_pcb"), "external source edit");
    return { text: "done" };
  })).rejects.toThrow("PCB changed while exporting");
  expect(await readFile(join(project.dir, "exports/positions.csv"), "utf8")).toBe("old");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("external source edit");
});

test("stale source and output symlink are rejected without replacing a prior export", async () => {
  const { project, ctx } = await fixture(); let ran = false;
  await expect(withPcbOutput(ctx, "0".repeat(64), async () => { ran = true; return { text: "done" }; })).rejects.toThrow("changed before export");
  expect(ran).toBe(false);
  const outside = await tempProject("outside-output");
  await symlink(outside.dir, join(project.dir, "exports"));
  await expect(withPcbOutput(ctx, undefined, async staged => {
    await mkdir(join(staged.requireProject().dir, "exports")); await writeFile(join(staged.requireProject().dir, "exports/file.csv"), "no leak"); return { text: "done" };
  })).rejects.toThrow("symlink");
  expect(await Bun.file(join(outside.dir, "file.csv")).exists()).toBe(false);
});

test("member stencil exports use only the captured leaf and return durable source-qualified paths", async () => {
  const { project: parent, services } = await fixture();
  const dir = join(parent.dir, "boards/io"); await mkdir(dir, { recursive: true }); await cp(SAMPLE, join(dir, "board.kicad_pcb"));
  const board = { sourceId: "io", manifestSha256: "a".repeat(64) }, sha = hash(await readFile(join(dir, "board.kicad_pcb")));
  const leaf = { ...parent, dir, manifest: () => { throw new Error("Parent defaults must not be read"); } };
  const ctx = makeContext({ project: leaf, services, board, runInScope: async operation => operation() });
  const registry = createRegistry(), before = await readFile(join(dir, "board.kicad_pcb"));
  const out = await registry.invoke("export_stencil", { board, expectedSourceSha256: sha }, async () => ctx);
  expect(out.isError).toBeFalsy(); expect(out.text).not.toContain("fabplane-pcb-output-");
  const result = out.json as { path: string; _board: { sourceId: string }; files: string[] };
  expect(result._board.sourceId).toBe("io"); expect(result.path).toBe(join(dir, "exports/stencil/F-Paste.stl"));
  expect(await Bun.file(result.path).exists()).toBe(true);
  expect(await readFile(join(dir, "exports/stencil/F-Paste.json"), "utf8")).not.toContain("fabplane-pcb-output-");
  const receipt = OutputRevision.parse(JSON.parse(await readFile(result.path + ".revision.json", "utf8")));
  expect(receipt.board).toEqual(board); expect(receipt.projectId).toBe(parent.id); expect(receipt.artifact).toBe("exports/stencil/F-Paste.stl");
  expect(receipt.inputs).toEqual([{ path: "board.kicad_pcb", sha256: sha }]); expect(receipt.artifactSha256).toBe(hash(await readFile(result.path)));
  expect(await readFile(join(dir, "board.kicad_pcb"))).toEqual(before);
  expect(await Bun.file(join(parent.dir, "exports/stencil/F-Paste.stl")).exists()).toBe(false);
});

test("ZIP packaging refuses concurrent changes to its saved inputs", async () => {
  const { project, ctx } = await fixture();
  await mkdir(join(project.dir, "exports")); await writeFile(join(project.dir, "exports/positions.csv"), "first");
  await expect(withPcbOutput(ctx, undefined, async staged => {
    await writeFile(join(staged.requireProject().dir, "exports/fabrication.zip"), "zip");
    await writeFile(join(project.dir, "exports/positions.csv"), "new placements"); return { text: "done" };
  }, true)).rejects.toThrow("changed while packaging");
  expect(await Bun.file(join(project.dir, "exports/fabrication.zip")).exists()).toBe(false);
});

test("member video uses only its board, publishes real media and leaves parent outputs intact", async () => {
  const { buildBoxGlb } = await import("@fabdesk/product-video");
  const { project: parent, services } = await fixture();
  const dir = join(parent.dir, "boards/io"); await mkdir(join(dir, "renders"), { recursive: true }); await cp(SAMPLE, join(dir, "board.kicad_pcb"));
  const board = { sourceId: "io", manifestSha256: "b".repeat(64) }, sha = hash(await readFile(join(dir, "board.kicad_pcb")));
  const glb = buildBoxGlb([10, 8, 1.6], [0.1, 0.5, 0.2, 1]);
  await writeFile(join(dir, "renders/board.glb"), glb);
  const { BOARD_MODEL_REVISION_PATH } = await import("@fabdesk/protocol");
  await writeFile(join(dir, BOARD_MODEL_REVISION_PATH), JSON.stringify({ contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256: sha, artifactSha256: hash(glb), generatedAt: new Date().toISOString(), dependencies: "unverified", boardSource: { projectId: parent.id, ...board }, warnings: [] }));
  const leaf = { ...parent, dir, manifest: () => { throw new Error("Parent metadata must not become member captions"); } };
  const ctx = makeContext({ project: leaf, services, board, runInScope: async operation => operation() });
  const registry = createRegistry();
  const out = await registry.invoke("render_product_video", { board, expectedSourceSha256: sha, formats: ["gif"], width: 80, height: 64, durationSec: 2, fps: 8 }, async () => ctx);
  expect(out.isError).toBeFalsy(); expect(out.text).toContain("16 frames");
  const bytes = await readFile(join(dir, "exports/product-video.gif")); expect(bytes.subarray(0, 3).toString()).toBe("GIF");
  const manifest = JSON.parse(await readFile(join(dir, "exports/product-video.json"), "utf8"));
  expect(manifest.revision.inputs.map((input: { path: string }) => input.path)).toEqual(["renders/board.glb"]);
  expect(manifest.parts).toHaveLength(1); expect(manifest.files.gif).toBe(join(dir, "exports/product-video.gif"));
  expect(await Bun.file(join(parent.dir, "exports/product-video.gif")).exists()).toBe(false);
});

test("native image rendering keeps the previous PNG when a saved PCB changes mid-render", async () => {
  const { project, services, ctx } = await fixture();
  await mkdir(join(project.dir, "renders")); await writeFile(join(project.dir, "renders/top.png"), "previous image");
  services.kicad.renderPng = async (_cli, input) => { await writeFile(input.output, "new image"); await writeFile(join(project.dir, "board.kicad_pcb"), "external edit"); };
  const registry = createRegistry();
  await expect(registry.invoke("render_board", {}, async () => ctx)).rejects.toThrow("previous image was kept");
  expect(await readFile(join(project.dir, "renders/top.png"), "utf8")).toBe("previous image");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("external edit");
});


test("packaged output provenance tracks saved manufacturing files and excludes metadata", async () => {
  const { project, ctx } = await fixture();
  await mkdir(join(project.dir, "exports/gerbers"), { recursive: true });
  await writeFile(join(project.dir, "exports/gerbers/F_Cu.gbr"), "gerber");
  await writeFile(join(project.dir, "exports/gerbers/F_Cu.gbr.revision.json"), "metadata");
  const out = await createRegistry().invoke("export_zip", {}, async () => ctx);
  expect(out.isError).toBeFalsy(); expect((out.json as { files: string[] }).files).toEqual(["gerbers/F_Cu.gbr"]);
  const receipt = OutputRevision.parse(JSON.parse(await readFile(join(project.dir, "exports/fabrication.zip.revision.json"), "utf8")));
  expect(receipt.basis).toBe("saved-files"); expect(receipt.inputs).toEqual([{ path: "exports/gerbers/F_Cu.gbr", sha256: hash(Buffer.from("gerber")) }]);
  expect(receipt.artifactSha256).toBe(hash(await readFile(join(project.dir, "exports/fabrication.zip"))));
});

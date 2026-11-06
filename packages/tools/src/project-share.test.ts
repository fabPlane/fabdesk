import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { prepareProjectShare } from "./project-share";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "share-snapshot-")));
  roots.push(dir);
  await mkdir(join(dir, "renders"));
  await mkdir(join(dir, "reports"));
  await writeFile(join(dir, "board.kicad_pcb"), "native secret");
  await writeFile(
    join(dir, "renders/pcb.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  );
  await writeFile(join(dir, "NOTES.md"), "private notes");
  await writeFile(join(dir, "fabdesk.json"), '{"credentials":"private"}');
  return { id: "local-project", name: "Controller", dir };
}
const rasterize = async () => ({ png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
test("publishes an explicit summary without source files, raw findings, notes or paths", async () => {
  const project = await fixture();
  await writeFile(
    join(project.dir, "reports/drc.json"),
    JSON.stringify({
      pcbRevision: {
        sha256: createHash("sha256").update("native secret").digest("hex"),
        bytes: 13,
      },
      violations: [{ description: "private path /Users/test/source" }],
      unconnected_items: [],
    }),
  );
  const snapshot = await prepareProjectShare(project, rasterize);
  expect(snapshot.boards[0]?.checks).toEqual({ state: "source-unchanged", findingCount: 1 });
  expect(snapshot.boards[0]?.preview?.contentType).toBe("image/png");
  const json = JSON.stringify(snapshot);
  for (const secret of [
    project.dir,
    "native secret",
    "private notes",
    "credentials",
    "/Users/test/source",
    "board.kicad_pcb",
  ])
    expect(json.includes(secret)).toBe(false);
});
test("malformed reports cannot be presented as clean", async () => {
  const project = await fixture();
  await writeFile(join(project.dir, "reports/drc.json"), "{}");
  expect((await prepareProjectShare(project, rasterize)).boards[0]?.checks).toEqual({
    state: "unverified",
    findingCount: null,
  });
});
test("rejects a source or output changing during capture", async () => {
  const project = await fixture();
  await expect(
    prepareProjectShare(project, async () => {
      await writeFile(join(project.dir, "board.kicad_pcb"), "changed");
      return rasterize();
    }),
  ).rejects.toThrow("Board sources changed");
  await expect(
    prepareProjectShare(project, async () => {
      await writeFile(join(project.dir, "renders/pcb.svg"), "changed");
      return rasterize();
    }),
  ).rejects.toThrow("Saved previews or checks changed");
});
test("rejects preview aliases rather than publishing another file's bytes", async () => {
  const project = await fixture();
  await rm(join(project.dir, "renders/pcb.svg"));
  await symlink(join(project.dir, "NOTES.md"), join(project.dir, "renders/pcb.svg"));
  await expect(prepareProjectShare(project, rasterize)).rejects.toThrow();
});
test("only declared assembly sources appear, with unavailable members kept explicit", async () => {
  const project = await fixture();
  await writeFile(
    join(project.dir, "fabplane.assembly.json"),
    JSON.stringify({
      contract: "fabplane.assembly.v1",
      sources: [
        { id: "missing", name: "Adapter", location: "project", directory: "boards/missing" },
      ],
      instances: [{ id: "adapter", name: "Adapter", sourceId: "missing" }],
      connections: [],
    }),
  );
  const snapshot = await prepareProjectShare(project, rasterize);
  expect(snapshot.boards.map((b) => b.id)).toEqual(["missing"]);
  expect(snapshot.boards[0]?.preview).toBeNull();
  expect(snapshot.boards[0]?.sourceAvailable).toBe(false);
});

test("publishes only sanitized saved GLB geometry and detects a model changing during capture", async () => {
  const { modelFixture } = await import("../test/shared-glb-fixture");
  const project = await fixture();
  await writeFile(join(project.dir, "renders/board.glb"), modelFixture());
  const snapshot = await prepareProjectShare(project, rasterize);
  expect(snapshot.boards[0]?.model?.contentType).toBe("model/gltf-binary");
  const model = Buffer.from(snapshot.boards[0]!.model!.dataBase64, "base64");
  expect(model.toString()).not.toContain("private");
  await expect(
    prepareProjectShare(project, async () => {
      await writeFile(join(project.dir, "renders/board.glb"), "changed");
      return rasterize();
    }),
  ).rejects.toThrow("Saved previews or checks changed");
});
test("a malformed model cannot publish an otherwise valid snapshot", async () => {
  const project = await fixture();
  await writeFile(join(project.dir, "renders/board.glb"), "not a model");
  await expect(prepareProjectShare(project, rasterize)).rejects.toThrow("saved 3D model");
});

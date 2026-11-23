import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/projects";

test("a bounded project listing keeps the root and declared member designs, previews and downloadable outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-board-list-"));
  try {
    await mkdir(join(root, "000-vendor"));
    for (let i = 0; i < 20; i++) await writeFile(join(root, "000-vendor", String(i)), "");
    const source = { id: "io", name: "IO", location: "project", directory: "boards/io" };
    await writeFile(join(root, "fabplane.assembly.json"), JSON.stringify({
      contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "one", sourceId: "io", name: "IO" }],
    }));
    const expected = [];
    for (const prefix of ["", "boards/io/"]) {
      await mkdir(join(root, prefix, "renders"), { recursive: true });
      await mkdir(join(root, prefix, "exports"), { recursive: true });
      for (const name of ["board.kicad_pcb", "board.kicad_sch", "renders/pcb.svg", "renders/board.glb", "renders/board-layers.json", "exports/product-video.webm"]) {
        expected.push(prefix + name);
        await writeFile(join(root, prefix, name), "fixture");
      }
    }
    const files = await ProjectStore.prototype.listFiles(root, 16);
    expect(files).toHaveLength(16);
    expect(files.map(file => file.path)).toEqual(expect.arrayContaining(expected));
    expect(new Set(files.map(file => file.path)).size).toBe(16);
  } finally { await rm(root, { recursive: true, force: true }); }
});

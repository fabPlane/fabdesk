import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleScene, discoverMeshFiles } from "../src/scene";
import { buildBoxGlb, buildBoxStl } from "../src/fixture";
import { loadGlb } from "../src/glb";

describe("scene assembly", () => {
  test("discovers board GLB and enclosure STL, skips product-video outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-scene-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "renders", "board.glb"), buildBoxGlb());
    await writeFile(join(dir, "exports", "enclosure.stl"), buildBoxStl());
    await writeFile(join(dir, "exports", "product-video.gif"), "not-a-mesh");
    const files = await discoverMeshFiles(dir);
    expect(files.some((f) => f.endsWith("board.glb"))).toBe(true);
    expect(files.some((f) => f.endsWith("enclosure.stl"))).toBe(true);
    expect(files.some((f) => f.includes("product-video"))).toBe(false);
    const scene = await assembleScene(dir);
    expect(scene.parts).toHaveLength(2);
    expect(scene.parts[0]?.role).toBe("board");
    expect(scene.parts[1]?.role).toBe("mechanical");
    expect(scene.parts[0]!.triangles.length).toBeGreaterThan(0);
    expect(scene.parts[1]!.triangles.length).toBeGreaterThan(0);
    expect(Number.isFinite(scene.bounds.min.x)).toBe(true);
    expect(Number.isFinite(scene.bounds.max.x)).toBe(true);
    expect(scene.bounds.max.x).toBeGreaterThan(scene.bounds.min.x);
    expect(scene.bounds.max.x - scene.bounds.min.x).toBeGreaterThan(5);
  });

  test("loadGlb reads the fixture box", () => {
    const part = loadGlb(buildBoxGlb([0.1, 0.8, 0.2, 1]), "box", "renders/board.glb", "board");
    expect(part.triangles.length).toBe(12);
    expect(part.triangles[0]!.color[1]).toBeCloseTo(0.8, 5);
  });
});

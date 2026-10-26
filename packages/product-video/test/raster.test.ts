import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoxGlb, buildBoxStl, fixtureScene } from "../src/fixture";
import { samplePreset } from "../src/presets";
import { paintedPixels, renderFrame } from "../src/raster";
import { assembleScene } from "../src/scene";

describe("software rasterizer", () => {
  test("paints the fixture board against a light background", () => {
    const scene = fixtureScene();
    const pose = samplePreset("orbit", 0.12, scene);
    const buf = renderFrame(scene, pose, 160, 90, "light");
    expect(buf.data.length).toBe(160 * 90 * 4);
    expect(paintedPixels(buf, "light")).toBeGreaterThan(200);
  });

  test("explode changes which pixels are covered", () => {
    const scene = fixtureScene();
    const assembled = renderFrame(scene, samplePreset("explode", 1, scene), 120, 80, "dark");
    const exploded = renderFrame(scene, samplePreset("explode", 0, scene), 120, 80, "dark");
    expect(paintedPixels(assembled, "dark")).toBeGreaterThan(80);
    expect(paintedPixels(exploded, "dark")).toBeGreaterThan(80);
    // Both parts stay in frame when exploded (not just a sliver at the edge).
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < exploded.height; y++) {
      for (let x = 0; x < exploded.width; x++) {
        const i = (y * exploded.width + x) * 4;
        const painted =
          exploded.data[i] !== 18 || exploded.data[i + 1] !== 20 || exploded.data[i + 2] !== 26;
        if (!painted) continue;
        if (y < exploded.height / 2) top++;
        else bottom++;
      }
    }
    expect(top).toBeGreaterThan(20);
    expect(bottom).toBeGreaterThan(20);
  });

  test("flip mid-frame still paints when the camera looks straight down", () => {
    const scene = fixtureScene();
    const buf = renderFrame(scene, samplePreset("flip", 0.5, scene), 120, 80, "dark");
    expect(paintedPixels(buf, "dark")).toBeGreaterThan(80);
  });

  test("assembled GLB + STL paints the same way as the in-memory fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-ras-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "renders", "board.glb"), buildBoxGlb());
    await writeFile(join(dir, "exports", "enclosure.stl"), buildBoxStl());
    const scene = await assembleScene(dir);
    const buf = renderFrame(scene, samplePreset("orbit", 0.2, scene), 160, 90, "light");
    expect(paintedPixels(buf, "light")).toBeGreaterThan(200);
  });
});

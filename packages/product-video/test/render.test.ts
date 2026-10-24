import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBoxGlb, buildBoxStl } from "../src/fixture";
import { paintedPixels } from "../src/raster";
import { renderProductVideo, renderSceneFrames } from "../src/render";
import { assembleScene } from "../src/scene";

describe("product video render", () => {
  test("low-res orbit smoke: GIF + poster + manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-render-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "renders", "board.glb"), buildBoxGlb());
    await writeFile(join(dir, "exports", "enclosure.stl"), buildBoxStl());
    const out = await renderProductVideo({
      projectDir: dir,
      outputDir: join(dir, "exports"),
      preset: "orbit",
      durationSec: 2,
      fps: 8,
      resolution: "720p",
      aspect: "landscape",
      background: "light",
      captions: true,
      formats: ["gif"],
      specs: { name: "Demo Board", lines: ["2 LAYERS", "50 MM × 30 MM"] },
      width: 160,
      height: 90,
    });
    expect(out.frameCount).toBe(16);
    expect(out.width).toBe(160);
    expect(out.files.gif && (await Bun.file(out.files.gif).exists())).toBe(true);
    expect(await Bun.file(out.poster).exists()).toBe(true);
    const manifest = JSON.parse(await Bun.file(out.manifest).text()) as { parts: unknown[] };
    expect(manifest.parts).toHaveLength(2);
    expect(new TextDecoder().decode((await Bun.file(out.files.gif!).arrayBuffer()).slice(0, 6))).toBe("GIF89a");
  });

  test("a width-only override derives height from the selected aspect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-size-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await writeFile(join(dir, "renders", "board.glb"), buildBoxGlb());
    const out = await renderProductVideo({
      projectDir: dir,
      outputDir: join(dir, "exports"),
      preset: "orbit",
      durationSec: 2,
      fps: 8,
      resolution: "720p",
      aspect: "landscape",
      background: "light",
      captions: false,
      formats: ["gif"],
      specs: { name: "Demo Board", lines: [] },
      width: 160,
    });
    expect(out.width).toBe(160);
    expect(out.height).toBe(90);
  });

  test("review frames include a painted title card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-rev-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await writeFile(join(dir, "renders", "board.glb"), buildBoxGlb());
    const scene = await assembleScene(dir);
    const frames = await renderSceneFrames(scene, {
      preset: "review",
      durationSec: 2,
      fps: 8,
      resolution: "720p",
      aspect: "square",
      background: "dark",
      captions: true,
      specs: { name: "Demo", lines: ["2 LAYERS"] },
      width: 120,
      height: 120,
    });
    expect(frames.length).toBe(16);
    expect(paintedPixels(frames[0]!, "dark")).toBeGreaterThan(100);
    expect(paintedPixels(frames[8]!, "dark")).toBeGreaterThan(100);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const manifest = JSON.parse(await Bun.file(out.manifest).text()) as { parts: unknown[]; revision: { inputs: Array<{path: string; sha256: string}>; outputs: Array<{path: string; sha256: string}> } };
    expect(manifest.parts).toHaveLength(2);
    const boardInput = manifest.revision.inputs.find(row => row.path === "renders/board.glb");
    expect(boardInput?.sha256).toBe(createHash("sha256").update(buildBoxGlb()).digest("hex"));
    expect(manifest.revision.outputs).toEqual([{ path: "exports/product-video.gif", sha256: createHash("sha256").update(await Bun.file(out.files.gif!).bytes()).digest("hex") }]);
    expect(new TextDecoder().decode((await Bun.file(out.files.gif!).arrayBuffer()).slice(0, 6))).toBe("GIF89a");
  });

  for (const mode of ["changed-model", "cancelled", "failure", "all-formats-skipped"] as const) test(`${mode} keeps all previously saved video files and receipt`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-preserve-")), controller = new AbortController();
    await mkdir(join(dir, "renders"), { recursive: true }); await mkdir(join(dir, "exports"));
    await writeFile(join(dir, "renders/board.glb"), buildBoxGlb());
    const protectedPaths = ["product-video.gif", "product-video.mp4", "product-video-poster.png", "product-video.json"];
    for (const path of protectedPaths) await writeFile(join(dir, "exports", path), `previous ${path}`);
    let changed = false;
    try {
      await expect(renderProductVideo({ projectDir: dir, outputDir: join(dir, "exports"), preset: "orbit", durationSec: 2, fps: 8, resolution: "720p", aspect: "landscape", background: "light", captions: false, formats: ["gif"], specs: { name: "Board", lines: [] }, width: 80, height: 64, signal: controller.signal, ...(mode === "all-formats-skipped" ? { formats: ["mp4"], ffmpegPath: join(dir, "missing-ffmpeg") } : {}),
        progress: (_fraction, note) => {
          if (!changed && note?.startsWith("frame ")) {
            changed = true;
            if (mode === "changed-model") writeFileSync(join(dir, "renders/board.glb"), "changed after decode");
            if (mode === "failure") throw Error("simulated renderer failure");
          }
          // Cancellation after encoding must still leave prior completed outputs intact.
          if (mode === "cancelled" && note === "done") controller.abort();
        },
      })).rejects.toThrow();
      expect(changed).toBe(true);
      for (const path of protectedPaths) expect(await readFile(join(dir, "exports", path), "utf8")).toBe(`previous ${path}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("a skipped optional encoder preserves its older format and publishes an honest new receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-partial-"));
    await mkdir(join(dir, "renders")); await mkdir(join(dir, "exports"));
    await writeFile(join(dir, "renders/board.glb"), buildBoxGlb()); await writeFile(join(dir, "exports/product-video.mp4"), "earlier MP4");
    try {
      const out = await renderProductVideo({ projectDir: dir, outputDir: join(dir, "exports"), preset: "orbit", durationSec: 2, fps: 8, resolution: "720p", aspect: "landscape", background: "light", captions: false, formats: ["gif", "mp4"], ffmpegPath: join(dir, "missing-ffmpeg"), specs: { name: "Board", lines: [] }, width: 80, height: 64 });
      expect(out.files.gif).toBe(join(dir, "exports/product-video.gif"));
      expect(out.files.mp4).toBeUndefined(); expect(out.skipped[0]?.format).toBe("mp4");
      expect(await readFile(join(dir, "exports/product-video.mp4"), "utf8")).toBe("earlier MP4");
      const manifest = JSON.parse(await readFile(out.manifest, "utf8"));
      expect(manifest.files.gif).toBe(out.files.gif); expect(manifest.poster).toBe(out.poster);
      expect(manifest.revision.outputs.map((row: {path: string}) => row.path)).toEqual(["exports/product-video.gif"]);
      expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("concurrent writers to the same output directory cannot mix source records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-writer-"));
    await mkdir(join(dir, "renders"), { recursive: true });
    await writeFile(join(dir, "renders/board.glb"), buildBoxGlb());
    const options = { projectDir: dir, outputDir: join(dir, "exports"), preset: "orbit" as const, durationSec: 2, fps: 8, resolution: "720p" as const, aspect: "landscape" as const, background: "light" as const, captions: false, formats: ["gif" as const], specs: { name: "Board", lines: [] }, width: 80, height: 64 };
    const first = renderProductVideo(options);
    await expect(renderProductVideo(options)).rejects.toThrow("already running");
    await first;
    // Completion releases the writer, so deliberate regeneration remains available.
    expect((await renderProductVideo(options)).frameCount).toBe(16);
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

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { paintCaptions } from "./captions";
import { encodeOutputs } from "./encode";
import { samplePreset } from "./presets";
import { renderFrame } from "./raster";
import { assembleScene } from "./scene";
import type { ProductScene, RenderOptions, RenderOutputs } from "./types";
import { frameSize } from "./types";

function sizeOf(opts: Pick<RenderOptions, "resolution" | "aspect" | "width" | "height">): { width: number; height: number } {
  const preset = frameSize(opts.resolution, opts.aspect);
  if (opts.width && opts.height) return { width: opts.width, height: opts.height };
  if (opts.width) {
    const height = Math.max(64, Math.round(opts.width * (preset.height / preset.width)));
    return { width: opts.width, height };
  }
  if (opts.height) {
    const width = Math.max(64, Math.round(opts.height * (preset.width / preset.height)));
    return { width, height: opts.height };
  }
  return preset;
}

const activeOutputs = new Set<string>();

/** One writer per output directory prevents concurrent exports from mixing their source records and files. */
export async function renderProductVideo(opts: RenderOptions): Promise<RenderOutputs> {
  const key = resolve(opts.outputDir);
  if (activeOutputs.has(key)) throw new Error("A video export is already running for these outputs. Wait for it to finish before making another video.");
  activeOutputs.add(key);
  try { return await renderVideo(opts); }
  finally { activeOutputs.delete(key); }
}

async function renderVideo(opts: RenderOptions): Promise<RenderOutputs> {
  const { width, height } = sizeOf(opts);
  const fps = Math.max(8, Math.min(30, Math.round(opts.fps)));
  const duration = Math.max(2, Math.min(20, opts.durationSec));
  const frameCount = Math.max(4, Math.round(duration * fps));
  opts.progress?.(0.05, "assembling scene");
  const scene = await assembleScene(opts.projectDir);
  if (!scene.parts.length) {
    throw new Error(
      "no 3D meshes found: export renders/board.glb (render_glb) and any enclosure STL/GLB under exports/, cad/, mechanical/ or enclosure/",
    );
  }
  throwIfAborted(opts.signal);
  opts.progress?.(0.12, `rendering ${frameCount} frames`);
  await mkdir(opts.outputDir, { recursive: true });
  opts.progress?.(0.12, "encoding");
  const encoded = await encodeOutputs({
    frameCount,
    writeFrames: async (emit) => {
      for (let i = 0; i < frameCount; i++) {
        throwIfAborted(opts.signal);
        const t = frameCount === 1 ? 0 : i / (frameCount - 1);
        const pose = samplePreset(opts.preset, t, scene);
        const useCard = opts.captions ? pose : { ...pose, card: 0, cardKind: "none" as const };
        const buf = renderFrame(scene, useCard, width, height, opts.background);
        if (opts.captions) paintCaptions(buf, useCard, opts.specs);
        await emit(buf);
        opts.progress?.(0.12 + (0.7 * (i + 1)) / frameCount, `frame ${i + 1}/${frameCount}`);
      }
    },
    fps,
    outputDir: opts.outputDir,
    basename: "product-video",
    formats: opts.formats,
    transparent: opts.background === "transparent",
    ...(opts.ffmpegPath !== undefined ? { ffmpegPath: opts.ffmpegPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const manifestPath = join(opts.outputDir, "product-video.json");
  const outputs = await Promise.all(Object.values(encoded.files).filter((path): path is string => !!path).map(async path => ({ path: relative(opts.projectDir, path).split(sep).join("/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    revision: {
      contract: "fabplane.video-input-revision.v1",
      inputs: scene.parts.map(part => ({ path: part.path, sha256: part.sourceSha256 })),
      outputs,
    },
    preset: opts.preset,
    durationSec: duration,
    fps,
    width,
    height,
    resolution: opts.resolution,
    aspect: opts.aspect,
    background: opts.background,
    captions: opts.captions,
    specs: opts.specs,
    files: encoded.files,
    poster: encoded.poster,
    skipped: encoded.skipped,
    parts: scene.parts.map((p) => ({ id: p.id, role: p.role, path: p.path, triangles: p.triangles.length })),
    frameCount,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  opts.progress?.(1, "done");
  return {
    files: encoded.files,
    poster: encoded.poster,
    manifest: manifestPath,
    width,
    height,
    frameCount,
    skipped: encoded.skipped,
    parts: manifest.parts,
  };
}

export async function renderSceneFrames(
  scene: ProductScene,
  opts: Pick<RenderOptions, "preset" | "durationSec" | "fps" | "resolution" | "aspect" | "background" | "captions" | "specs" | "width" | "height">,
): Promise<ReturnType<typeof renderFrame>[]> {
  const { width, height } = sizeOf(opts);
  const fps = Math.max(8, Math.min(30, Math.round(opts.fps)));
  const duration = Math.max(2, Math.min(20, opts.durationSec));
  const frameCount = Math.max(4, Math.round(duration * fps));
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const t = frameCount === 1 ? 0 : i / (frameCount - 1);
    const pose = samplePreset(opts.preset, t, scene);
    const useCard = opts.captions ? pose : { ...pose, card: 0, cardKind: "none" as const };
    const buf = renderFrame(scene, useCard, width, height, opts.background);
    if (opts.captions) paintCaptions(buf, useCard, opts.specs);
    frames.push(buf);
  }
  return frames;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("cancelled");
}

import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findFfmpeg, mp4Args, runFfmpeg, webmArgs } from "./ffmpeg";
import { GifEncoder } from "./gif";
import { encodePng } from "./png";
import type { PixelBuffer, VideoFormat } from "./types";

export type EncodeRequest = {
  frames?: PixelBuffer[];
  /** Stream frames one at a time so the renderer can drop each RGBA buffer. */
  writeFrames?: (emit: (frame: PixelBuffer) => Promise<void>) => Promise<void>;
  frameCount?: number;
  fps: number;
  outputDir: string;
  basename: string;
  formats: VideoFormat[];
  transparent: boolean;
  ffmpegPath?: string | null;
  signal?: AbortSignal;
};

export type EncodeResult = {
  files: Partial<Record<VideoFormat, string>>;
  poster: string;
  skipped: Array<{ format: VideoFormat; reason: string }>;
};

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

export async function encodeOutputs(req: EncodeRequest): Promise<EncodeResult> {
  const { fps, outputDir, basename: base, formats, transparent, signal } = req;
  const count = req.frames?.length ?? req.frameCount;
  if ((!req.frames || req.frames.length === 0) && !req.writeFrames) throw new Error("no frames to encode");
  if (count !== undefined && count <= 0) throw new Error("no frames to encode");
  await mkdir(outputDir, { recursive: true });
  const poster = join(outputDir, `${base}-poster.png`);

  const files: EncodeResult["files"] = {};
  const skipped: EncodeResult["skipped"] = [];
  const want = new Set(formats);
  const delayCs = Math.max(2, Math.round(100 / fps));

  const needFfmpeg = want.has("mp4") || want.has("webm");
  let ffmpeg: string | null = null;
  if (needFfmpeg) {
    ffmpeg = await findFfmpeg(req.ffmpegPath);
    if (!ffmpeg) {
      if (want.has("mp4")) skipped.push({ format: "mp4", reason: "ffmpeg not found (install it or set FABDESK_FFMPEG)" });
      if (want.has("webm")) skipped.push({ format: "webm", reason: "ffmpeg not found (install it or set FABDESK_FFMPEG)" });
    }
  }

  const tmp = ffmpeg ? join(outputDir, `.${base}-frames`) : null;
  if (tmp) await mkdir(tmp, { recursive: true });

  const gif: { encoder: GifEncoder | null } = { encoder: null };
  let index = 0;
  const mid = Math.floor((count ?? 1) / 2);
  const emit = async (frame: PixelBuffer) => {
    if (want.has("gif")) {
      gif.encoder ??= new GifEncoder(frame.width, frame.height, delayCs, transparent);
      gif.encoder.addFrame(frame);
    }
    if (tmp) {
      await writeFile(join(tmp, `frame-${String(index).padStart(4, "0")}.png`), encodePng(frame));
    }
    if (index === mid || (count === undefined && index === 0)) {
      await writeFile(poster, encodePng(frame));
    }
    index++;
  };

  try {
    if (req.frames) {
      for (const frame of req.frames) await emit(frame);
    } else if (req.writeFrames) {
      await req.writeFrames(emit);
    }
    if (index === 0) throw new Error("no frames to encode");
    if (count === undefined && index > 1) {
      // Poster was the first frame; leave it. Callers that know the count pass frameCount.
    }

    if (gif.encoder) {
      const path = join(outputDir, `${base}.gif`);
      await writeFile(path, gif.encoder.finish());
      files.gif = path;
    }

    if (ffmpeg && tmp) {
      const pattern = join(tmp, "frame-%04d.png");
      if (want.has("mp4") && !skipped.some((s) => s.format === "mp4")) {
        const path = join(outputDir, `${base}.mp4`);
        const run = await runFfmpeg(ffmpeg, mp4Args(pattern, fps, path), signal);
        if (run.ok) files.mp4 = path;
        else {
          skipped.push({ format: "mp4", reason: run.stderr.trim() || "ffmpeg failed" });
          await removeIfPresent(path);
        }
      }
      if (want.has("webm") && !skipped.some((s) => s.format === "webm")) {
        const path = join(outputDir, `${base}.webm`);
        const run = await runFfmpeg(ffmpeg, webmArgs(pattern, fps, path), signal);
        if (run.ok) files.webm = path;
        else {
          skipped.push({ format: "webm", reason: run.stderr.trim() || "ffmpeg failed" });
          await removeIfPresent(path);
        }
      }
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }

  for (const s of skipped) {
    await removeIfPresent(join(outputDir, `${base}.${s.format}`));
  }

  return { files, poster, skipped };
}

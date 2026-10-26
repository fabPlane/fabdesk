import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeOutputs } from "../src/encode";
import { encodeGif } from "../src/gif";
import { createBuffer, clearBuffer } from "../src/raster";
import { encodePng } from "../src/png";

function frames(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const buf = createBuffer(32, 24);
    clearBuffer(buf, [20 + i * 10, 40, 80, 255]);
    return buf;
  });
}

describe("encoders", () => {
  test("PNG starts with the PNG signature", () => {
    const buf = createBuffer(8, 8);
    clearBuffer(buf, [10, 20, 30, 255]);
    const png = encodePng(buf);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("GIF is a looping GIF89a", () => {
    const gif = encodeGif(frames(3), 8, false);
    expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(gif.byteLength).toBeGreaterThan(100);
  });

  test("encodeOutputs writes GIF and poster; mocks ffmpeg for MP4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-enc-"));
    const ffmpeg = join(dir, "ffmpeg");
    await writeFile(
      ffmpeg,
      `#!/bin/sh
if [ "$1" = "-version" ]; then
  echo "ffmpeg version mock"
  exit 0
fi
out=""
for a in "$@"; do
  out="$a"
done
printf 'ok' > "$out"
`,
    );
    await chmod(ffmpeg, 0o755);
    const result = await encodeOutputs({
      frames: frames(4),
      fps: 12,
      outputDir: dir,
      basename: "product-video",
      formats: ["gif", "mp4"],
      transparent: false,
      ffmpegPath: ffmpeg,
    });
    expect(result.files.gif && (await Bun.file(result.files.gif).exists())).toBe(true);
    expect(result.files.mp4 && (await Bun.file(result.files.mp4).exists())).toBe(true);
    expect(await Bun.file(result.poster).exists()).toBe(true);
    expect(new TextDecoder().decode(await Bun.file(result.files.gif!).arrayBuffer()).startsWith("GIF89a")).toBe(true);
  });

  test("skips MP4 when ffmpeg is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-skip-"));
    const result = await encodeOutputs({
      frames: frames(2),
      fps: 12,
      outputDir: dir,
      basename: "product-video",
      formats: ["mp4", "gif"],
      transparent: false,
      ffmpegPath: join(dir, "no-such-ffmpeg"),
    });
    expect(result.files.gif).toBeDefined();
    expect(result.files.mp4).toBeUndefined();
    expect(result.skipped.some((s) => s.format === "mp4")).toBe(true);
  });

  test("removes a stale MP4 left by a previous run when ffmpeg is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-pv-stale-"));
    const stale = join(dir, "product-video.mp4");
    await writeFile(stale, "old-mp4");
    const result = await encodeOutputs({
      frames: frames(2),
      fps: 12,
      outputDir: dir,
      basename: "product-video",
      formats: ["mp4", "gif"],
      transparent: false,
      ffmpegPath: join(dir, "no-such-ffmpeg"),
    });
    expect(result.files.mp4).toBeUndefined();
    expect(await Bun.file(stale).exists()).toBe(false);
    expect(result.files.gif && (await Bun.file(result.files.gif).exists())).toBe(true);
  });
});

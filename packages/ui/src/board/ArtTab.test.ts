import { describe, expect, test } from "bun:test";
import { buildSketchPngFile, sketchPngUploadName } from "./art-sketch-upload";

describe("board art sketch upload", () => {
  test("sketchPngUploadName renames JPEG and sketch paths to .png", () => {
    expect(sketchPngUploadName("vacation.jpg")).toBe("vacation.png");
    expect(sketchPngUploadName("sketches/test-art.jpeg")).toBe("test-art.png");
    expect(sketchPngUploadName("photo")).toBe("photo.png");
  });

  test("buildSketchPngFile always produces a PNG file for silk_art", async () => {
    const gray = { width: 2, height: 1, pixels: new Uint8Array([0, 255]) };
    const fakePng = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
      type: "image/png",
    });
    const file = await buildSketchPngFile(gray, "test-art.jpg", async () => fakePng);
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("test-art.png");
    expect(file.size).toBeGreaterThan(0);
    const head = new Uint8Array(await file.arrayBuffer()).slice(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

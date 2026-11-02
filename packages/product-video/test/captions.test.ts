import { describe, expect, test } from "bun:test";
import { paintCaptions, paintSolidCard } from "../src/captions";
import { drawText, fillRect, measureText } from "../src/font";
import { createBuffer } from "../src/raster";
import type { PixelBuffer } from "../src/types";

function textBounds(buf: PixelBuffer): { left: number; right: number; count: number } {
  let left = buf.width;
  let right = -1;
  let count = 0;
  for (let y = 0; y < buf.height; y++) for (let x = 0; x < buf.width; x++) {
    const i = (y * buf.width + x) * 4;
    // Both title and specification ink are bright; card backgrounds are dark.
    if ((buf.data[i] ?? 0) < 240) continue;
    left = Math.min(left, x);
    right = Math.max(right, x);
    count++;
  }
  return { left, right, count };
}

describe("exported video captions", () => {
  const importedName = "VAIO MULTI-BOARD ACCEPTANCE VALIDATION / RH";
  for (const width of [720, 1280]) {
    test(`title and specification cards retain safe margins at ${width}px`, () => {
      for (const kind of ["title", "specs"] as const) {
        for (const name of [importedName, "W".repeat(500)]) {
          const buf = createBuffer(width, 720);
          paintSolidCard(buf, { name, lines: ["M".repeat(500), importedName] }, kind);
          const bounds = textBounds(buf);
          expect(bounds.count).toBeGreaterThan(100);
          expect(bounds.left).toBeGreaterThanOrEqual(32);
          expect(bounds.right).toBeLessThan(width - 32);
        }
      }
    });

    test(`lower-third captions stay inside the ${width}px frame`, () => {
      const buf = createBuffer(width, 720);
      paintCaptions(buf, {
        camera: { eye: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fovY: 1 },
        explode: 0, card: 0, cardKind: "none",
      }, { name: "W".repeat(500), lines: [] });
      const bounds = textBounds(buf);
      expect(bounds.count).toBeGreaterThan(100);
      expect(bounds.left).toBe(16);
      expect(bounds.right).toBeLessThan(width - 26);
      // The caption's dark background also leaves a margin, rather than clipping.
      expect(buf.data[((720 - 35) * width + width - 16) * 4 + 3]).toBe(0);
    });
  }

  test("short title retains its existing size and placement", () => {
    const actual = createBuffer(1280, 720);
    paintSolidCard(actual, { name: "PICO SENSOR", lines: [] }, "title");
    const expected = createBuffer(1280, 720);
    fillRect(expected.data, 1280, 720, 0, 0, 1280, 720, [16, 18, 22, 255]);
    for (const [text, scale, y, color] of [
      ["PICO SENSOR", 5, 720 * 0.42, [248, 246, 240, 255]],
      ["PRODUCT VIDEO", 3, 720 * 0.42 + 35 + 16, [70, 74, 80, 255]],
    ] as const) {
      drawText(expected.data, 1280, 720, text, (1280 - measureText(text, scale).width) / 2, y, scale, [...color]);
    }
    expect(actual.data).toEqual(expected.data);
  });
});

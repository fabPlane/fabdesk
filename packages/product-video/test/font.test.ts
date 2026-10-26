import { describe, expect, test } from "bun:test";
import { drawText, glyphBits } from "../src/font";
import { createBuffer, clearBuffer } from "../src/raster";

describe("caption font", () => {
  test("C keeps its bottom row (would wrap past 32 bits if packed into one number)", () => {
    const rows = glyphBits("C");
    expect(rows).toHaveLength(7);
    expect(rows[6]).toBeGreaterThan(0);
    expect(rows[0]).toBeGreaterThan(0);
  });

  test("PICO SENSOR paints every letter", () => {
    const buf = createBuffer(200, 20);
    clearBuffer(buf, [0, 0, 0, 255]);
    drawText(buf.data, buf.width, buf.height, "PICO SENSOR", 2, 2, 2, [255, 255, 255, 255]);
    let painted = 0;
    for (let i = 0; i < buf.data.length; i += 4) if ((buf.data[i] ?? 0) > 200) painted++;
    expect(painted).toBeGreaterThan(80);
  });
});

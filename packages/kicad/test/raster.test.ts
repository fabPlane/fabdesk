import { describe, expect, test } from "bun:test";
import { rasterizeSvg } from "../src/raster";

describe("rasterizeSvg", () => {
  test("returns viewable PNG pixels with bounded dimensions", async () => {
    const result = await rasterizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#123456"/></svg>',
      { maxWidth: 80 },
    );
    expect([...result.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(result.width).toBe(80);
    expect(result.height).toBe(40);
    expect(result.png.length).toBeGreaterThan(100);
  });
});

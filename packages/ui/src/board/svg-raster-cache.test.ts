import { describe, expect, test } from "bun:test";
import { createSvgRasterCache, svgRasterSize, type RasterSize } from "./svg-raster-cache";

describe("SVG raster sizing", () => {
  test("coalesces nearby pixel sizes and accounts for high DPI", () => {
    expect(svgRasterSize(600, 300, 1)).toEqual({ width: 768, height: 384 });
    expect(svgRasterSize(610, 305, 1)).toEqual(svgRasterSize(600, 300, 1));
    expect(svgRasterSize(600, 300, 2)).toEqual({ width: 1280, height: 640 });
  });

  test("bounds both dimensions and pixel memory for extreme zoom and aspect ratios", () => {
    for (const [width, height] of [[8000, 6000], [20, 100000], [100000, 20], [1, 1]]) {
      const size = svgRasterSize(width!, height!, 3);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      expect(size.width).toBeLessThanOrEqual(4096);
      expect(size.height).toBeLessThanOrEqual(4096);
      expect(size.width * size.height).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });
});

describe("SVG raster cache", () => {
  test("reopening and zooming out reuse pixels; zooming in and source changes redraw", () => {
    const disposed: RasterSize[] = [];
    const cache = createSvgRasterCache<RasterSize>(raster => disposed.push(raster));
    let renders = 0;
    const get = (svg: string, width: number) => cache.get(svg, { width, height: width }, () => {
      renders++;
      return { width, height: width };
    });
    const first = get("first revision", 512);
    expect(get("first revision", 512)).toBe(first);
    expect(get("first revision", 256)).toBe(first);
    expect(renders).toBe(1);
    const detailed = get("first revision", 1024);
    expect(detailed).not.toBe(first);
    expect(disposed).toEqual([first]);
    expect(get("second revision", 512)).not.toBe(first);
    expect(get("first revision", 512)).toBe(detailed);
    expect(renders).toBe(3);
  });

  test("evicts least-recently-used pixels and releases their backing stores", () => {
    const disposed: RasterSize[] = [];
    const cache = createSvgRasterCache<RasterSize>(raster => disposed.push(raster), 32);
    const size = { width: 2, height: 2 }; // 16 bytes each
    const first = cache.get("a", size, () => ({ ...size }));
    const second = cache.get("b", size, () => ({ ...size }));
    expect(cache.get("a", size, () => { throw new Error("must reuse"); })).toBe(first);
    cache.get("c", size, () => ({ ...size }));
    expect(disposed).toEqual([second]);
  });

  test("a failed refinement leaves the existing preview usable", () => {
    const cache = createSvgRasterCache<RasterSize>(() => { throw new Error("must not dispose"); });
    const first = cache.get("a", { width: 2, height: 2 }, () => ({ width: 2, height: 2 }));
    expect(() => cache.get("a", { width: 4, height: 4 }, () => { throw new Error("draw failed"); })).toThrow("draw failed");
    expect(cache.get("a", { width: 2, height: 2 }, () => { throw new Error("must reuse"); })).toBe(first);
  });
});

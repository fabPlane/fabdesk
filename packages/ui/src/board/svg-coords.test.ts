import { describe, expect, test } from "bun:test";
import {
  clientPointToSvg,
  parseSvgViewBox,
  resolveSvgBox,
  svgElementBox,
  svgPointToPercent,
  type SvgBox,
  type SvgBoxSource,
} from "./svg-coords";

function fakeSvg(viewBox: SvgBox | null, bbox: SvgBox): SvgBoxSource {
  return {
    viewBox: { baseVal: viewBox ?? { x: 0, y: 0, width: 0, height: 0 } },
    getBBox: () => bbox,
  };
}

describe("svg pin coordinates", () => {
  test("reads a viewBox and maps a click to user space", () => {
    const box = parseSvgViewBox(`<svg viewBox="10 20 100 50"></svg>`);
    expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(
      clientPointToSvg(box!, { left: 0, top: 0, width: 200, height: 100 }, 100, 50),
    ).toEqual({ x: 60, y: 45 });
    expect(svgPointToPercent(box!, { x: 60, y: 45 })).toEqual({ left: 50, top: 50 });
  });

  test("rejects a missing or inverted viewBox", () => {
    expect(parseSvgViewBox("<svg></svg>")).toBeNull();
    expect(parseSvgViewBox(`<svg viewBox="0 0 0 10"></svg>`)).toBeNull();
  });

  test("falls back to getBBox when the SVG has no viewBox so pins can render", () => {
    const bounds = { x: 2, y: 4, width: 80, height: 40 };
    expect(svgElementBox(fakeSvg(null, bounds))).toEqual(bounds);
    expect(resolveSvgBox("<svg><rect width='80' height='40'/></svg>", fakeSvg(null, bounds))).toEqual(bounds);
    expect(
      svgElementBox(fakeSvg({ x: 10, y: 20, width: 100, height: 50 }, bounds)),
    ).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(resolveSvgBox(`<svg viewBox="10 20 100 50"></svg>`, fakeSvg(null, bounds))).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  test("legacy SVG pins and clicks share bounds with a nonzero origin at any zoom", () => {
    const box = resolveSvgBox("<svg/>", fakeSvg(null, { x: 20, y: -10, width: 80, height: 40 }))!;
    for (const zoom of [1, 1.25, 2]) {
      const rect = { left: 12, top: 24, width: 400 * zoom, height: 200 * zoom };
      const point = clientPointToSvg(box, rect, rect.left + rect.width * 0.75, rect.top + rect.height * 0.25)!;
      expect(point).toEqual({ x: 80, y: 0 });
      expect(svgPointToPercent(box, point)).toEqual({ left: 75, top: 25 });
    }
  });
});

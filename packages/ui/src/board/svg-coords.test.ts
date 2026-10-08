import { describe, expect, test } from "bun:test";
import { clientPointToSvg, parseSvgViewBox, svgPointToPercent } from "./svg-coords";

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
});

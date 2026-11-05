import { expect, test } from "bun:test";
import { convertImage } from "./styles";
import { nativeArtworkGraphics } from "./native-graphics";
import { artworkOverlaySvg } from "./preview";
import type { BoardArt } from "./types";

const scene = (): BoardArt => ({ ...convertImage({ width: 1, height: 1, pixels: new Uint8Array([0]) }, { style: "poster", widthMm: 15, heightMm: 15, color: "green", outline: "rectangle", layers: ["silk"] }), clipped: [{ kind: "circle", x: 2, y: 3, d: .4 }, { kind: "rect", x: 4, y: 5, w: 1, h: 2 }, { kind: "line", x1: 6, y1: 7, x2: 8, y2: 9, w: .2 }] });
test("native art preserves dot/rectangle/stroke geometry while translating the native PCB origin", () => {
  expect(nativeArtworkGraphics(scene(), { x: 100, y: 95 })).toEqual([
    { kind: "circle", layer: "F.SilkS", center: { x: 102, y: 98 }, radiusPoint: { x: 102.2, y: 98 }, strokeWidth: 0, filled: true },
    { kind: "rectangle", layer: "F.SilkS", start: { x: 104, y: 100 }, end: { x: 105, y: 102 }, strokeWidth: 0, filled: true },
    { kind: "segment", layer: "F.SilkS", start: { x: 106, y: 102 }, end: { x: 108, y: 104 }, strokeWidth: .2, filled: false },
  ]);
});
test("native art never silently truncates or converts mask/copper art into silkscreen", () => {
  const art = scene(); art.clipped = Array.from({ length: 2001 }, () => ({ kind: "circle" as const, x: 1, y: 1, d: .2 }));
  expect(() => nativeArtworkGraphics(art, { x: 0, y: 0 })).toThrow("no marks were removed");
  art.clipped = scene().clipped; art.options.layers = ["silk", "copper"];
  expect(() => nativeArtworkGraphics(art, { x: 0, y: 0 })).toThrow("silkscreen only");
  art.options.layers = ["silk"]; art.clipped = [];
  expect(() => nativeArtworkGraphics(art, { x: 0, y: 0 })).toThrow("no visible marks");
});
test("invalid coordinates and dimensions fail before a native proposal is returned", () => {
  expect(() => nativeArtworkGraphics(scene(), { x: NaN, y: 95 })).toThrow("origin");
  const art = scene(); art.clipped = [{ kind: "rect", x: 1, y: 2, w: -1, h: 2 }];
  expect(() => nativeArtworkGraphics(art, { x: 100, y: 95 })).toThrow("rectangle");
});
test("existing-board art overlay is transparent and contains only proposed marks", () => {
  const svg = artworkOverlaySvg(scene());
  expect(svg).toContain('viewBox="0 0 15 15"'); expect(svg).toContain('data-unapplied-artwork="true"');
  expect(svg).toContain('<circle cx="2" cy="3" r="0.2"'); expect(svg).toContain('<line x1="6"');
  expect(svg).not.toContain('data-layer="fr4"'); expect(svg).not.toContain('copper-fill'); expect(svg).not.toContain('fill="#111"');
});

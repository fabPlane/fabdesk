import { describe, expect, test } from "bun:test";
import { fillRect, makeGray } from "../src/image";
import { buildBoardArt } from "../src/job";
import { BOARD_FINISH } from "../src/types";

function mark() {
  const img = makeGray(32, 32, 255);
  fillRect(img, 8, 8, 16, 16, 0);
  return img;
}

const opts = {
  widthMm: 30,
  heightMm: 30,
  color: "blue" as const,
  outline: "rectangle" as const,
  style: "poster" as const,
  pitchMm: 1,
  marginMm: 2,
};
const finish = BOARD_FINISH.blue;
const layerGroup = (svg: string, layer: string) =>
  svg.match(new RegExp(`<g data-layer="${layer}">(.*?)</g>`, "s"))?.[1] ?? null;

describe("preview reflects the selected art layers", () => {
  test("silk: artwork in silk colour over solid mask and copper fill", () => {
    const { previewSvg: svg } = buildBoardArt(mark(), { ...opts, layers: ["silk"] });
    expect(layerGroup(svg, "silk")).toContain(`fill="${finish.silk}"`);
    expect(svg).toContain('data-layer="copper-fill"');
    expect(svg).not.toContain("<mask ");
    expect(layerGroup(svg, "copper")).toBeNull();
  });

  test("mask: artwork cut as soldermask openings, no silkscreen", () => {
    const { previewSvg: svg } = buildBoardArt(mark(), { ...opts, layers: ["mask"] });
    expect(layerGroup(svg, "silk")).toBeNull();
    expect(svg).not.toContain(`fill="${finish.silk}"`);
    expect(svg).toMatch(/<mask id="fp-board-art-[^"]+-mask"[^>]*><rect [^>]*fill="#fff"\/><rect [^>]*fill="#000"\/>/);
    expect(svg).toMatch(/data-layer="mask"[^>]*mask="url\(#fp-board-art-[^)]+-mask\)"/);
  });

  test("copper: artwork drawn in copper under an unbroken mask, no flood fill or silk", () => {
    const { previewSvg: svg } = buildBoardArt(mark(), { ...opts, layers: ["copper"] });
    expect(layerGroup(svg, "copper")).toContain(`fill="${finish.copper}"`);
    expect(svg).not.toContain('data-layer="copper-fill"');
    expect(layerGroup(svg, "silk")).toBeNull();
    expect(svg).not.toContain("<mask ");
    const order = ["fr4", "copper", "mask"].map((l) => svg.indexOf(`data-layer="${l}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("no copper fill when fillCopper is off and copper is not selected", () => {
    const { previewSvg: svg } = buildBoardArt(mark(), {
      ...opts,
      layers: ["silk"],
      fillCopper: false,
    });
    expect(svg).not.toContain('data-layer="copper');
  });
});

test("circular inline previews use their own clip resource instead of the app board panel ID", () => {
  const circle = buildBoardArt(mark(), {
    ...opts,
    widthMm: 80,
    heightMm: 50,
    outline: "circle",
  }).previewSvg;
  const rounded = buildBoardArt(mark(), {
    ...opts,
    outline: "rounded",
    layers: ["mask"],
  }).previewSvg;
  const clipId = circle.match(/<clipPath id="([^"]+)"/)![1]!;
  expect(clipId).toStartWith("fp-board-art-");
  expect(circle).toContain(`clip-path="url(#${clipId})"`);
  expect(circle).toContain('clipPathUnits="userSpaceOnUse"><circle cx="40" cy="25" r="25"/>');
  expect(circle).not.toContain('id="board"');
  expect(rounded).not.toContain(`id="${clipId}"`);
  const maskId = rounded.match(/<mask id="([^"]+)"/)![1]!;
  expect(rounded).toContain(`mask="url(#${maskId})"`);
  expect(rounded).not.toContain('id="mask-openings"');
  expect(circle).toBe(
    buildBoardArt(mark(), { ...opts, widthMm: 80, heightMm: 50, outline: "circle" }).previewSvg,
  );
});

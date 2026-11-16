import { expect, test } from "bun:test";
import {
  buildBoardArt,
  convertImage,
  decodeGray,
  encodePng,
  rgbaToGray,
  resolveArtOptions,
  previewSvg,
  type ArtOptions,
  ORIGINAL_RECOLOR,
} from "../src";

const options: ArtOptions = {
  style: "realistic",
  color: "blue",
  outline: "rectangle",
  widthMm: 30,
  heightMm: 20,
  pitchMm: 1,
  marginMm: 1,
  colorMode: "multicolor",
  printedBackground: "#125abc",
};
const raster = {
  width: 4,
  height: 1,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 255, 0]),
};
const image = { ...rgbaToGray(raster), rgba: raster.data };

test("recolor effects preserve source bytes, dot geometry and exact original reset", () => {
  const originalBytes = new Uint8Array(image.rgba!);
  const original = convertImage(image, options);
  for (const mode of ["grayscale", "duotone"] as const) {
    const changed = convertImage(image, { ...options, recolor: { ...ORIGINAL_RECOLOR, mode } });
    expect(changed.clipped.map(({ color, ...geometry }) => geometry)).toEqual(original.clipped.map(({ color, ...geometry }) => geometry));
    expect(changed.clipped.map(p => p.color)).not.toEqual(original.clipped.map(p => p.color));
    expect(convertImage(image, { ...options, recolor: { ...ORIGINAL_RECOLOR, mode, amount: 0 } })).toMatchObject({ clipped: original.clipped });
  }
  expect(convertImage(image, { ...options, recolor: { ...ORIGINAL_RECOLOR } }).clipped).toEqual(original.clipped);
  expect(image.rgba).toEqual(originalBytes);
});

test("duotone maps dark and light pixels to chosen colors in the reference export", () => {
  const raster = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
  const image = { ...rgbaToGray(raster), rgba: raster.data };
  const recolor = { ...ORIGINAL_RECOLOR, mode: "duotone" as const, shadow: "#123456", highlight: "#abcdef" };
  const job = buildBoardArt(image, { ...options, recolor });
  expect(new Set(job.art.clipped.map(p => p.color))).toEqual(new Set(["#123456", "#abcdef"]));
  const reference = new TextDecoder().decode(job.files.find(f => f.name === "color-artwork-reference.svg")!.data);
  expect(reference).toContain('fill="#123456"'); expect(reference).toContain('fill="#abcdef"');
  const readme = new TextDecoder().decode(job.files.find(f => f.name === "README.txt")!.data);
  expect(readme).toContain("Color effect: duotone");
  expect(readme).toContain("NOT a JLCPCB multicolor production package");
  const settings = JSON.parse(new TextDecoder().decode(job.files.find(f => f.name === "artwork-settings.json")!.data));
  expect(settings.recolor).toEqual(recolor);
});

test("invalid recoloring is rejected and monotone fabrication remains unchanged", () => {
  for (const amount of [NaN, -1, 1.1]) expect(() => resolveArtOptions({ ...options, recolor: { ...ORIGINAL_RECOLOR, amount } })).toThrow("strength");
  expect(() => resolveArtOptions({ ...options, recolor: { ...ORIGINAL_RECOLOR, shadow: 'red"' } })).toThrow("hex");
  const original = buildBoardArt(image, { ...options, colorMode: "monotone" });
  const recolored = buildBoardArt(image, { ...options, colorMode: "monotone", recolor: { ...ORIGINAL_RECOLOR, mode: "duotone" } });
  expect(recolored.gerbers).toEqual(original.gerbers); expect(recolored.kicadPcb).toEqual(original.kicadPcb);
});

test("small boards retain opaque dark source colors at the default feature size", () => {
  const source = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
  const art = convertImage({ ...rgbaToGray(source), rgba: source.data }, {
    style: "realistic", color: "white", outline: "rectangle", widthMm: 40, heightMm: 30, colorMode: "multicolor",
  });
  expect(new Set(art.clipped.map(p => p.color))).toEqual(new Set(["#000000", "#ffffff"]));
});

test("board image framing keeps physical layers and colors without the preview stage", () => {
  for (const outline of ["rectangle", "rounded", "circle"] as const) {
    for (const colorMode of ["monotone", "multicolor"] as const) {
      const art = convertImage(image, { ...options, outline, colorMode });
      const svg = previewSvg(art.options, art.clipped, false, true);
      expect(svg).toContain('viewBox="0 0 30 20"');
      expect(svg).not.toContain('fill="#111"');
      expect(svg).toContain('data-layer="fr4"');
      expect(svg).toContain('data-layer="mask"');
      expect(svg).toContain('clip-path="url(#');
      expect(svg).toContain('data-layer="silk"');
      if (colorMode === "multicolor") {
        expect(svg).toContain('fill="#ff0000"');
        expect(svg).toContain('data-layer="printed-background"');
      }
    }
  }
});

test("decode retains original color and alpha for future mode switches", async () => {
  const decoded = await decodeGray(encodePng(raster));
  expect(decoded.rgba).toEqual(raster.data);
  expect(decoded.pixels).toEqual(image.pixels);
});

test("multicolor preserves source colors and highlights, skips transparent areas, and varies dot size", () => {
  const art = convertImage(image, options);
  expect(art.options.color).toBe("white");
  expect(new Set(art.clipped.map((p) => p.color))).toEqual(
    new Set(["#ff0000", "#00ff00", "#ffffff"]),
  );
  const diameters = art.clipped.flatMap((p) => (p.kind === "circle" ? [p.d] : []));
  expect(new Set(diameters).size).toBeGreaterThan(1);
  expect(diameters.every((d) => d >= art.options.minFeatureMm && d < art.options.pitchMm)).toBe(
    true,
  );
});

test("printed background changes export and preview without recoloring dots or geometry", () => {
  const first = buildBoardArt(image, options);
  const second = buildBoardArt(image, { ...options, printedBackground: "#ffcc00" });
  expect(first.art.clipped).toEqual(second.art.clipped);
  expect(first.previewSvg).toContain(
    'data-layer="printed-background" x="0" y="0" width="30" height="20" fill="#125abc"',
  );
  expect(second.previewSvg).toContain('fill="#ffcc00"');
  const svg = new TextDecoder().decode(
    first.files.find((f) => f.name === "color-artwork-reference.svg")!.data,
  );
  expect(svg).toContain('width="30mm" height="20mm"');
  expect(svg).toContain('fill="#ff0000"');
  expect(svg).toContain('fill="#125abc"');
  expect(svg).not.toContain('data-layer="copper');
  expect(svg).not.toContain('fill="#111"');
  expect(first.kicadPcb).not.toContain('"F.SilkS" (');
  expect(first.kicadPcb).not.toContain("(gr_circle");
  const silk = first.gerbers.find((g) => g.name.includes("F_Silkscreen"));
  expect(silk?.body ?? first.gerbers.map((g) => g.body).join("\n")).not.toContain("D03*");
  const readme = new TextDecoder().decode(first.files.find((f) => f.name === "README.txt")!.data);
  expect(readme).toContain("NOT a JLCPCB multicolor production package");
  expect(readme).toContain("physical solder mask: white");
});

test("monotone ink is explicit but conventional Gerber geometry is independent of color", () => {
  const first = buildBoardArt(image, { ...options, colorMode: "monotone", inkColor: "#123456" });
  const second = buildBoardArt(image, {
    ...options,
    colorMode: "monotone",
    inkColor: "#fedcba",
    color: "red",
  });
  expect(first.previewSvg).toContain('fill="#123456"');
  expect(first.gerbers).toEqual(second.gerbers);
  expect(first.options.color).toBe("blue");
  expect(
    new TextDecoder().decode(first.files.find((f) => f.name === "artwork-settings.json")!.data),
  ).toContain('"inkColor": "#123456"');
});

test("reject invalid hex and unsupported physical color layers instead of silently changing fabrication", () => {
  expect(() => resolveArtOptions({ ...options, printedBackground: 'red" onload="x' })).toThrow(
    "six-digit hex",
  );
  expect(() => resolveArtOptions({ ...options, layers: ["copper"] })).toThrow(
    "printed silkscreen only",
  );
  expect(() => convertImage(rgbaToGray(raster), options)).toThrow("Reimport");
});

test("color dots respect crop, placement and rounded board edges", () => {
  const art = convertImage(image, {
    ...options,
    crop: "circle",
    outline: "rounded",
    placement: { centerXmm: 4, centerYmm: 4, widthMm: 7, heightMm: 7, rotationDeg: 45 },
  });
  expect(art.clipped.length).toBeGreaterThan(0);
  expect(
    art.clipped.every(
      (p) => p.kind === "circle" && Math.hypot(p.x - 4, p.y - 4) + p.d / 2 <= 3.5 + 1e-8,
    ),
  ).toBe(true);
});

test("unset background uses the physical board and omits the printed base from the SVG reference", () => {
  const job = buildBoardArt(image, { ...options, printedBackground: null });
  expect(job.options.printedBackground).toBeNull();
  expect(job.options.color).toBe("white");
  expect(job.previewSvg).not.toContain('data-layer="printed-background"');
  expect(job.previewSvg).toContain('data-layer="mask"');
  const reference = new TextDecoder().decode(
    job.files.find((f) => f.name === "color-artwork-reference.svg")!.data,
  );
  expect(reference).not.toContain('data-layer="printed-background"');
  expect(reference).toContain('fill="#ff0000"');
  expect(
    resolveArtOptions({
      style: "realistic",
      color: "blue",
      outline: "rectangle",
      widthMm: 30,
      heightMm: 20,
      colorMode: "multicolor",
    }).printedBackground,
  ).toBeNull();
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFrontZonesFilled } from "../src/board-features";
import { copperRemovalArtwork, copperRemovalFromDxf } from "../src/copper-removal";
import { rasterizeSvgPixels } from "../src/raster";

const plot = (entities: string[]) => ["0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF"].join("\n");
const line = (layer: string, x: number, y: number, x2: number, y2: number) =>
  `0\nLINE\n8\n${layer}\n10\n${x}\n20\n${y}\n11\n${x2}\n21\n${y2}`;
const box = (layer: string, x: number, y: number, x2: number, y2: number) => [
  line(layer, x, y, x2, y), line(layer, x2, y2, x2, y), line(layer, x2, y2, x, y2), line(layer, x, y, x, y2),
];
const arc = (layer: string, kind: "CIRCLE" | "ARC", x: number, y: number, radius: number, from = 0, to = 0) =>
  `0\n${kind}\n8\n${layer}\n10\n${x}\n20\n${y}\n40\n${radius}` + (kind === "ARC" ? `\n50\n${from}\n51\n${to}` : "");
const outline = box("Edge.Cuts", 70, -30, 90, -10);
const copper = box("F.Cu", 73, -21, 78, -12);
async function samples(svg: string, widthMm: number) {
  const pixels = await rasterizeSvgPixels(svg, { width: widthMm * 40 });
  return (x: number, y: number) => pixels.rgba[(Math.floor(y * 40) * pixels.width + Math.floor(x * 40)) * 4];
}

test("black is removable copper with front-view scale, nested islands, edge cutouts and clipped off-board copper", async () => {
  const holes = [arc("Edge.Cuts", "CIRCLE", 84, -25, 2)];
  const inner = [arc("F.Cu", "ARC", 75, -15, 1, 0, 180), arc("F.Cu", "ARC", 75, -15, 1, 180, 0)];
  const result = copperRemovalFromDxf(plot([...outline, ...holes]), plot([...copper, ...inner, ...box("F.Cu", 87, -20, 92, -15)]));
  expect([result.widthMm, result.heightMm]).toEqual([20, 20]);
  expect(result.artworkBounds).toEqual({ xMm: 0, yMm: 0, widthMm: 20, heightMm: 20 });
  expect(result.svg).toContain('width="20mm"');
  const sample = await samples(result.svg, 20);
  expect(sample(1, 1)).toBe(0);
  expect(sample(4, 3)).toBe(255);
  expect(sample(5, 5)).toBe(0);
  expect(sample(14, 15)).toBe(255);
  expect(sample(19, 7)).toBe(255);
});

test("retained edges leave distinct mark bounds registered to the top-left of the full-size board", async () => {
  // A solid copper sheet with two disjoint clear windows. Only the windows are engraved.
  const front = plot([...box("F.Cu", 68, -32, 93, -8), ...box("F.Cu", 74, -17, 77, -13), ...box("F.Cu", 82, -27, 87, -25)]);
  const result = copperRemovalFromDxf(plot(outline), front);
  expect(result).toMatchObject({ widthMm: 20, heightMm: 20, artworkBounds: { xMm: 4, yMm: 3, widthMm: 13, heightMm: 14 } });
  expect(result.svg).toContain('viewBox="0 0 20 20"');
  const sample = await samples(result.svg, 20);
  expect([sample(5, 4), sample(10, 10), sample(16, 16)]).toEqual([0, 255, 0]);
});

test("incomplete, crossing and unsupported plots fail before a mask can be produced", () => {
  expect(() => copperRemovalFromDxf(plot(outline.slice(1)), plot(copper))).toThrow("open or branching");
  const bow = [[70,-30], [90,-10], [70,-10], [90,-30]] as const;
  const crossings = bow.map(([x,y], i) => line("Edge.Cuts", x, y, ...bow[(i+1)%4]!));
  expect(() => copperRemovalFromDxf(plot(crossings), plot(copper))).toThrow("cross or touch");
  expect(() => copperRemovalFromDxf(plot(outline), plot(copper.map(x => x.replace("LINE", "SPLINE"))))).toThrow("Unsupported");
  expect(() => copperRemovalFromDxf(plot(outline), plot([]))).toThrow("No usable closed F.Cu");
});

test("missing front zone fills fail without mistaking keepouts or bottom fills for front pours", () => {
  const zone = '(zone (layers "F.Cu" "B.Cu") (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 2 0) (xy 0 2))))';
  expect(() => assertFrontZonesFilled(`(kicad_pcb (footprint x ${zone}))`)).toThrow("Refill zones");
  expect(() => assertFrontZonesFilled(`(kicad_pcb ${zone.replace('polygon (layer "B.Cu"', 'polygon (layer "F.Cu"')})`)).not.toThrow();
  expect(() => assertFrontZonesFilled('(kicad_pcb (zone (layer "F.Cu") (keepout (pads not_allowed))))')).not.toThrow();
});

const nativeCli = process.env["FABPLANE_KICAD_CLI"];
test.skipIf(!nativeCli)("bundled KiCad exports real routed pads and saved front copper zones at the right coordinates", async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), "fabdesk-copper-test-"));
  const board = join(scratchDir, "board.kicad_pcb");
  const generate = () => copperRemovalArtwork({ path: nativeCli!, version: "" }, { board, scratchDir });
  try {
    await writeFile(board, await readFile(join(import.meta.dir, "../../../docs/examples/omni-x-copper-coupon.kicad_pcb")));
    const coupon = await generate();
    expect([coupon.widthMm, coupon.heightMm]).toEqual([20, 12]);
    expect(coupon.artworkBounds).toEqual({ xMm: 0, yMm: 0, widthMm: 20, heightMm: 12 });
    const sample = await samples(coupon.svg, 20);
    expect([sample(3, 3), sample(10, 5.5), sample(10, 6), sample(10, 6.5), sample(16, 8.5)]).toEqual([255, 255, 0, 255, 255]);
    // A copper graphic encloses a clear region inside the positive F.Cu plot.
    const ringGraphic = '(gr_circle (center 110 109.5) (end 111 109.5) (stroke (width 0.4) (type default)) (fill no) (layer "F.Cu"))';
    await writeFile(board, (await readFile(board, "utf8")).trimEnd().slice(0, -1) + ringGraphic + ")");
    const annulus = await samples((await generate()).svg, 20);
    expect([annulus(10, 9.5), annulus(11, 9.5)]).toEqual([0, 255]);
    const demo = await readFile(join(import.meta.dir, "fixtures/mini-two-layer.kicad_pcb"), "utf8");
    // Move only the test zone + its saved fill from B.Cu to F.Cu.
    await writeFile(board, demo.replace(/\(zone\s+[\s\S]*?\(filled_polygon\s+\(layer "B\.Cu"\)/, zone => zone.replaceAll('"B.Cu"', '"F.Cu"')));
    const zone = await generate();
    expect([zone.widthMm, zone.heightMm]).toEqual([15, 15]);
    const zoneSample = await samples(zone.svg, 15);
    expect(zoneSample(2, 2)).toBe(255);
    expect(zoneSample(0.2, 2)).toBe(0);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

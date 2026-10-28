import { convertImage } from "./styles";
import { buildGerberSet } from "./gerber";
import { writeKicadPcb, writeKicadPro } from "./kicad";
import { previewSvg } from "./preview";
import { buildZip, type ZipEntry } from "./zip";
import type { ArtOptions, BoardArt, GerberFile, GrayImage, ResolvedArtOptions } from "./types";

export type BoardArtJob = {
  art: BoardArt;
  options: ResolvedArtOptions;
  gerbers: GerberFile[];
  kicadPcb: string;
  kicadPro: string;
  previewSvg: string;
  zip: Uint8Array;
  files: ZipEntry[];
  stats: {
    primitives: number;
    gerberFiles: number;
    zipBytes: number;
    minFeatureMm: number;
    pitchMm: number;
  };
};

const enc = new TextEncoder();

export function buildBoardArt(img: GrayImage, raw: ArtOptions): BoardArtJob {
  const art = convertImage(img, raw);
  const options = art.options;
  // Conventional Gerber/KiCad cannot carry per-dot colors. Never silently flatten color art.
  const fabricationArt = options.colorMode === "multicolor" ? [] : art.clipped;
  const gerbers = buildGerberSet(options, fabricationArt);
  const kicadPcb = writeKicadPcb(options, fabricationArt);
  const kicadPro = writeKicadPro("board");
  const svg = previewSvg(options, art.clipped);
  const files: ZipEntry[] = [
    { name: "artwork-settings.json", data: enc.encode(JSON.stringify(options, null, 2)) },
    ...(options.colorMode === "multicolor"
      ? [
          {
            name: "color-artwork-reference.svg",
            data: enc.encode(previewSvg(options, art.clipped, true)),
          },
        ]
      : []),
    ...gerbers.map((g) => ({ name: `gerbers/${g.name}`, data: enc.encode(g.body) })),
    { name: "board.kicad_pcb", data: enc.encode(kicadPcb) },
    { name: "board.kicad_pro", data: enc.encode(kicadPro) },
    { name: "preview.svg", data: enc.encode(svg) },
    { name: "README.txt", data: enc.encode(readme(options, art.clipped.length)) },
  ];
  const zip = buildZip(files);
  return {
    art,
    options,
    gerbers,
    kicadPcb,
    kicadPro,
    previewSvg: svg,
    zip,
    files,
    stats: {
      primitives: art.clipped.length,
      gerberFiles: gerbers.length,
      zipBytes: zip.length,
      minFeatureMm: options.minFeatureMm,
      pitchMm: options.pitchMm,
    },
  };
}

function readme(o: ResolvedArtOptions, primitives: number): string {
  return [
    "fabPlane board art",
    "",
    "Deterministic image-to-silkscreen conversion. No AI credits.",
    `Style: ${o.style}`,
    `Color mode: ${o.colorMode}`,
    `Monotone ink (preview/order choice): ${o.inkColor}`,
    ...(o.colorMode === "multicolor"
      ? [
          `Printed background: ${o.printedBackground}; physical solder mask: white`,
          "COLOR REFERENCE ONLY: Gerber and KiCad files contain the blank board, not the colored artwork.",
          "color-artwork-reference.svg contains source-colored dots and the printed background at board size.",
          "This ZIP is NOT a JLCPCB multicolor production package. Import the SVG into EasyEDA Pro and generate its color silkscreen production files. Verify alignment, pads, minimum features and process settings there.",
          "JLCPCB currently specifies white solder mask, 2/4 layers, 1 oz outer copper and ENIG (1u gold) for this process.",
          "https://jlcpcb.com/help/article/how-to-design-multi-color-silkscreen-using-easyeda",
        ]
      : [
          "Conventional Gerber does not encode solder-mask or ink color. Select them when ordering; preview swatches are approximate.",
        ]),
    `Board: ${o.widthMm} x ${o.heightMm} mm, ${o.color} soldermask, ${o.outline} outline`,
    `Layers: ${o.layers.join(", ")}`,
    `Image crop: ${o.crop}`,
    ...(o.placement
      ? [
          `Artwork centre: ${o.placement.centerXmm} x ${o.placement.centerYmm} mm`,
          `Artwork size: ${o.placement.widthMm} x ${o.placement.heightMm} mm; rotation: ${o.placement.rotationDeg} degrees clockwise`,
        ]
      : []),
    `Minimum feature: ${o.minFeatureMm} mm (typical fab silkscreen floor is 0.15 mm)`,
    `Pitch: ${o.pitchMm.toFixed(3)} mm`,
    `Primitives: ${primitives}`,
    "",
    o.colorMode === "multicolor"
      ? "Do not order the blank Gerbers expecting colored artwork."
      : "Upload gerbers/ to a board house, or open board.kicad_pcb in fabPlane / KiCad.",
    "",
  ].join("\n");
}

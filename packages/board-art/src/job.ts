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
  const gerbers = buildGerberSet(options, art.clipped);
  const kicadPcb = writeKicadPcb(options, art.clipped);
  const kicadPro = writeKicadPro("board");
  const svg = previewSvg(options, art.clipped);
  const files: ZipEntry[] = [
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
    `Board: ${o.widthMm} x ${o.heightMm} mm, ${o.color} soldermask, ${o.outline} outline`,
    `Layers: ${o.layers.join(", ")}`,
    `Minimum feature: ${o.minFeatureMm} mm (typical fab silkscreen floor is 0.15 mm)`,
    `Pitch: ${o.pitchMm.toFixed(3)} mm`,
    `Primitives: ${primitives}`,
    "",
    "Upload gerbers/ to a board house, or open board.kicad_pcb in fabPlane / KiCad.",
    "",
  ].join("\n");
}

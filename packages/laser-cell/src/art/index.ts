/**
 * Vector art for the laser: opens SVG and DXF files (logos, text converted to paths, mechanical outlines)
 * as millimetre geometry the mark job can hatch and outline.
 *
 * Conventions of the result: millimetres, Y up, moved so the bounding box starts at (0, 0). Curves are
 * flattened to straight segments with a chord error of at most `toleranceMm` (default 0.01 mm).
 */
import { ArtImportError } from "./geometry";
import { importDxf } from "./dxf";
import { importSvg } from "./svg";

export type Vec = [number, number];

export type ArtGeometry = {
  /** Closed rings, already resolved so that filling them with the EVEN-ODD rule gives the right result (outer boundaries + holes, no overlaps). */
  fills: Vec[][];
  /** Open (or stroke-only) polylines, marked as lines, never filled. Closed ones repeat their first point at the end. */
  lines: Vec[][];
  /** Bounding box of fills + lines. */
  widthMm: number;
  heightMm: number;
  /** Plain-English notes about what was skipped or approximated. */
  warnings: string[];
};

export type ArtFormat = "svg" | "dxf";

export type ArtImportOptions = {
  /** Largest distance between a curve and the straight segments that replace it, in mm (default 0.01). */
  toleranceMm?: number;
};

export { ArtImportError, DEFAULT_TOLERANCE_MM } from "./geometry";
export { importDxf } from "./dxf";
export { importSvg } from "./svg";

/** Opens SVG or DXF text. Throws {@link ArtImportError} when the text is not a valid file of that format. */
export async function importArt(text: string, format: ArtFormat, opts?: ArtImportOptions): Promise<ArtGeometry> {
  switch (format) {
    case "svg":
      return importSvg(text, opts);
    case "dxf":
      return importDxf(text, opts);
  }
  throw new ArtImportError(`unknown vector format "${String(format)}" (expected "svg" or "dxf")`);
}

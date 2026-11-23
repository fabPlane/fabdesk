import type { KnownScalePart, ScaleAssumption, SightedItem } from "@fabdesk/protocol";
import { guessKnownPart, KNOWN_PART_SIZES_MM } from "./known-parts";

export type ScaleHint = {
  userDimensionMm?: number;
  userDimensionOf?: "width" | "height" | "diagonal" | "part";
  knownPart?: KnownScalePart;
};

/**
 * Infer millimetres-per-pixel from a user-given size, or from a recognised part's
 * published body size compared to its box in the photo.
 */
export function inferScale(opts: {
  photoWidthPx: number;
  photoHeightPx: number;
  items: readonly SightedItem[];
  hint?: ScaleHint;
}): ScaleAssumption {
  const w = opts.photoWidthPx;
  const h = opts.photoHeightPx;
  const hint = opts.hint ?? {};

  if (hint.userDimensionMm && hint.userDimensionMm > 0) {
    const of = hint.userDimensionOf ?? "width";
    const px =
      of === "height" ? h : of === "diagonal" ? Math.hypot(w, h) : of === "part" ? partPx(opts.items) : w;
    const mmPerPx = hint.userDimensionMm / Math.max(px, 1);
    return {
      method: "user_dimension",
      ...(hint.knownPart ? { knownPart: hint.knownPart } : {}),
      userDimensionMm: hint.userDimensionMm,
      userDimensionOf: of,
      assumedMmPerPx: mmPerPx,
      boardWidthMm: roundMm(w * mmPerPx),
      boardHeightMm: roundMm(h * mmPerPx),
      note: `Using the ${of} you gave (${hint.userDimensionMm} mm) as the scale.`,
      confidence: 0.9,
    };
  }

  const known = firstKnownItem(opts.items);
  const part = hint.knownPart ?? known?.part;
  if (part) {
    const size = KNOWN_PART_SIZES_MM[part];
    const box = known?.box ?? { x: 0, y: 0, w: 1, h: 1 };
    const px = Math.max(box.w * w, box.h * h);
    const mm = Math.max(size.widthMm, size.heightMm);
    const mmPerPx = mm / Math.max(px, 1);
    return {
      method: "known_part",
      knownPart: part,
      assumedMmPerPx: mmPerPx,
      boardWidthMm: roundMm(w * mmPerPx),
      boardHeightMm: roundMm(h * mmPerPx),
      note: `Assuming the ${size.label} is ${mm} mm on its long side. Correct this if the part is a different size.`,
      confidence: 0.65,
    };
  }

  return {
    method: "unscaled",
    assumedMmPerPx: 0.2,
    boardWidthMm: roundMm(w * 0.2),
    boardHeightMm: roundMm(h * 0.2),
    note: "No known dimension yet — assuming 0.2 mm/px (about a 50 mm-wide board at 250 px). Give one measured edge or a recognised part to lock the scale.",
    confidence: 0.25,
  };
}

function firstKnownItem(items: readonly SightedItem[]): { part: KnownScalePart; box: SightedItem["box"] } | undefined {
  for (const item of items) {
    const fromLabel = guessFromItem(item);
    if (fromLabel) return { part: fromLabel, box: item.box };
  }
  return undefined;
}

function guessFromItem(item: SightedItem): KnownScalePart | undefined {
  return guessKnownPart(`${item.label} ${item.markings ?? ""} ${item.mpn ?? ""} ${item.kind}`);
}

function partPx(items: readonly SightedItem[]): number {
  const known = firstKnownItem(items);
  if (!known) return 1;
  return Math.max(known.box.w, known.box.h);
}

function roundMm(n: number): number {
  return Math.round(n * 10) / 10;
}

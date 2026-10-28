import type { BoardArt } from "./types";

export type NativeArtworkGraphic = {
  kind: "circle" | "rectangle" | "segment";
  layer: "F.SilkS";
  center?: { x: number; y: number };
  radiusPoint?: { x: number; y: number };
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  strokeWidth: number;
  filled: boolean;
};

/** Bounded input for the existing native graphics transaction. No board, copper or outline generation. */
export function nativeArtworkGraphics(art: BoardArt, origin: { x: number; y: number }): NativeArtworkGraphic[] {
  if (![origin.x, origin.y].every(Number.isFinite)) throw new Error("The saved PCB origin is unverified.");
  if (art.options.layers.length !== 1 || art.options.layers[0] !== "silk") throw new Error("Circuit artwork currently supports silkscreen only. Mask and copper artwork require separate review.");
  if (!art.clipped.length) throw new Error("The current artwork contains no visible marks.");
  if (art.clipped.length > 2000) throw new Error("This artwork exceeds the native transaction limit of 2,000 marks. Reduce its size or choose a simpler style; no marks were removed.");
  const point = (x: number, y: number) => {
    if (![x, y].every(Number.isFinite)) throw new Error("Artwork contains invalid coordinates.");
    const translated = { x: Math.round((origin.x + x) * 1e6) / 1e6, y: Math.round((origin.y + y) * 1e6) / 1e6 };
    if (![translated.x, translated.y].every(Number.isFinite)) throw new Error("Artwork coordinates exceed native precision.");
    return translated;
  };
  return art.clipped.map(primitive => {
    if (primitive.kind === "circle") {
      if (!Number.isFinite(primitive.d) || primitive.d <= 0) throw new Error("Artwork contains an invalid dot size.");
      return { kind: "circle", layer: "F.SilkS", center: point(primitive.x, primitive.y), radiusPoint: point(primitive.x + primitive.d / 2, primitive.y), strokeWidth: 0, filled: true };
    }
    if (primitive.kind === "rect") {
      if (![primitive.w, primitive.h].every(value => Number.isFinite(value) && value > 0)) throw new Error("Artwork contains an invalid rectangle size.");
      return { kind: "rectangle", layer: "F.SilkS", start: point(primitive.x, primitive.y), end: point(primitive.x + primitive.w, primitive.y + primitive.h), strokeWidth: 0, filled: true };
    }
    if (!Number.isFinite(primitive.w) || primitive.w <= 0) throw new Error("Artwork contains an invalid stroke width.");
    return { kind: "segment", layer: "F.SilkS", start: point(primitive.x1, primitive.y1), end: point(primitive.x2, primitive.y2), strokeWidth: primitive.w, filled: false };
  });
}

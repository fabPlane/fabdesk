import type { ArtworkRecolor } from "./types";

/** Changes color only; the original raster, alpha and artwork geometry stay intact. */
export function recolorRgb(rgb: readonly number[], effect: ArtworkRecolor): number[] {
  if (effect.mode === "original" || effect.amount === 0) return [...rgb];
  const luminance = .299 * rgb[0]! + .587 * rgb[1]! + .114 * rgb[2]!;
  const target = effect.mode === "grayscale"
    ? [luminance, luminance, luminance]
    : [0, 1, 2].map(channel => {
        const start = 1 + channel * 2;
        const dark = parseInt(effect.shadow.slice(start, start + 2), 16);
        const light = parseInt(effect.highlight.slice(start, start + 2), 16);
        return dark + (light - dark) * luminance / 255;
      });
  return rgb.map((channel, index) => Math.round(channel + (target[index]! - channel) * effect.amount));
}

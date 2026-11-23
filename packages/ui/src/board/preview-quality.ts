/** Bound fill-rate/VRAM on Retina and 4K displays, retaining crisp inspection
 * when idle. Pixel ratio may be below one on very large windows by design. */
export function previewPixelRatio(width: number, height: number, deviceRatio: number, interacting = false) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.min(ratio, interacting ? 1.25 : 2, Math.sqrt((interacting ? 1_500_000 : 4_000_000) / (width * height)));
}

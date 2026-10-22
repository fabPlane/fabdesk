import type { ArtPlacement } from "@fabdesk/board-art";

export function resizeArtwork(
  p: ArtPlacement,
  x: number,
  y: number,
  cornerX: number,
  cornerY: number,
  lock: boolean,
): ArtPlacement {
  const a = (p.rotationDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const oppositeX = p.centerXmm - (cornerX * p.widthMm * c - cornerY * p.heightMm * s) / 2;
  const oppositeY = p.centerYmm - (cornerX * p.widthMm * s + cornerY * p.heightMm * c) / 2;
  const dx = x - oppositeX,
    dy = y - oppositeY;
  let w = Math.max(1, Math.min(800, cornerX * (dx * c + dy * s)));
  let h = Math.max(1, Math.min(800, cornerY * (-dx * s + dy * c)));
  if (lock) {
    const scale = Math.max(
      1 / Math.min(p.widthMm, p.heightMm),
      Math.min(
        800 / Math.max(p.widthMm, p.heightMm),
        (w * p.widthMm + h * p.heightMm) / (p.widthMm ** 2 + p.heightMm ** 2),
      ),
    );
    w = p.widthMm * scale;
    h = p.heightMm * scale;
  }
  return {
    ...p,
    widthMm: w,
    heightMm: h,
    centerXmm: oppositeX + (cornerX * w * c - cornerY * h * s) / 2,
    centerYmm: oppositeY + (cornerX * w * s + cornerY * h * c) / 2,
  };
}

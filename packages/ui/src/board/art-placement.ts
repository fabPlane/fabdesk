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

/** Resize the board without leaving a manually placed image outside the new canvas. */
export function placementAfterBoardResize(
  p: ArtPlacement | null,
  oldWidth: number,
  oldHeight: number,
  width: number,
  height: number,
  shape: "rectangle" | "rounded" | "circle" = "rectangle",
  crop: "none" | "circle" | "rounded" = "none",
): ArtPlacement | null {
  if (!p) return null; // Auto-fit continues to follow the board dimensions.
  const margin = 2;
  const a = (p.rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)),
    s = Math.abs(Math.sin(a));
  const boundsW = crop === "circle" ? p.widthMm : p.widthMm * c + p.heightMm * s;
  const boundsH = crop === "circle" ? p.heightMm : p.widthMm * s + p.heightMm * c;
  const scale = Math.min(
    width / oldWidth,
    height / oldHeight,
    (width - 2 * margin) / boundsW,
    (height - 2 * margin) / boundsH,
  );
  const next = {
    ...p,
    widthMm: p.widthMm * scale,
    heightMm: p.heightMm * scale,
    centerXmm: (p.centerXmm * width) / oldWidth,
    centerYmm: (p.centerYmm * height) / oldHeight,
  };
  if (shape === "circle") {
    const radius = Math.min(width, height) / 2 - margin;
    let imageRadius =
      crop === "circle" ? next.widthMm / 2 : Math.hypot(next.widthMm, next.heightMm) / 2;
    if (imageRadius > radius) {
      const fit = radius / imageRadius;
      next.widthMm *= fit;
      next.heightMm *= fit;
      imageRadius = radius;
    }
    const dx = next.centerXmm - width / 2,
      dy = next.centerYmm - height / 2;
    const distance = Math.hypot(dx, dy),
      allowed = radius - imageRadius;
    if (distance > allowed && distance > 0) {
      next.centerXmm = width / 2 + (dx / distance) * allowed;
      next.centerYmm = height / 2 + (dy / distance) * allowed;
    }
  } else {
    const halfW = crop === "circle" ? next.widthMm / 2 : (next.widthMm * c + next.heightMm * s) / 2;
    const halfH =
      crop === "circle" ? next.heightMm / 2 : (next.widthMm * s + next.heightMm * c) / 2;
    next.centerXmm = Math.max(margin + halfW, Math.min(width - margin - halfW, next.centerXmm));
    next.centerYmm = Math.max(margin + halfH, Math.min(height - margin - halfH, next.centerYmm));
  }
  return next;
}

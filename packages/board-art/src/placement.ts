import type { ArtPlacement, GrayImage } from "./types";

/** Image bounds are centred at X/Y in board coordinates; positive rotation is clockwise. */
export function fitArtPlacement(
  img: Pick<GrayImage, "width" | "height">,
  widthMm: number,
  heightMm: number,
  rotationDeg = 0,
  marginMm = 2,
): ArtPlacement {
  const radians = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(radians));
  const s = Math.abs(Math.sin(radians));
  const scale = Math.min(
    (widthMm - marginMm * 2) / (img.width * c + img.height * s),
    (heightMm - marginMm * 2) / (img.width * s + img.height * c),
  );
  return {
    centerXmm: widthMm / 2,
    centerYmm: heightMm / 2,
    widthMm: img.width * scale,
    heightMm: img.height * scale,
    rotationDeg,
  };
}

export function validateArtPlacement(p: ArtPlacement): ArtPlacement {
  for (const key of ["centerXmm", "centerYmm", "widthMm", "heightMm", "rotationDeg"] as const)
    if (!Number.isFinite(p[key])) throw new Error(`placement.${key} must be finite`);
  if (p.widthMm <= 0 || p.heightMm <= 0)
    throw new Error("artwork width and height must be positive");
  return { ...p, rotationDeg: ((p.rotationDeg % 360) + 360) % 360 };
}

/** Inverse transform used by every raster style, preview, PCB, and Gerber export. */
export function imagePointAt(
  p: ArtPlacement,
  img: Pick<GrayImage, "width" | "height">,
  x: number,
  y: number,
) {
  const a = (p.rotationDeg * Math.PI) / 180;
  const dx = x - p.centerXmm,
    dy = y - p.centerYmm;
  return {
    x: ((dx * Math.cos(a) + dy * Math.sin(a)) / p.widthMm + 0.5) * img.width,
    y: ((-dx * Math.sin(a) + dy * Math.cos(a)) / p.heightMm + 0.5) * img.height,
  };
}

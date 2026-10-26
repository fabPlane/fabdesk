import type { ArtPlacement, GrayImage, ImageCrop } from "./types";

/** Image bounds are centred at X/Y in board coordinates; positive rotation is clockwise. */
export function fitArtPlacement(
  img: Pick<GrayImage, "width" | "height">,
  widthMm: number,
  heightMm: number,
  rotationDeg = 0,
  marginMm = 2,
  crop: ImageCrop = "none",
): ArtPlacement {
  if (crop === "circle") img = { width: 1, height: 1 };
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
  crop: ImageCrop = "none",
) {
  const a = (p.rotationDeg * Math.PI) / 180;
  const dx = x - p.centerXmm,
    dy = y - p.centerYmm;
  if (crop !== "none") {
    const scale = Math.max(p.widthMm / img.width, p.heightMm / img.height);
    return {
      x: (dx * Math.cos(a) + dy * Math.sin(a)) / scale + img.width / 2,
      y: (-dx * Math.sin(a) + dy * Math.cos(a)) / scale + img.height / 2,
    };
  }
  return {
    x: ((dx * Math.cos(a) + dy * Math.sin(a)) / p.widthMm + 0.5) * img.width,
    y: ((-dx * Math.sin(a) + dy * Math.cos(a)) / p.heightMm + 0.5) * img.height,
  };
}

/** Crop coordinates follow the artwork transform, independently of the physical PCB outline. */
export function pointInArtworkCrop(
  p: ArtPlacement,
  crop: ImageCrop,
  x: number,
  y: number,
  inset = 0,
): boolean {
  if (crop === "none") return true;
  const a = (p.rotationDeg * Math.PI) / 180;
  const dx = x - p.centerXmm,
    dy = y - p.centerYmm;
  const lx = Math.abs(dx * Math.cos(a) + dy * Math.sin(a));
  const ly = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a));
  if (crop === "circle")
    return Math.hypot(lx, ly) <= Math.min(p.widthMm, p.heightMm) / 2 - inset + 1e-9;
  const halfW = p.widthMm / 2 - inset,
    halfH = p.heightMm / 2 - inset;
  if (halfW < 0 || halfH < 0 || lx > halfW || ly > halfH) return false;
  const r = Math.max(0, Math.min(p.widthMm, p.heightMm) * 0.12 - inset);
  return Math.hypot(Math.max(0, lx - (halfW - r)), Math.max(0, ly - (halfH - r))) <= r + 1e-9;
}

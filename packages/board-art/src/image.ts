import type { GrayImage, RgbaImage } from "./types";

export function rgbaToGray(img: RgbaImage): GrayImage {
  const pixels = new Uint8Array(img.width * img.height);
  const src = img.data;
  for (let i = 0, p = 0; i < pixels.length; i++, p += 4) {
    const r = src[p] ?? 0;
    const g = src[p + 1] ?? 0;
    const b = src[p + 2] ?? 0;
    const a = src[p + 3] ?? 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    pixels[i] = Math.round(luma * (a / 255) + 255 * (1 - a / 255));
  }
  return { width: img.width, height: img.height, pixels };
}

export function invertGray(img: GrayImage): GrayImage {
  const pixels = new Uint8Array(img.pixels.length);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 255 - (img.pixels[i] ?? 0);
  return { width: img.width, height: img.height, pixels };
}

/** Darkness 0–1 at pixel coordinates, bilinear. */
export function sampleDarkness(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = grayAt(img, x0, y0);
  const v10 = grayAt(img, x1, y0);
  const v01 = grayAt(img, x0, y1);
  const v11 = grayAt(img, x1, y1);
  const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  return 1 - v / 255;
}

export function grayAt(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
  return img.pixels[y * img.width + x] ?? 255;
}

export function makeGray(width: number, height: number, fill = 255): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function setPixel(img: GrayImage, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.pixels[y * img.width + x] = value;
}

/** Draw a filled disk (for fixtures). */
export function fillCircle(img: GrayImage, cx: number, cy: number, r: number, value: number): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) setPixel(img, x, y, value);
    }
  }
}

export function fillRect(img: GrayImage, x: number, y: number, w: number, h: number, value: number): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(img, xx, yy, value);
  }
}

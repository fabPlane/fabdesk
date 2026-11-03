import { rgbaToGray } from "./image";
import { decodePng, isPng } from "./png";
import type { GrayImage, RgbaImage } from "./types";

const MAX_BYTES = 12 * 1024 * 1024;

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (isPng(bytes)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "image/webp";
  }
  return null;
}

export async function decodeRaster(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.length > MAX_BYTES) throw new Error("image is larger than 12 MB");
  if (typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") {
    try {
      return await decodeViaBitmap(bytes);
    } catch {
      /* fall through to the PNG reader */
    }
  }
  if (isPng(bytes)) return decodePng(bytes);
  throw new Error(
    "only PNG is supported in this environment; JPEG, WebP and GIF need a browser or the desktop Art tab",
  );
}

async function decodeViaBitmap(bytes: Uint8Array): Promise<RgbaImage> {
  const mime = sniffImageMime(bytes) ?? "image/jpeg";
  const blob = new Blob([bytes.slice()], { type: mime });
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not decode image");
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  bmp.close();
  return { width, height, data: new Uint8Array(data.buffer.slice(0)) };
}

export async function decodeGray(bytes: Uint8Array): Promise<GrayImage> {
  const raster = await decodeRaster(bytes);
  return { ...rgbaToGray(raster), rgba: raster.data };
}

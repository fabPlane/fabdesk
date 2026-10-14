import type { GrayImage } from "@fabdesk/board-art";

/** Project-relative sketch name for a decoded picture uploaded as PNG for silk_art. */
export function sketchPngUploadName(source: string): string {
  const leaf = source.replace(/^.*\//, "");
  const dot = leaf.lastIndexOf(".");
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  return `${base || "art"}.png`;
}

export async function buildSketchPngFile(
  gray: GrayImage,
  sourceName: string | null | undefined,
  encode: (img: GrayImage) => Promise<Blob> = grayToPng,
): Promise<File> {
  const name = sketchPngUploadName(sourceName ?? "art.png");
  return new File([await encode(gray)], name, { type: "image/png" });
}

async function grayToPng(img: GrayImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not encode preview");
  const pix = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.pixels.length; i++) {
    const v = img.pixels[i] ?? 0;
    pix.data[i * 4] = v;
    pix.data[i * 4 + 1] = v;
    pix.data[i * 4 + 2] = v;
    pix.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(pix, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not encode PNG");
  return blob;
}

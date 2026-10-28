import { convertImage, previewSvg, type ArtOptions, type GrayImage } from "@fabdesk/board-art";

/** 300 pixels per inch at board size, capped to keep large boards within canvas limits. */
export function artImageSize(widthMm: number, heightMm: number) {
  const scale = Math.min(300 / 25.4, 4096 / Math.max(widthMm, heightMm));
  return {
    width: Math.max(1, Math.round(widthMm * scale)),
    height: Math.max(1, Math.round(heightMm * scale)),
  };
}

/** Render the finished board, including its mask/ink/base, without editing handles or stage. */
export async function buildArtPng(image: GrayImage, options: ArtOptions): Promise<Blob> {
  const art = convertImage(image, options);
  const svg = previewSvg(art.options, art.clipped, false, true);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not render the board image. Please try again."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    const size = artImageSize(art.options.widthMm, art.options.heightMm);
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create the board image.");
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the board image as PNG.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function artImageName(sourceName: string | null): string {
  const leaf = (sourceName ?? "art").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return `${leaf || "art"}-board.png`;
}

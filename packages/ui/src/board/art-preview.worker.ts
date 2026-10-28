import { convertImage, previewSvg, artworkOverlaySvg, type ArtOptions, type GrayImage } from "@fabdesk/board-art";

export type PreviewRequest =
  | { kind: "image"; image: GrayImage }
  | { kind: "render"; id: number; options: ArtOptions };
export type PreviewResult = { id: number; svg?: string; overlaySvg?: string; marks?: number; error?: string };
const scope = self as unknown as {
  onmessage: (event: MessageEvent<PreviewRequest>) => void;
  postMessage: (result: PreviewResult) => void;
};
let image: GrayImage | null = null;
scope.onmessage = ({ data }) => {
  if (data.kind === "image") {
    image = data.image;
    return;
  }
  try {
    if (!image) throw new Error("Upload an image to preview.");
    const art = convertImage(image, data.options);
    scope.postMessage({ id: data.id, svg: previewSvg(art.options, art.clipped), overlaySvg: artworkOverlaySvg(art), marks: art.clipped.length });
  } catch (error) {
    scope.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

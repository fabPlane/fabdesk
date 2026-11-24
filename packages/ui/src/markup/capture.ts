import { pcbSvgHasNativeCoordinates } from "@fabdesk/client-core";
import { clientPointToSvg, parseSvgViewBox } from "../board/svg-coords";
import { compositeSize, drawStrokesOnCanvas } from "./composite";
import { markupSvgFor } from "./drawing";
import { objectsInMarkupRegion } from "./hit-test";
import { formatMarkupContext, markupViewKind, markupViewLabel, type MarkupContext } from "./payload";
import { strokeBounds, type MarkupStroke } from "./strokes";
import { presentMarkupWebglCanvas } from "./webgl";

export type MarkupSnapshot = {
  blob: Blob | null;
  context: string;
};

export async function snapshotMarkup(opts: {
  overlay: HTMLElement;
  viewRoot: HTMLElement;
  strokes: readonly MarkupStroke[];
  tab: string;
  area: string;
}): Promise<MarkupSnapshot> {
  const overlayRect = opts.overlay.getBoundingClientRect();
  const size = compositeSize(overlayRect.width, overlayRect.height, window.devicePixelRatio || 1);
  const view = markupViewKind(opts.tab, opts.area);
  const viewLabel = markupViewLabel(opts.tab, opts.area);
  const markedCss = strokeBounds(opts.strokes);
  const drawing = markupSvgFor(
    opts.viewRoot,
    markedCss
      ? {
          left: overlayRect.left + markedCss.x,
          top: overlayRect.top + markedCss.y,
          right: overlayRect.left + markedCss.x + markedCss.w,
          bottom: overlayRect.top + markedCss.y + markedCss.h,
        }
      : undefined,
  );
  const viewport = drawing ? overlayToDrawingBox(drawing.host, drawing.svg, overlayRect, {
    x: 0,
    y: 0,
    w: overlayRect.width,
    h: overlayRect.height,
  }) : undefined;
  const marked = drawing && markedCss
    ? overlayToDrawingBox(drawing.host, drawing.svg, overlayRect, markedCss)
    : markedCss ?? undefined;
  const objects = drawing && marked
    ? objectsInMarkupRegion(drawing.svg, marked)
    : undefined;
  const ctx: MarkupContext = {
    view,
    viewLabel,
    imageAttached: false,
    ...(viewport ? { viewport: { ...viewport, units: drawing && pcbSvgHasNativeCoordinates(drawing.svg) ? "mm" : "sheet" } } : {}),
    ...(marked ? { marked } : {}),
    ...(objects && (objects.refdes.length || objects.nets.length) ? { objects } : {}),
  };

  let blob: Blob | null = null;
  try {
    blob = await compositeView(opts.viewRoot, overlayRect, opts.strokes, size);
  } catch {
    blob = null;
  }
  ctx.imageAttached = !!blob;
  return { blob, context: formatMarkupContext(ctx) };
}

function overlayToDrawingBox(
  host: HTMLElement,
  svg: string,
  overlay: DOMRect,
  css: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | undefined {
  const box = parseSvgViewBox(svg);
  const rect = host.getBoundingClientRect();
  if (!box || !rect.width || !rect.height) return undefined;
  const a = clientPointToSvg(box, rect, overlay.left + css.x, overlay.top + css.y);
  const b = clientPointToSvg(box, rect, overlay.left + css.x + css.w, overlay.top + css.y + css.h);
  if (!a || !b) return undefined;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

async function compositeView(
  root: HTMLElement,
  overlay: DOMRect,
  strokes: readonly MarkupStroke[],
  size: { width: number; height: number; scale: number },
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const bg = getComputedStyle(root).backgroundColor || "#14161a";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scaleX = size.width / Math.max(1, overlay.width);
  const scaleY = size.height / Math.max(1, overlay.height);
  const sources = [
    ...root.querySelectorAll<HTMLCanvasElement | HTMLImageElement>("canvas, img"),
  ].filter((el) => {
    if (el.closest(".fd-markup-overlay")) return false;
    if (el instanceof HTMLImageElement && el.classList.contains("hidden")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > overlay.top && r.top < overlay.bottom && r.right > overlay.left && r.left < overlay.right;
  });
  for (const el of sources) {
    const r = el.getBoundingClientRect();
    if (el instanceof HTMLCanvasElement) presentMarkupWebglCanvas(el);
    try {
      ctx.drawImage(
        el,
        (r.left - overlay.left) * scaleX,
        (r.top - overlay.top) * scaleY,
        r.width * scaleX,
        r.height * scaleY,
      );
    } catch {
      /* tainted or lost WebGL buffer — keep whatever we already drew */
    }
  }
  drawStrokesOnCanvas(ctx, strokes, size.scale);
  const blob = await canvasToBlob(canvas);
  return blob && blob.size > 0 ? blob : null;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

import { useEffect, useRef, useState } from "react";
import { svgRasterCache, svgRasterSize } from "./svg-raster-cache";
import { svgDetailRegion } from "./svg-detail-region";

/** Resize the existing bitmap immediately; refine vector detail once the user stops resizing. */
export function SvgCanvas({ svg, image, width, height, onState }: {
  svg: string; image: HTMLImageElement; width: number; height: number; onState?: (state: "loading" | "ready" | "failed") => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const detail = useRef<HTMLCanvasElement>(null);
  const painted = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const size = svgRasterSize(width, height, window.devicePixelRatio);
  useEffect(() => {
    setFailed(false);
    const paint = () => {
      const target = canvas.current;
      // The image may be loading the next drawing; the current pixels stay until it is ready.
      if (!target || !image.complete || !image.naturalWidth) return;
      try {
        // The source cache reuses URLs only for identical SVG text. Key by URL so
        // the pixel cache does not retain additional multi-megabyte SVG strings.
        const raster = svgRasterCache.get(image.src, size, () => {
          const buffer = document.createElement("canvas");
          buffer.width = size.width;
          buffer.height = size.height;
          const context = buffer.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.drawImage(image, 0, 0, buffer.width, buffer.height);
          return buffer;
        });
        target.width = raster.width;
        target.height = raster.height;
        const context = target.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.drawImage(raster, 0, 0);
        painted.current = svg; onState?.("ready");
      } catch {
        // Keep the original vector preview usable on hosts without a 2D canvas.
        setFailed(true); onState?.("loading");
      }
    };
    if (painted.current !== svg) { paint(); return; }
    const timer = setTimeout(paint, 120);
    return () => clearTimeout(timer);
  }, [svg, image, size.width, size.height, onState]);
  useEffect(() => {
    const target = detail.current, overview = canvas.current, host = overview?.parentElement;
    const viewport = host?.closest<HTMLElement>(".fd-svg-viewport");
    if (!target || !overview || !host || !viewport || failed) return;
    target.hidden = true;
    // Keep the cached overview during navigation. Only rasterize the visible
    // vector region after settling, so deep zoom stays sharp without allocating
    // a giant canvas for the full sheet or drawing continuously while panning.
    const ratio = window.devicePixelRatio || 1;
    if (size.width >= width * ratio * .95 && size.height >= height * ratio * .95) return;
    let timer: ReturnType<typeof setTimeout>;
    const paint = () => {
      if (host.dataset["focusMotion"] === "running") { timer = setTimeout(paint, 140); return; }
      if (!image.complete || !image.naturalWidth) return;
      const region = svgDetailRegion(host.getBoundingClientRect(), viewport.getBoundingClientRect(), width, height, ratio);
      if (!region) return;
      try {
        target.width = region.pixelsX; target.height = region.pixelsY;
        Object.assign(target.style, { left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, height: `${region.height}px` });
        const context = target.getContext("2d");
        if (!context) return;
        context.drawImage(image, region.x / width * image.naturalWidth, region.y / height * image.naturalHeight,
          region.width / width * image.naturalWidth, region.height / height * image.naturalHeight,
          0, 0, target.width, target.height);
        target.hidden = false;
        overview.style.opacity = "0"; // Avoid the coarse ink bleeding through transparent SVG regions.
      } catch {
        target.hidden = true;
        overview.style.opacity = "";
      }
    };
    const schedule = () => { target.hidden = true; overview.style.opacity = ""; clearTimeout(timer); timer = setTimeout(paint, 140); };
    const observer = new ResizeObserver(schedule); observer.observe(viewport);
    viewport.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => { clearTimeout(timer); observer.disconnect(); viewport.removeEventListener("scroll", schedule); overview.style.opacity = ""; target.hidden = true; target.width = 0; target.height = 0; };
  }, [svg, image, width, height, size.width, size.height, failed]);
  return <>
    <canvas ref={canvas} role="img" aria-label="Board preview" className={failed ? "hidden" : "block h-full w-full max-w-none"} />
    <canvas ref={detail} hidden aria-hidden="true" className="pointer-events-none absolute" />
    {failed && <img src={image.src} onLoad={() => onState?.("ready")} onError={() => onState?.("failed")} alt="Board preview" draggable={false} className="block h-full w-full max-w-none" />}
  </>;
}

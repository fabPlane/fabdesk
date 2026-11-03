import { useEffect, useRef, useState } from "react";
import { svgRasterCache, svgRasterSize } from "./svg-raster-cache";

/** Resize the existing bitmap immediately; refine vector detail once the user stops resizing. */
export function SvgCanvas({ svg, image, width, height }: {
  svg: string; image: HTMLImageElement; width: number; height: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const size = svgRasterSize(width, height, window.devicePixelRatio);
  useEffect(() => {
    setFailed(false);
    const paint = () => {
      const target = canvas.current;
      if (!target) return;
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
        painted.current = svg;
      } catch {
        // Keep the original vector preview usable on hosts without a 2D canvas.
        setFailed(true);
      }
    };
    if (painted.current !== svg) { paint(); return; }
    const timer = setTimeout(paint, 120);
    return () => clearTimeout(timer);
  }, [svg, image, size.width, size.height]);
  return <>
    <canvas ref={canvas} role="img" aria-label="Board preview" className={failed ? "hidden" : "block h-full w-full max-w-none"} />
    {failed && <img src={image.src} alt="Board preview" draggable={false} className="block h-full w-full max-w-none" />}
  </>;
}

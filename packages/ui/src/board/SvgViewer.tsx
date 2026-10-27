import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { cn } from "../util";
import { clientPointToSvg, parseSvgViewBox, resolveSvgBox, type SvgBox, type SvgPoint } from "./svg-coords";
import { svgImageCache } from "./svg-image-cache";

/** Zoomable vector image, isolated from the app's DOM and CSS layout. */
export function SvgViewer({ svg, viewKey, toolbar, overlay, commentMode = false, onDrawingClick }: {
  svg: string;
  /** Preserve zoom and scroll when only presentation (such as blend) changes. */
  viewKey?: string;
  toolbar?: ReactNode;
  overlay?: ReactNode | ((box: SvgBox | null) => ReactNode);
  commentMode?: boolean;
  onDrawingClick?: (point: SvgPoint, event?: MouseEvent<HTMLDivElement>) => void;
}) {
  const drawing = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<{ svg: string; url: string } | null>(null);
  const [loaded, setLoaded] = useState<{ url: string; width: number; height: number } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [fitSize, setFitSize] = useState({ width: 1, height: 1 });
  const viewBox = parseSvgViewBox(svg);
  const [fallback, setFallback] = useState<{ svg: string; box: SvgBox } | null>(null);
  const box = viewBox ?? (fallback?.svg === svg ? fallback.box : null);
  const current = source?.svg === svg ? source : null;
  // Keep the canvas dimensions while a presentation-only update loads, so the
  // browser does not collapse the scroll area and lose the comparison position.
  const size = viewBox
    ? current && loaded?.url === current.url ? loaded : viewKey ? loaded : null
    : box;
  const failed = current && failedUrl === current.url;

  useEffect(() => {
    if (!parseSvgViewBox(svg)) return;
    // KiCad renders can contain tens of thousands of paths. An image keeps those
    // nodes out of React's document and avoids synchronous SVG layout on mount.
    const image = svgImageCache.acquire(svg);
    setSource({ svg, url: image.url });
    return image.release;
  }, [svg]);

  useLayoutEffect(() => {
    if (parseSvgViewBox(svg)) return;
    // Legacy SVGs without a viewBox need their actual geometry bounds. Keep
    // this fallback for comment pins; normal board renders stay image-based.
    const element = drawing.current?.querySelector("svg");
    const resolved = resolveSvgBox(svg, element);
    if (!element || !resolved) return;
    element.setAttribute("viewBox", `${resolved.x} ${resolved.y} ${resolved.width} ${resolved.height}`);
    element.setAttribute("preserveAspectRatio", "xMidYMid meet");
    element.style.width = "100%";
    element.style.height = "100%";
    setFallback({ svg, box: resolved });
  }, [svg]);

  useEffect(() => {
    setZoom(1);
    viewport.current?.scrollTo(0, 0);
  }, [viewKey ?? svg]);

  useEffect(() => {
    const frame = viewport.current;
    if (!size || !frame) return;
    const { width, height } = size;
    const measure = () => {
      const inset = Number.parseFloat(getComputedStyle(frame).getPropertyValue("--fd-viewer-inset")) || 24;
      const scale = Math.min(Math.max(1, frame.clientWidth - inset) / width, Math.max(1, frame.clientHeight - inset) / height);
      const next = { width: width * scale, height: height * scale };
      setFitSize((prev) => prev.width === next.width && prev.height === next.height ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [size]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onDrawingClick || (event.target as HTMLElement | null)?.closest("[data-comment-pin], [data-canvas-tools]")) return;
    const host = drawing.current;
    if (!host || !box) return;
    const point = clientPointToSvg(box, host.getBoundingClientRect(), event.clientX, event.clientY);
    if (point) onDrawingClick(point, event);
  };
  return (
    <div className="fd-svg-viewer relative flex h-full flex-col">
      <div className="fd-svg-tools flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <Button size="sm" onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))} title="Zoom out">
          <Icon name="minus" width={16} height={16} />
        </Button>
        <span title="Zoom relative to fitted view" className="w-12 text-center font-mono text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
        <Button size="sm" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Zoom in">
          <Icon name="plus" width={16} height={16} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setZoom(1); viewport.current?.scrollTo(0, 0); }}>
          Fit
        </Button>
        <div className="fd-svg-context ml-auto flex items-center gap-1">{toolbar}</div>
      </div>
      <div ref={viewport} className="fd-svg-viewport min-h-0 flex-1 overflow-auto bg-panel-2/40 p-3">
        {!size && !failed && <div className="flex h-full items-center justify-center" role="status" aria-label="Loading board preview"><Spinner /></div>}
        {failed && <div className="p-4 text-sm text-muted" role="alert">Could not display this SVG preview. Try rendering it again.</div>}
        <div
          ref={drawing}
          onClick={handleClick}
          role={onDrawingClick ? "group" : undefined}
          tabIndex={onDrawingClick ? 0 : undefined}
          aria-label={onDrawingClick ? "Drawing canvas. Click a location, or press Enter to select the center." : undefined}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !box || !onDrawingClick) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onDrawingClick({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
            }
          }}
          className={cn("fd-svg-host relative mx-auto origin-top-left bg-panel", commentMode && "cursor-crosshair")}
          style={{ width: fitSize.width * zoom, height: fitSize.height * zoom, display: size || !viewBox ? "block" : "none" }}
        >
          {viewBox && current && <img
            src={current.url}
            alt="Board preview"
            decoding="async"
            draggable={false}
            className="block h-full w-full max-w-none"
            onLoad={(e) => {
              const image = e.currentTarget;
              if (image.naturalWidth && image.naturalHeight) {
                setLoaded({ url: current.url, width: image.naturalWidth, height: image.naturalHeight });
              } else setFailedUrl(current.url);
            }}
            onError={() => setFailedUrl(current.url)}
          />}
          {!viewBox && <div className="fd-svg-document h-full w-full" dangerouslySetInnerHTML={{ __html: svg }} />}
          {typeof overlay === "function" ? overlay(box) : overlay}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { DrawingViewportMemory, type DrawingViewport } from "@fabdesk/client-core";
import { Button, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { cn } from "../util";
import { clientPointToSvg, parseSvgViewBox, resolveSvgBox, type SvgBox, type SvgPoint } from "./svg-coords";
import { svgImageCache } from "./svg-image-cache";
import { SvgCanvas } from "./SvgCanvas";
import { useSvgNavigation } from "./useSvgNavigation";
import "./svg-viewer-tools.css";

const schematicViews = new DrawingViewportMemory();

/** Zoomable vector image, isolated from the app's DOM and CSS layout. */
export function SvgViewer({ svg, viewKey, viewportKey, toolbar, overlay, commentMode = false, initialFit = "sheet", fitLabel = "Fit sheet", focusRegion, onRegionFocused, onDrawingClick, onDrawingEscape }: {
  svg: string;
  /** Preserve zoom and scroll when only presentation (such as blend) changes. */
  viewKey?: string;
  /** Endpoint/source-qualified session memory; exact SVG bytes must still match. */
  viewportKey?: string;
  toolbar?: ReactNode;
  overlay?: ReactNode | ((box: SvgBox | null) => ReactNode);
  commentMode?: boolean;
  initialFit?: "sheet" | "width";
  fitLabel?: string;
  /** Verified SVG coordinates, never raw native coordinates without a frame check. */
  focusRegion?: SvgBox & { key: string };
  onRegionFocused?: () => void;
  onDrawingClick?: (point: SvgPoint, event?: MouseEvent<HTMLDivElement>) => void;
  /** Return true when a source-local selection was dismissed. */
  onDrawingEscape?: () => boolean;
}) {
  const circuitView = svg.includes('data-fabplane-schematic-view="circuit');
  const drawing = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const dragging = useSvgNavigation(viewport, drawing, zoom, setZoom, viewKey ?? svg, commentMode);
  const [source, setSource] = useState<{ svg: string; url: string } | null>(null);
  const [loaded, setLoaded] = useState<{ url: string; width: number; height: number } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [fitSize, setFitSize] = useState({ width: 1, height: 1 });
  const initialPosition = useRef(false);
  const savedView = useRef<DrawingViewport | null>(null);
  const restoredView = useRef(false);
  const currentView = useRef({ zoom, ready: false });
  useLayoutEffect(() => { currentView.current = { zoom, ready: fitSize.width > 1 && !!loaded }; }, [zoom, fitSize.width, loaded]);
  useLayoutEffect(() => {
    savedView.current = viewportKey ? schematicViews.read(viewportKey, svg) : null;
    restoredView.current = false;
    const frame = viewport.current;
    return () => {
      if (viewportKey && frame && currentView.current.ready) schematicViews.save(viewportKey, svg, { zoom: currentView.current.zoom, left: frame.scrollLeft, top: frame.scrollTop });
    };
  }, [viewportKey, svg]);
  useLayoutEffect(() => {
    const saved = savedView.current, frame = viewport.current;
    if (!saved || restoredView.current || !frame || fitSize.width <= 1 || !loaded) return;
    if (zoom !== saved.zoom) { setZoom(saved.zoom); return; }
    frame.scrollTo(saved.left, saved.top); restoredView.current = true;
  }, [zoom, fitSize.width, fitSize.height, loaded]);
  const viewBox = useMemo(() => parseSvgViewBox(svg), [svg]);
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
    if (!viewBox) return;
    // KiCad renders can contain tens of thousands of paths. An image keeps those
    // nodes out of React's document and avoids synchronous SVG layout on mount.
    const image = svgImageCache.acquire(svg);
    setSource({ svg, url: image.url });
    return image.release;
  }, [svg, viewBox]);

  useLayoutEffect(() => {
    if (viewBox) return;
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
  }, [svg, viewBox]);

  useEffect(() => {
    initialPosition.current = false;
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
      if (!initialPosition.current) {
        initialPosition.current = true;
        setZoom(savedView.current?.zoom ?? (initialFit === "width" ? Math.max(.2, (frame.clientWidth - inset) / next.width) : 1));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [size, initialFit]);
  const zoomAt = (value: number, x?: number, y?: number) => {
    const frame = viewport.current;
    if (!frame || !size) return;
    const next = Math.max(.2, Math.min(64, value)), rect = frame.getBoundingClientRect();
    const cx = x === undefined ? frame.clientWidth / 2 : x - rect.left, cy = y === undefined ? frame.clientHeight / 2 : y - rect.top;
    const host = drawing.current?.getBoundingClientRect();
    const localX = host ? (rect.left + cx - host.left) / zoom : 0, localY = host ? (rect.top + cy - host.top) / zoom : 0;
    setZoom(next);
    requestAnimationFrame(() => {
      const after = drawing.current?.getBoundingClientRect();
      if (after) frame.scrollBy(after.left + localX * next - rect.left - cx, after.top + localY * next - rect.top - cy);
    });
  };
  const focusedRegion = useRef<string | null>(null);
  useEffect(() => {
    const frame = viewport.current;
    if (!focusRegion || focusedRegion.current === focusRegion.key || !frame || !box || !size || !current || loaded?.url !== current.url || fitSize.width <= 1 || fitSize.height <= 1) return;
    focusedRegion.current = focusRegion.key;
    const next = Math.max(.2, Math.min(64, Math.min((frame.clientWidth - 72) / (focusRegion.width / box.width * fitSize.width), (frame.clientHeight - 120) / (focusRegion.height / box.height * fitSize.height))));
    const center = { x: (focusRegion.x + focusRegion.width / 2 - box.x) / box.width, y: (focusRegion.y + focusRegion.height / 2 - box.y) / box.height };
    setZoom(next);
    const animation = requestAnimationFrame(() => {
      const host = drawing.current?.getBoundingClientRect(), rect = frame.getBoundingClientRect();
      if (!host) return;
      frame.scrollBy(host.left + center.x * host.width - rect.left - frame.clientWidth / 2, host.top + center.y * host.height - rect.top - frame.clientHeight / 2);
      onRegionFocused?.();
    });
    return () => { cancelAnimationFrame(animation); focusedRegion.current = null; };
  }, [focusRegion?.key, box?.width, box?.height, current?.url, loaded?.url, size, fitSize.width, fitSize.height]);
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onDrawingClick || (event.target as HTMLElement | null)?.closest("[data-comment-pin], [data-canvas-tools]")) return;
    const host = drawing.current;
    if (!host || !box) return;
    const point = clientPointToSvg(box, host.getBoundingClientRect(), event.clientX, event.clientY);
    if (point) onDrawingClick(point, event);
  };
  return (
    <div className="fd-svg-viewer relative flex h-full flex-col" onKeyDown={event => { if (event.key === "Escape" && onDrawingEscape?.()) { event.preventDefault(); event.stopPropagation(); requestAnimationFrame(() => drawing.current?.focus({ preventScroll: true })); } }}>
      <div className="fd-svg-tools flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <div className="fd-svg-zoom-group" role="group" aria-label="Drawing zoom">
        <Button size="sm" onClick={() => zoomAt(zoom / 1.25)} title="Zoom out" aria-label="Zoom out">
          <Icon name="minus" width={16} height={16} />
        </Button>
        <span className="fd-svg-zoom-value" title={`Zoom relative to the fitted drawing. ${circuitView ? "Fit circuit" : fitLabel} resets to 100%.`}>{Math.round(zoom * 100)}%</span>
        <Button size="sm" onClick={() => zoomAt(zoom * 1.25)} title="Zoom in" aria-label="Zoom in">
          <Icon name="plus" width={16} height={16} />
        </Button>
        </div>
        <Button size="sm" className="fd-svg-fit-button" title="Show the whole drawing" onClick={() => { setZoom(1); viewport.current?.scrollTo(0, 0); }}>
          {circuitView ? "Fit circuit" : fitLabel}
        </Button>
        <Button size="sm" className="fd-svg-fit-button" title="Fill the available width; scroll to see the rest" onClick={() => { if (viewport.current) { zoomAt((viewport.current.clientWidth - 24) / fitSize.width); requestAnimationFrame(() => viewport.current?.scrollTo(0, 0)); } }}>Fit width</Button>
        {toolbar && <div className="fd-svg-context ml-auto flex items-center gap-1">{toolbar}</div>}
      </div>
      <div ref={viewport} tabIndex={0} aria-label="Drawing viewport. Drag to pan; scroll to zoom. Plus and minus zoom; arrow keys pan." className={cn("fd-svg-viewport min-h-0 flex-1 select-none overflow-auto overscroll-contain bg-panel-2/40 p-3", dragging ? "cursor-grabbing" : commentMode ? "cursor-crosshair" : "cursor-grab")}
        onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(zoom * 1.25); } else if (event.key === "-") { event.preventDefault(); zoomAt(zoom / 1.25); } }}
        >
        {!size && !failed && <div className="flex h-full items-center justify-center" role="status" aria-label="Loading board preview"><Spinner /></div>}
        {failed && <div className="p-4 text-sm text-muted" role="alert">Could not display this SVG preview. Try rendering it again.</div>}
        <div className={focusRegion ? "fd-svg-focus-stage" : "contents"}>
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
          className={cn("fd-svg-host relative mx-auto origin-top-left bg-panel", dragging ? "cursor-grabbing" : commentMode && "cursor-crosshair")}
          style={{ width: fitSize.width * zoom, height: fitSize.height * zoom, display: size || !viewBox ? "block" : "none" }}
        >
          {viewBox && current && <img
            ref={image}
            src={current.url}
            alt=""
            aria-hidden="true"
            decoding="async"
            draggable={false}
            className="hidden"
            onLoad={(e) => {
              const image = e.currentTarget;
              if (image.naturalWidth && image.naturalHeight) {
                setLoaded({ url: current.url, width: image.naturalWidth, height: image.naturalHeight });
              } else setFailedUrl(current.url);
            }}
            onError={() => setFailedUrl(current.url)}
          />}
          {viewBox && current && loaded?.url === current.url && image.current && fitSize.width > 1 && (
            <SvgCanvas svg={svg} image={image.current} width={fitSize.width * zoom} height={fitSize.height * zoom} />
          )}
          {!viewBox && <div className="fd-svg-document h-full w-full" dangerouslySetInnerHTML={{ __html: svg }} />}
          {typeof overlay === "function" ? overlay(box) : overlay}
        </div>
        </div>
      </div>
    </div>
  );
}

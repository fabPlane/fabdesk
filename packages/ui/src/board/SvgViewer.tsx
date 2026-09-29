import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** Zoomable host for an SVG string (schematic / PCB renders). */
export function SvgViewer({ svg, toolbar }: { svg: string; toolbar?: React.ReactNode }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const [fitSize, setFitSize] = useState({ width: 1, height: 1 });
  useLayoutEffect(() => {
    const el = drawing.current?.querySelector("svg");
    const frame = viewport.current;
    if (!el || !frame) return;
    let box = el.viewBox.baseVal;
    if (!box.width || !box.height) {
      const bounds = el.getBBox();
      if (!bounds.width || !bounds.height) return;
      el.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
      box = el.viewBox.baseVal;
    }
    const width = box.width, height = box.height;
    el.setAttribute("preserveAspectRatio", "xMidYMid meet");
    el.style.width = "100%";
    el.style.height = "100%";
    const measure = () => {
      const scale = Math.min(Math.max(1, frame.clientWidth - 24) / width, Math.max(1, frame.clientHeight - 24) / height);
      setFitSize({ width: width * scale, height: height * scale });
    };
    setZoom(1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [svg]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
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
        <div className="ml-auto flex items-center gap-1">{toolbar}</div>
      </div>
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto bg-panel-2/40 p-3">
        <div
          ref={drawing}
          className="fd-svg-host mx-auto origin-top-left bg-panel"
          style={{ width: fitSize.width * zoom, height: fitSize.height * zoom }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

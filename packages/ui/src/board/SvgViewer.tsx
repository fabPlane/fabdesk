import { useState } from "react";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** Zoomable host for an SVG string (schematic / PCB renders). */
export function SvgViewer({ svg, toolbar }: { svg: string; toolbar?: React.ReactNode }) {
  const [zoom, setZoom] = useState(1);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <Button size="sm" onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))} title="Zoom out">
          <Icon name="minus" width={16} height={16} />
        </Button>
        <span className="w-12 text-center font-mono text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
        <Button size="sm" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Zoom in">
          <Icon name="plus" width={16} height={16} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>
          Fit
        </Button>
        <div className="ml-auto flex items-center gap-1">{toolbar}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-panel-2/40 p-3">
        <div
          className="fd-svg-host mx-auto origin-top-left bg-panel"
          style={{ width: `${zoom * 100}%`, height: zoom === 1 ? "100%" : undefined }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

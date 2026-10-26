import { useEffect, useRef, type PointerEvent } from "react";
import type { ArtPlacement, ImageCrop } from "@fabdesk/board-art";
import { Button } from "../components/ui";
import { resizeArtwork } from "./art-placement";

export function ArtPlacementControls({
  crop,
  value,
  onChange,
  lock,
  onLock,
  onFit,
  onReset,
  widthMm,
  heightMm,
}: {
  crop: ImageCrop;
  value: ArtPlacement;
  onChange: (p: ArtPlacement) => void;
  lock: boolean;
  onLock: (lock: boolean) => void;
  onFit: () => void;
  onReset: () => void;
  widthMm: number;
  heightMm: number;
}) {
  const field = (key: keyof ArtPlacement, label: string) => (
    <label className="fd-art-field">
      {label}
      <input
        type="number"
        aria-label={label}
        step={key === "rotationDeg" ? 1 : 0.1}
        value={Number(value[key].toFixed(2))}
        min={key === "widthMm" || key === "heightMm" ? 1 : undefined}
        max={key === "widthMm" || key === "heightMm" ? 800 : undefined}
        onChange={(e) => {
          const next = e.currentTarget.valueAsNumber;
          if (!Number.isFinite(next)) return;
          if ((key === "widthMm" || key === "heightMm") && (next < 1 || next > 800)) return;
          const updated = { ...value, [key]: next };
          if ((lock || crop === "circle") && key === "widthMm")
            updated.heightMm = (next * value.heightMm) / value.widthMm;
          if ((lock || crop === "circle") && key === "heightMm")
            updated.widthMm = (next * value.widthMm) / value.heightMm;
          if (updated.widthMm > 800 || updated.heightMm > 800) return;
          onChange(updated);
        }}
      />
    </label>
  );
  return (
    <section className="fd-art-placement-controls" aria-label="Artwork placement">
      <div className="fd-art-label">Artwork placement</div>
      <p className="mt-1 text-[11px] text-muted">
        Drag the outlined image on the board. Pull a corner to resize or the round handle to rotate.
      </p>
      <details className="fd-art-precise">
        <summary>Exact position & size</summary>
        <div className="fd-art-position-fields">
          {field("centerXmm", "Centre X (mm)")}
          {field("centerYmm", "Centre Y (mm)")}
          {field("widthMm", "Image width (mm)")}
          {field("heightMm", "Image height (mm)")}
          {field("rotationDeg", "Rotation (°)")}
        </div>
      </details>
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={lock || crop === "circle"}
          disabled={crop === "circle"}
          onChange={(e) => onLock(e.target.checked)}
        />
        Lock proportions
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => onChange({ ...value, centerXmm: widthMm / 2, centerYmm: heightMm / 2 })}
        >
          Centre
        </Button>
        <Button size="sm" onClick={onFit}>
          Fit to board
        </Button>
        <Button size="sm" onClick={onReset}>
          Reset
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Crop and image move together. The board stays fixed.
      </p>
    </section>
  );
}

export function ArtPlacementOverlay({
  crop,
  value,
  onChange,
  widthMm,
  heightMm,
  lock,
  disabled,
}: {
  crop: ImageCrop;
  value: ArtPlacement;
  onChange: (p: ArtPlacement) => void;
  widthMm: number;
  heightMm: number;
  lock: boolean;
  disabled: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const pending = useRef<ArtPlacement | null>(null);
  const frame = useRef<number | null>(null);
  const flush = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (pending.current) {
      onChange(pending.current);
      pending.current = null;
    }
  };
  const schedule = (next: ArtPlacement) => {
    pending.current = next;
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const drag = useRef<{
    value: ArtPlacement;
    x: number;
    y: number;
    kind: "move" | "rotate" | "resize";
    cornerX: number;
    cornerY: number;
  } | null>(null);
  const point = (e: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    return matrix ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()) : null;
  };
  const start = (
    e: PointerEvent<SVGElement>,
    kind: "move" | "rotate" | "resize",
    cornerX = 1,
    cornerY = 1,
  ) => {
    if (disabled || e.button !== 0) return;
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { value, x: p.x, y: p.y, kind, cornerX, cornerY };
  };
  return (
    <svg
      ref={svg}
      className="fd-art-placement-overlay"
      viewBox={`-4 -4 ${widthMm + 8} ${heightMm + 8}`}
      aria-label="Drag, resize, or rotate artwork"
      onPointerMove={(e) => {
        const d = drag.current,
          p = point(e);
        if (!d || !p) return;
        if (d.kind === "move")
          schedule({
            ...d.value,
            centerXmm: d.value.centerXmm + p.x - d.x,
            centerYmm: d.value.centerYmm + p.y - d.y,
          });
        if (d.kind === "resize")
          schedule(
            resizeArtwork(d.value, p.x, p.y, d.cornerX, d.cornerY, lock || crop === "circle"),
          );
        if (d.kind === "rotate") {
          const initial = Math.atan2(d.y - d.value.centerYmm, d.x - d.value.centerXmm);
          const current = Math.atan2(p.y - d.value.centerYmm, p.x - d.value.centerXmm);
          let angle = d.value.rotationDeg + ((current - initial) * 180) / Math.PI;
          if (e.shiftKey) angle = Math.round(angle / 15) * 15;
          schedule({ ...d.value, rotationDeg: ((angle % 360) + 360) % 360 });
        }
      }}
      onPointerUp={() => {
        flush();
        drag.current = null;
      }}
      onPointerCancel={() => {
        flush();
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        flush();
        drag.current = null;
      }}
    >
      <g
        transform={`translate(${value.centerXmm} ${value.centerYmm}) rotate(${value.rotationDeg})`}
      >
        <rect
          className="fd-art-placement-box"
          rx={
            crop === "circle"
              ? value.widthMm / 2
              : crop === "rounded"
                ? Math.min(value.widthMm, value.heightMm) * 0.12
                : 0
          }
          ry={
            crop === "circle"
              ? value.heightMm / 2
              : crop === "rounded"
                ? Math.min(value.widthMm, value.heightMm) * 0.12
                : 0
          }
          x={-value.widthMm / 2}
          y={-value.heightMm / 2}
          width={value.widthMm}
          height={value.heightMm}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label="Move artwork; use arrow keys for fine positioning"
          onPointerDown={(e) => start(e, "move")}
          onKeyDown={(e) => {
            if (disabled) return;
            const step = e.shiftKey ? 1 : 0.1;
            const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
            const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
            if (dx || dy) {
              e.preventDefault();
              e.stopPropagation();
              onChange({
                ...value,
                centerXmm: value.centerXmm + dx,
                centerYmm: value.centerYmm + dy,
              });
            }
          }}
        />
        <line
          className="fd-art-placement-stem"
          x1={0}
          x2={0}
          y1={-value.heightMm / 2}
          y2={-value.heightMm / 2 - 3}
        />
        <circle
          className="fd-art-placement-rotate"
          cx={0}
          cy={-value.heightMm / 2 - 3}
          r={1}
          onPointerDown={(e) => start(e, "rotate")}
        >
          <title>Drag to rotate; Shift snaps to 15°</title>
        </circle>
        {([-1, 1] as const).flatMap((x) =>
          ([-1, 1] as const).map((y) => (
            <rect
              key={`${x}:${y}`}
              className="fd-art-placement-handle"
              x={(x * value.widthMm) / 2 - 0.9}
              y={(y * value.heightMm) / 2 - 0.9}
              width={1.8}
              height={1.8}
              onPointerDown={(e) => start(e, "resize", x, y)}
            >
              <title>Drag corner to resize artwork</title>
            </rect>
          )),
        )}
      </g>
    </svg>
  );
}

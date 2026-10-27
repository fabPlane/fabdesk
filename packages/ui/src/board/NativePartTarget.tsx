import { useRef } from "react";
import { createPortal } from "react-dom";
import { clientPointToSvg, svgPointToPercent, type SvgBox, type SvgPoint } from "./svg-coords";

/** A position proposal only. Native geometry is saved by the parent's explicit Apply action. */
export function NativePartTarget({ host, box, point, reference, changed, onMove }: { host: HTMLElement; box: SvgBox; point: SvgPoint; reference: string; changed: boolean; onMove: (point: SvgPoint) => void }) {
  const drag = useRef<{ pointerId: number; start: SvgPoint } | null>(null);
  const position = svgPointToPercent(box, point);
  if (!position) return null;
  const snap = (value: number, fine: boolean) => Math.round(value * (fine ? 100 : 10)) / (fine ? 100 : 10);
  const propose = (next: SvgPoint, fine: boolean) => onMove({
    x: Math.max(box.x, Math.min(box.x + box.width, snap(next.x, fine))),
    y: Math.max(box.y, Math.min(box.y + box.height, snap(next.y, fine))),
  });
  return createPortal(<button type="button" data-canvas-tools data-native-part-target className="fd-native-part-target" style={{ left: `${position.left}%`, top: `${position.top}%` }}
    aria-label={`Drag ${reference} position target. Arrow keys move 0.1 mm; Shift moves 0.01 mm. Apply position to save.`}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
      drag.current = { pointerId: event.pointerId, start: { ...point } };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic development events cannot capture a physical pointer. */ }
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const next = clientPointToSvg(box, host.getBoundingClientRect(), event.clientX, event.clientY);
      if (next) propose(next, event.shiftKey);
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const next = clientPointToSvg(box, host.getBoundingClientRect(), event.clientX, event.clientY);
      if (next) propose(next, event.shiftKey);
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      event.stopPropagation();
    }}
    onPointerCancel={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      onMove(drag.current.start); drag.current = null;
      event.stopPropagation();
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); onMove(drag.current.start); drag.current = null; return; }
      const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!movement || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? .01 : .1;
      propose({ x: point.x + movement[0]! * step, y: point.y + movement[1]! * step }, event.shiftKey);
    }}>
    <span aria-hidden="true">✥</span><span className="fd-native-part-target-label">{reference} · {changed ? "preview" : "drag target"}</span>
  </button>, host);
}

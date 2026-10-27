import { useEffect, useRef } from "react";
import { snapNativePoint, nudgeNativePoint } from "@fabdesk/client-core";
import { createPortal } from "react-dom";
import { clientPointToSvg, svgPointToPercent, type SvgBox, type SvgPoint } from "./svg-coords";

type TargetProps = { host: HTMLElement; box: SvgBox; point: SvgPoint; reference: string; changed: boolean; onMove: (point: SvgPoint) => void; constrainToDrawing?: boolean; corner?: boolean; snapOrigin?: SvgPoint; ariaLabel?: string; targetLabel?: string };
type ActiveDrag = { pointerId: number; start: SvgPoint; cancel: () => void; cleanup: () => void };

/** A proposal only. Native geometry is saved by the parent's explicit Apply action. */
export function NativePartTarget({ host, box, point, reference, changed, onMove, constrainToDrawing = true, corner = false, snapOrigin, ariaLabel, targetLabel }: TargetProps) {
  const drag = useRef<ActiveDrag | null>(null);
  useEffect(() => () => drag.current?.cleanup(), []);
  const position = svgPointToPercent(box, point);
  if (!position) return null;
  const propose = (next: SvgPoint) => onMove(constrainToDrawing ? {
    x: Math.max(box.x, Math.min(box.x + box.width, next.x)),
    y: Math.max(box.y, Math.min(box.y + box.height, next.y)),
  } : next);
  return createPortal(<button type="button" data-canvas-tools data-native-part-target className="fd-native-part-target" data-corner={corner} style={{ left: `${position.left}%`, top: `${position.top}%` }}
    aria-label={ariaLabel ?? `Drag ${reference} position target. Arrow keys move 0.1 mm; Shift moves 0.01 mm. Apply position to save.`}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.stopPropagation();
      const button = event.currentTarget, pointerId = event.pointerId;
      button.focus();
      const start = { ...point }, clientStart = { x: event.clientX, y: event.clientY };
      let moved = false;
      const matches = (e: PointerEvent) => e.pointerId === pointerId && drag.current === active;
      const update = (e: PointerEvent) => {
        const next = clientPointToSvg(box, host.getBoundingClientRect(), e.clientX, e.clientY);
        if (next) propose(snapNativePoint(next, e.shiftKey, snapOrigin));
      };
      const move = (e: PointerEvent) => {
        if (!matches(e) || !moved && Math.hypot(e.clientX - clientStart.x, e.clientY - clientStart.y) < 3) return;
        e.preventDefault(); e.stopPropagation(); moved = true; update(e);
      };
      const up = (e: PointerEvent) => {
        if (!matches(e)) return;
        if (moved || Math.hypot(e.clientX - clientStart.x, e.clientY - clientStart.y) >= 3) {
          e.preventDefault(); update(e);
          // A fallback drag can end outside the handle; suppress only its immediate click.
          const suppress = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
          window.addEventListener("click", suppress, { capture: true, once: true });
          setTimeout(() => window.removeEventListener("click", suppress, true), 0);
        }
        e.stopPropagation(); active.cleanup();
      };
      const cancelPointer = (e: PointerEvent) => { if (matches(e)) { e.stopPropagation(); active.cancel(); } };
      const restart = (e: PointerEvent) => { if (matches(e)) active.cancel(); };
      const blur = () => active.cancel();
      const active: ActiveDrag = { pointerId, start,
        cancel: () => { if (drag.current !== active) return; onMove(start); active.cleanup(); },
        cleanup: () => {
          window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true);
          window.removeEventListener("pointercancel", cancelPointer, true); window.removeEventListener("pointerdown", restart, true); window.removeEventListener("blur", blur);
          if (drag.current === active) drag.current = null;
          try { if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId); } catch { /* The native pointer may already have ended. */ }
        },
      };
      drag.current = active;
      // Track outside the handle even when capture is unavailable or an OS driver drops it.
      window.addEventListener("pointermove", move, { capture: true, passive: false }); window.addEventListener("pointerup", up, { capture: true, passive: false });
      window.addEventListener("pointercancel", cancelPointer, true); window.addEventListener("pointerdown", restart, true); window.addEventListener("blur", blur);
      try { button.setPointerCapture(pointerId); } catch { /* Scoped window listeners remain active until up/cancel/blur. */ }
    }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); drag.current.cancel(); return; }
      const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as Partial<Record<string, "left" | "right" | "up" | "down">>)[event.key];
      if (!direction || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); onMove(nudgeNativePoint(point, direction, event.shiftKey));
    }}>
    <span aria-hidden="true">{corner ? "↘" : "✥"}</span><span className="fd-native-part-target-label">{targetLabel ?? `${reference} · ${changed ? "preview" : "drag target"}`}</span>
  </button>, host);
}

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

/** Wheel zoom follows the cursor; pointer capture keeps a drag alive outside the preview. */
export function useSvgNavigation(
  viewport: RefObject<HTMLDivElement | null>,
  drawing: RefObject<HTMLDivElement | null>,
  zoom: number,
  setZoom: Dispatch<SetStateAction<number>>,
  viewKey: string,
  commentMode = false,
) {
  const currentZoom = useRef(zoom);
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    currentZoom.current = zoom;
    const point = anchor.current;
    const frame = viewport.current;
    const host = drawing.current;
    anchor.current = null;
    if (!point || !frame || !host) return;
    const rect = host.getBoundingClientRect();
    frame.scrollLeft += rect.left + point.x * rect.width - point.clientX;
    frame.scrollTop += rect.top + point.y * rect.height - point.clientY;
  }, [zoom, viewport, drawing]);

  useEffect(() => {
    const frame = viewport.current;
    if (!frame) return;
    let drag: { id: number; target: Element; x: number; y: number; left: number; top: number } | null = null;
    let moved = false;
    setDragging(false);
    anchor.current = null;

    const wheel = (event: WheelEvent) => {
      const host = drawing.current;
      if (!host || !event.deltaY) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // React's delegated wheel listener is passive; this native listener must
      // cancel page scrolling (and browser zoom for trackpad pinch gestures).
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
      const next = Math.max(0.2, Math.min(64, currentZoom.current * Math.exp(-delta * 0.002)));
      if (next === currentZoom.current) return;
      anchor.current = {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      currentZoom.current = next;
      setZoom(next);
    };
    const down = (event: PointerEvent) => {
      if (drag || event.pointerType === "touch" || (event.button !== 0 && event.button !== 1)) return;
      if (commentMode && event.button === 0) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest("button, a, input, textarea, select, [data-comment-pin], [data-canvas-tools]")) return;
      if (event.button === 1) event.preventDefault(); // Disable middle-button autoscroll.
      moved = false;
      // Capture on the original target so a stationary click still reaches the
      // drawing's comment handler; capturing on the viewport would retarget it.
      target.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, target, x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop };
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) { moved = true; setDragging(true); }
      event.preventDefault();
      frame.scrollLeft = drag.left - dx;
      frame.scrollTop = drag.top - dy;
    };
    const stop = () => {
      const previous = drag;
      drag = null;
      setDragging(false);
      if (previous?.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
    };
    const up = (event: PointerEvent) => { if (drag?.id === event.pointerId) stop(); };
    const click = (event: MouseEvent) => {
      if (!moved) return;
      // A drag must never create a comment pin on release.
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    frame.addEventListener("pointerdown", down);
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", up);
    frame.addEventListener("lostpointercapture", up);
    frame.addEventListener("click", click, true);
    window.addEventListener("blur", stop);
    return () => {
      frame.removeEventListener("wheel", wheel);
      frame.removeEventListener("pointerdown", down);
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", up);
      frame.removeEventListener("lostpointercapture", up);
      frame.removeEventListener("click", click, true);
      window.removeEventListener("blur", stop);
      if (drag?.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
      anchor.current = null;
    };
  }, [viewport, drawing, setZoom, viewKey, commentMode]);

  return dragging;
}

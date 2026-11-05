import { useEffect, useRef, type ReactNode } from "react";

/** Shared presentation only. Each source surface verifies its own saved finding and drawing. */
export function SavedFindingOverlay({ description, detail, point, position, outside, focusKey, canFocus, children }: {
  description: string;
  detail: string;
  point: { x: number; y: number };
  position: { left: number; top: number } | null;
  outside: boolean;
  focusKey: unknown;
  canFocus: () => boolean;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null), focusGuard = useRef(canFocus);
  focusGuard.current = canFocus;
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    // SVG hosts remain hidden until their image loads. Wait for the card to be painted.
    const focus = () => {
      if (!element.getClientRects().length) return;
      observer.disconnect();
      if (focusGuard.current() && document.activeElement === document.body) element.focus({ preventScroll: true });
    };
    const observer = new ResizeObserver(focus);
    observer.observe(element);
    const frame = requestAnimationFrame(focus);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [focusKey]);
  return <div className="fd-root-finding-overlay" data-canvas-tools>
    {position && <div className="fd-root-finding-marker" role="img" aria-label={`Saved PCB finding at ${point.x}, ${point.y} mm`} style={{ left: `${position.left}%`, top: `${position.top}%` }}><span /></div>}
    <section ref={card} tabIndex={-1} className="fd-root-finding-card" style={position && position.top > 50 ? { top: 14, bottom: "auto" } : undefined} aria-label="Selected saved PCB finding">
      <strong>{description}</strong><p>{detail}</p>
      {outside && <p>This reported position lies outside the displayed drawing.</p>}
      <div>{children}</div>
    </section>
  </div>;
}

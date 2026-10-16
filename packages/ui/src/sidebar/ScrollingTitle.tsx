import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Reveal only the clipped portion, at a steady reading speed, while hovering a row. */
export function ScrollingTitle({ text }: { text: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = label.current;
    if (!outer || !inner) return;
    const measure = () => setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  }, [text]);
  return (
    <span ref={viewport} className="fd-scrolling-title min-w-0 flex-1" title={text} data-overflow={overflow > 1}
      style={{ "--title-travel": `${-overflow}px`, "--title-duration": `${Math.max(2, overflow / 24)}s` } as CSSProperties}>
      <span ref={label} className="fd-scrolling-title-text">{text}</span>
    </span>
  );
}

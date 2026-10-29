import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Keep requested details scrollable above the corner assistant on short windows. */
export function CheckFindingDetails({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => setMaxHeight(Math.max(160, window.innerHeight - element.getBoundingClientRect().top - 96));
    measure();
    const observer = new ResizeObserver(measure);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); document.removeEventListener("scroll", measure, true); };
  }, []);
  return <aside ref={panel} className="fd-checks-detail" aria-label="Finding details" style={{ maxHeight }}>{children}</aside>;
}

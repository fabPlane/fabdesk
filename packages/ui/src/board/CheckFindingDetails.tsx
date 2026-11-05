import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/ui";

/** Keep requested details scrollable above the corner assistant on short windows. */
export function CheckFindingDetails({ children, onClose }: { children: ReactNode; onClose: () => void }) {
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
  return <aside ref={panel} className="fd-checks-detail" aria-label="Finding details" style={{ maxHeight }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="fd-checks-detail-header"><h3>Finding details</h3><IconButton title="Close finding details" size="sm" onClick={onClose}><Icon name="close" width={18} height={18} /></IconButton></header>
    {children}
  </aside>;
}

export function CheckFindingItem({ index, description, pos, children }: { index: number; description: string; pos?: { x: number; y: number } | undefined; children: ReactNode }) {
  return <section className="fd-checks-finding-item" aria-label={`Affected item ${index + 1}`}>
    <span className="fd-checks-item-number">Item {index + 1}</span>
    <p>{description}</p>
    <span className="fd-checks-coordinates">{pos ? `X ${pos.x.toFixed(3)} · Y ${pos.y.toFixed(3)} mm` : "No position recorded"}</span>
    {children}
  </section>;
}

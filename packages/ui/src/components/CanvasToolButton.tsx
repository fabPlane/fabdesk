import { Button, type ButtonProps } from "./ui";
import { Icon, type IconName } from "./Icon";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Stable icon target; its name remains available to keyboard and assistive technology. */
export function CanvasToolButton({ label, icon, active, className = "", ...props }: Omit<ButtonProps, "children"> & { label: string; icon: IconName; active?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null), tooltip = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(), tip = tooltip.current?.getBoundingClientRect();
      if (!rect || !tip) return;
      setPosition({ left: Math.max(8, Math.min(rect.left + rect.width / 2 - tip.width / 2, innerWidth - tip.width - 8)), top: rect.bottom + tip.height + 16 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - tip.height - 8) });
    };
    // Loading media can resize a centered dialog without scrolling the window.
    // Follow that layout change rather than leaving the label at its old height.
    const observer = new ResizeObserver(place);
    for (let node: HTMLElement | null = anchor.current; node; node = node.parentElement) observer.observe(node);
    if (tooltip.current) observer.observe(tooltip.current);
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible, label]);
  return <span ref={anchor} className="fd-canvas-tool" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)} onFocus={() => setVisible(true)} onBlur={() => setVisible(false)}>
    <Button {...props} size="sm" variant={active ? "secondary" : props.variant ?? "ghost"} className={`fd-canvas-tool-button ${className}`} aria-label={label} aria-pressed={active}>
      <Icon name={icon} width={18} height={18} aria-hidden="true" />
    </Button>
    {visible && createPortal(<span ref={tooltip} className="fd-floating-tool-label" style={position} aria-hidden="true">{label}</span>, document.body)}
  </span>;
}

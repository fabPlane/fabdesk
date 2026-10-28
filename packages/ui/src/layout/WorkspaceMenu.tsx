import { useEffect, useRef, useState, type ReactNode } from "react";

/** Native disclosure behavior with dismissal, without opening a second workspace panel. */
export function WorkspaceMenu({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <details ref={ref} open={open} className={`fd-workspace-menu ${className}`} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); ref.current?.querySelector("summary")?.focus(); }
  }}>
    <summary onClick={(event) => { event.preventDefault(); setOpen(!open); }}>{label}</summary>
    <div className="fd-workspace-menu-content" onClick={(event) => {
      if ((event.target as HTMLElement).closest("button:not(:disabled)")) { setOpen(false); ref.current?.querySelector("summary")?.focus(); }
    }}>{children}</div>
  </details>;
}


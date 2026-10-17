import { useLayoutEffect, useRef, useState } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";

const SLIDE_MS = 240;

/** Keep the closing view alive until its pane has slid out of the workspace. */
export function useSlidingPane(open: boolean, setOpen: (open: boolean) => void) {
  const panel = useRef<ImperativePanelHandle>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const expandedWidth = useRef(0);
  const [present, setPresent] = useState(open);
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    const element = content.current;
    const pane = element?.parentElement;
    const group = pane?.parentElement;
    const handle = panel.current;
    if (!element || !pane || !group || !handle) return;

    const finish = () => {
      delete group.dataset.sliding;
      element.style.removeProperty("width");
      setMoving(false);
      setPresent(open);
    };
    const width = pane.getBoundingClientRect().width;
    if (width > 1 && group.dataset.sliding !== "true") expandedWidth.current = width;
    const animate = initialized.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    initialized.current = true;
    if (animate) {
      setPresent(true);
      setMoving(true);
      group.dataset.sliding = "true";
      if (expandedWidth.current) element.style.width = `${expandedWidth.current}px`;
      // Establish the current width before changing flex-grow. This also lets
      // CSS reverse a running transition smoothly when the user toggles fast.
      pane.getBoundingClientRect();
    }
    if (open) handle.expand();
    else handle.collapse();
    if (!animate) { finish(); return; }

    const timer = setTimeout(finish, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // The resizer also supports collapsing with the keyboard or by dragging.
  const syncOpen = () => {
    if (panel.current && !moving) setOpen(!panel.current.isCollapsed());
  };
  return { panel, content, present, moving, syncOpen };
}

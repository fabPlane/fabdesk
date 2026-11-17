/** Coalesce input, resize and focus updates into one draw per display frame. */
export function previewFrame(draw: () => void, request = requestAnimationFrame, cancel = cancelAnimationFrame) {
  let pending: number | null = null;
  let preparation: (() => void) | null = null;
  const render = () => {
    if (pending === null) pending = request(() => {
      pending = null;
      const prepare = preparation; preparation = null;
      prepare?.();
      draw();
    });
  };
  return {
    render,
    // Resizing a WebGL drawing buffer clears its pixels. Apply it immediately
    // before drawing, never in ResizeObserver with a blank frame in between.
    renderWith(prepare: () => void) { preparation = prepare; render(); },
    dispose() { if (pending !== null) cancel(pending); pending = null; preparation = null; },
  };
}

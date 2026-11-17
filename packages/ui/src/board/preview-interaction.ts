/** OrbitControls' world-space change threshold can swallow visible pans on
 * millimeter-scale boards. Invalidate after input too; previewFrame coalesces
 * this with normal control changes, without rendering while merely hovering. */
export function previewInteraction(canvas: HTMLElement, render: () => void) {
  const move = (event: PointerEvent) => {
    if (event.buttons !== 0 || event.pointerType === "touch") render();
  };
  canvas.addEventListener("pointermove", move, { passive: true });
  canvas.addEventListener("wheel", render, { passive: true });
  return () => {
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("wheel", render);
  };
}

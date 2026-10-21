/** Counter page zoom only in Windows chrome; workspace content keeps its zoom. */
export function syncWindowChrome(zoomFactor: number, root = document.documentElement): void {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  root.style.setProperty("--fd-page-zoom", String(zoom));
  root.style.setProperty("--fd-titlebar-zoom-compensation", String(1 / zoom));
}

/** Read after Chromium commits a zoom change, not during its early resize event. */
export function watchWindowChrome(getZoomFactor: () => number): () => void {
  let frame = 0;
  const sync = () => syncWindowChrome(getZoomFactor());
  const resized = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  window.addEventListener("resize", resized);
  sync();
  return () => { window.removeEventListener("resize", resized); cancelAnimationFrame(frame); };
}

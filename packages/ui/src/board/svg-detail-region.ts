type Rect = { left: number; top: number; width: number; height: number };

/** Crop in drawing CSS coordinates, with a bounded HiDPI backing store. */
export function svgDetailRegion(drawing: Rect, viewport: Rect, width: number, height: number, dpr: number) {
  if (![drawing.left, drawing.top, drawing.width, drawing.height, viewport.left, viewport.top, viewport.width, viewport.height, width, height, dpr].every(Number.isFinite) ||
      Math.min(drawing.width, drawing.height, viewport.width, viewport.height, width, height, dpr) <= 0) return null;
  const left = Math.max(drawing.left, viewport.left), top = Math.max(drawing.top, viewport.top);
  const right = Math.min(drawing.left + drawing.width, viewport.left + viewport.width);
  const bottom = Math.min(drawing.top + drawing.height, viewport.top + viewport.height);
  if (right <= left || bottom <= top) return null;
  const scaleX = width / drawing.width, scaleY = height / drawing.height;
  const ratio = Math.min(dpr, 2, Math.sqrt(4 * 1024 * 1024 / ((right-left)*(bottom-top))));
  return { x: (left-drawing.left)*scaleX, y: (top-drawing.top)*scaleY,
    width: (right-left)*scaleX, height: (bottom-top)*scaleY,
    pixelsX: Math.max(1, Math.floor((right-left)*ratio)), pixelsY: Math.max(1, Math.floor((bottom-top)*ratio)) };
}

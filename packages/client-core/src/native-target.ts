export type NativePoint = { x: number; y: number };
/** Drag proposals use an absolute grid; keyboard nudges preserve the untouched axis. */
export function snapNativePoint(point: NativePoint, fine: boolean, origin: NativePoint = { x: 0, y: 0 }): NativePoint {
  const factor = fine ? 100 : 10;
  const snap = (value: number, offset: number) => Math.round((offset + Math.round((value - offset) * factor) / factor) * 1_000_000) / 1_000_000;
  return { x: snap(point.x, origin.x), y: snap(point.y, origin.y) };
}
export function nudgeNativePoint(point: NativePoint, direction: "left" | "right" | "up" | "down", fine: boolean): NativePoint {
  const step = fine ? .01 : .1;
  const quantize = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  if (direction === "left" || direction === "right") return { x: quantize(point.x + (direction === "right" ? step : -step)), y: point.y };
  return { x: point.x, y: quantize(point.y + (direction === "down" ? step : -step)) };
}

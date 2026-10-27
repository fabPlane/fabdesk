export type NativePoint = { x: number; y: number };
/** Drag proposals use an absolute grid; keyboard nudges preserve the untouched axis. */
export function snapNativePoint(point: NativePoint, fine: boolean): NativePoint {
  const factor = fine ? 100 : 10;
  return { x: Math.round(point.x * factor) / factor, y: Math.round(point.y * factor) / factor };
}
export function nudgeNativePoint(point: NativePoint, direction: "left" | "right" | "up" | "down", fine: boolean): NativePoint {
  const step = fine ? .01 : .1;
  const quantize = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  if (direction === "left" || direction === "right") return { x: quantize(point.x + (direction === "right" ? step : -step)), y: point.y };
  return { x: point.x, y: quantize(point.y + (direction === "down" ? step : -step)) };
}

export type Pt = [number, number];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
export const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
export const norm = (a: Pt) => Math.hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - a[0] - u * (b[0] - a[0]), p[1] - a[1] - u * (b[1] - a[1]));
}
/** Python's str(float) for a number that came from round(): `1` prints as `1.0`. */
export const pyFloat = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
/** Python's repr of a list of strings, `['a', 'b']` (user-facing text keeps the toolkit's wording). */
export const pyStrList = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
/** Python's repr of a dict with string keys; `val` renders each value. */
export const pyDict = <T>(o: Record<string, T>, val: (v: T) => string) => `{${Object.entries(o).map(([k, v]) => `'${k}': ${val(v)}`).join(", ")}}`;

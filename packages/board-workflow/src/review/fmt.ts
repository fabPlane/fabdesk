/** Number formatting that matches Python's `format` for the cases the review's claims use. */
import { pyRound } from "../accept";

/** `{x:.nf}` */
export function f(x: number, nd: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  return pyRound(x, nd).toFixed(nd);
}

/** `{x:g}` (six significant digits, trailing zeros dropped). */
export function g(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    const m = x.toExponential(5).replace(/\.?0+e/, "e");
    return m.replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(Number(x.toPrecision(6)));
}

/** str(float): ints print with a trailing .0 as Python does. */
export function s(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export const round = pyRound;

/** Python's `str[:n]` on a JS string (code units; the review's text is ASCII). */
export const cut = (t: string, n: number): string => t.slice(0, n);

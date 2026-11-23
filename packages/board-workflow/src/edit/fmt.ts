/** Number formatting that matches Python's `format(x, "g")` and `"%.4f"` (the toolkit writes poses with them). */
import { pyRound } from "../accept";

/** Python `f"{x:g}"`: six significant digits, no trailing zeros, exponent form outside 1e-4 <= |x| < 1e6. */
export function g(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  // round to six significant digits first: the exponent may change (999999.5 -> 1e+06)
  const r = Number(x.toPrecision(6));
  const e = r === 0 ? 0 : Math.floor(Math.log10(Math.abs(r)));
  if (e < -4 || e >= 6) {
    const m = r.toExponential(5).replace(/\.?0+e/, "e");
    const [mant, ex] = m.split("e") as [string, string];
    const sign = ex.startsWith("-") ? "-" : "+";
    const digits = ex.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  let s = r.toFixed(Math.max(0, 5 - e));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Python `"%.4f" % x` (ties to even on the exact value). */
export function f4(x: number): string {
  return pyRound(x, 4).toFixed(4);
}

/** Python `x % m` for positive m. */
export const mod = (x: number, m: number): number => ((x % m) + m) % m;

export const round = (x: number, nd: number): number => pyRound(x, nd);

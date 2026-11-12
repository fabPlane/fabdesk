/**
 * Differential impedance from the board's own stack-up, closed-form (IPC-2141A / Wadell), and interface profiles.
 * Estimates, not a field solver (about +/-10 %): they answer "is this pair in the right neighbourhood for its target on the
 * layers it actually uses", from the design (class width/gap) and from the copper as routed (measured gap).
 */
import { pyRound } from "../accept";
import type { Segment } from "../board";
import type { InterfaceProfile } from "./data";

export type StackLayer = { name: string; kind: "copper" | "dielectric"; th: number; er: number };

export type Geo =
  | { kind: "microstrip"; h: number; er: number; t: number }
  | { kind: "embedded"; h: number; cover: number; er: number; t: number }
  | { kind: "stripline"; h1: number; h2: number; er: number; t: number }
  | { kind: "none"; t: number };

export function stackup(text: string): StackLayer[] {
  const i = text.indexOf("(stackup");
  if (i < 0) return [];
  let depth = 0, j = i;
  while (j < text.length) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  const out: StackLayer[] = [];
  const body = text.slice(i, j);
  const re = /\(layer "([^"]+)"\s*\(type "([^"]+)"\)([\s\S]*?)(?=\n\s*\(layer "|(?![\s\S]))/g;
  for (const m of body.matchAll(re)) {
    const [, name, kind, rest] = m as unknown as [string, string, string, string];
    const th = /\(thickness ([\d.]+)/.exec(rest);
    const er = /\(epsilon_r ([\d.]+)/.exec(rest);
    if (kind === "copper" || kind === "core" || kind === "prepreg" || name.includes("dielectric"))
      out.push({ name, kind: kind === "copper" ? "copper" : "dielectric", th: th ? Number(th[1]) : 0, er: er ? Number(er[1]) : 4.2 });
  }
  return out;
}

/** Nearest plane above and below `layer`, with the dielectric between (thickness, mean er). */
export function reference(stack: StackLayer[], layer: string, planes: ReadonlySet<string>): Geo | null {
  const names = stack.map((s) => s.name);
  if (!names.includes(layer)) return null;
  const k = names.indexOf(layer);
  const t = stack[k]!.th || 0.035;
  const walk = (step: number): [number, number, boolean] => {
    let h = 0, i = k + step;
    const ers: Array<[number, number]> = [];
    const mean = () => {
      if (!ers.length) return 4.2;
      return ers.reduce((a, [x, y]) => a + x * y, 0) / Math.max(ers.reduce((a, [x]) => a + x, 0), 1e-9);
    };
    while (i >= 0 && i < stack.length) {
      const s = stack[i]!;
      if (s.kind === "dielectric") {
        h += s.th;
        ers.push([s.th, s.er]);
      } else if (planes.has(s.name)) return [h, mean(), true];
      else h += s.th; // a signal copper layer in between: keep walking to a plane
      i += step;
    }
    return [h, mean(), false];
  };
  const up = walk(-1), dn = walk(1);
  const copperIdx = stack.flatMap((s, i) => (s.kind === "copper" ? [i] : []));
  const outer = k === Math.min(...copperIdx) || k === Math.max(...copperIdx);
  if (up[2] && dn[2]) return { kind: "stripline", h1: Math.min(up[0], dn[0]), h2: Math.max(up[0], dn[0]), er: (up[1] + dn[1]) / 2, t };
  if (outer && (up[2] || dn[2])) {
    const [h, er] = dn[2] ? [dn[0], dn[1]] : [up[0], up[1]];
    return { kind: "microstrip", h, er, t };
  }
  if (up[2] || dn[2]) {
    const [near, far] = up[2] ? [up, dn] : [dn, up];
    return { kind: "embedded", h: near[0], cover: far[0], er: near[1], t };
  }
  return { kind: "none", t };
}

export function z0(w: number, geo: Geo): number {
  const t = geo.t;
  if (geo.kind === "microstrip") return (87.0 / Math.sqrt(geo.er + 1.41)) * Math.log((5.98 * geo.h) / (0.8 * w + t));
  if (geo.kind === "embedded") {
    const erEff = geo.er * (1 - Math.exp((-1.55 * (geo.h + geo.cover)) / geo.h));
    return (60.0 / Math.sqrt(erEff)) * Math.log((5.98 * geo.h) / (0.8 * w + t));
  }
  if (geo.kind === "stripline") {
    const { h1, h2 } = geo;
    return (80.0 / Math.sqrt(geo.er)) * Math.log((1.9 * (2 * h1 + t)) / (0.8 * w + t)) * (1 - h1 / (4 * (h1 + t + h2)));
  }
  return NaN;
}

export function zdiff(w: number, s: number, geo: Geo): number {
  const z = z0(w, geo);
  if (geo.kind === "microstrip" || geo.kind === "embedded") return 2 * z * (1 - 0.48 * Math.exp((-0.96 * s) / geo.h));
  if (geo.kind === "stripline") {
    const b = geo.h1 + geo.h2 + geo.t;
    return 2 * z * (1 - 0.347 * Math.exp((-2.9 * s) / b));
  }
  return NaN;
}

/** (ohm, tolerance, profile key) from the class's own target text, its name (USB90, PAIR_HDMI_100R), or the profiles file. */
export function targetOf(name: string, cls: { target?: unknown }, profiles: Record<string, InterfaceProfile>): [number | null, number, string | null] {
  const txt = String(cls.target ?? "");
  const m = /(\d{2,3})\s*ohm/i.exec(txt) ?? /(\d{2,3})R(?:_|$)/.exec(name) ?? /(?:USB|LVDS|HDMI|PCIE|DP)(\d{2,3})/i.exec(name);
  const tol = /\+\/-\s*(\d+)\s*%/.exec(txt);
  for (const [key, prof] of Object.entries(profiles))
    if (new RegExp(prof.match, "i").test(name)) return [m ? Number(m[1]) : prof.zdiff, tol ? Number(tol[1]) : prof.tol_pct, key];
  return [m ? Number(m[1]) : null, tol ? Number(tol[1]) : 10.0, null];
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - a[0] - u * (b[0] - a[0]), p[1] - a[1] - u * (b[1] - a[1]));
}

/** Median edge gap where P runs beside N on the same layer (within 3 x pitch), per layer. */
export function measuredGap(pSegs: Segment[], nSegs: Segment[], w: number, sClass: number): Record<string, { gap_mm: number; coupled_mm: number; w_mm: number }> {
  const out: Record<string, { gap_mm: number; coupled_mm: number; w_mm: number }> = {};
  const win = 3 * (w + sClass);
  for (const lay of new Set(pSegs.map((s) => s.layer))) {
    const ns = nSegs.filter((s) => s.layer === lay);
    if (!ns.length) continue;
    const gaps: number[] = [];
    for (const sg of pSegs.filter((x) => x.layer === lay)) {
      const L = Math.hypot(sg.a[0] - sg.b[0], sg.a[1] - sg.b[1]);
      const n = Math.max(1, Math.trunc(L / 0.25));
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        const pt: [number, number] = [sg.a[0] + u * (sg.b[0] - sg.a[0]), sg.a[1] + u * (sg.b[1] - sg.a[1])];
        const d = Math.min(...ns.map((x) => segDist(pt, x.a, x.b)));
        if (d < win) gaps.push(d - (sg.w + ns[0]!.w) / 2);
      }
    }
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      const ws = pSegs.filter((x) => x.layer === lay).map((x) => x.w).sort((a, b) => a - b);
      out[lay] = { gap_mm: pyRound(gaps[Math.floor(gaps.length / 2)]!, 3), coupled_mm: pyRound(0.25 * gaps.length, 1), w_mm: ws[Math.floor(ws.length / 2)]! };
    }
  }
  return out;
}

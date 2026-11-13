/**
 * Pair measurement on a routed board (toolkit tools/pairfix.py `measure [--why]`): per pair the coupled share as A8
 * counts it, the spacing histogram, widths, and with `why` each uncoupled millimetre of P by cause:
 * on_pad (track over its own pad), between (other-net copper between P and N: a shield pin, a via), escape (within
 * 1.5 mm of its own pad), apart (no N on this layer within 1.6 mm: other layer or path), loose (side by side,
 * nothing between, just too far apart: fixable in place).
 */
import { padOnLayer, type Board, type Pad, type Segment, type Via } from "../board";
import { pyRound } from "../accept";
import type { Requirements } from "../requirements";
import { add, dot, dist, mul, norm, pyDict, pyFloat, segDist, sub, type Pt } from "./geometry";

export interface PairSpec {
  p: string;
  n: string;
  class: string;
  w: number;
  gap: number;
  neck_w: number;
  reach: number;
}

/** Pairs of every class that lists pairs, optionally only those whose P or N net matches `rx`. */
export function classesAndPairs(req: Requirements, rx?: string | null): PairSpec[] {
  const re = rx ? new RegExp(rx) : null;
  const out: PairSpec[] = [];
  for (const [name, c] of Object.entries(req.acceptance.net_classes.classes)) {
    if (!c.pairs?.length) continue;
    const w = c.diff_pair_width!;
    const gap = c.diff_pair_gap!;
    for (const [p, n] of c.pairs) {
      if (re && !re.test(p) && !re.test(n)) continue;
      out.push({ p, n, class: name, w, gap, neck_w: Math.ceil((c.neck_min_width_ratio ?? 1.0) * w * 1000 - 1e-6) / 1000, reach: (w + gap) * 1.25 });
    }
  }
  return out;
}

type GridObj = { kind: "seg" | "via" | "pt"; a: Pt; b: Pt | null; hw: number; net: string };

/** Other copper per layer in 1 mm cells, for the "nothing between the two tracks" test. */
export class Grid {
  private cells = new Map<string, GridObj[]>();
  constructor(segs: Segment[], pads: Pad[], vias: Via[], stack: readonly string[]) {
    for (const s of segs) {
      const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
      const [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
      this.put(s.layer, x0, y0, x1, y1, { kind: "seg", a: s.a, b: s.b, hw: s.w / 2, net: s.net });
    }
    for (const v of vias) {
      const i = [stack.indexOf(v.layers[0]), stack.indexOf(v.layers[1])].sort((x, y) => x - y);
      for (const L of stack.slice(i[0]!, i[1]! + 1)) this.put(L, v.x, v.y, v.x, v.y, { kind: "via", a: [v.x, v.y], b: null, hw: v.size / 2, net: v.net });
    }
    for (const p of pads)
      for (const L of padLayers(p, stack)) this.put(L, p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, { kind: "pt", a: [p.x, p.y], b: null, hw: p.r, net: p.net });
  }
  private put(L: string, x0: number, y0: number, x1: number, y1: number, obj: GridObj) {
    for (let i = Math.floor(x0); i <= Math.floor(x1); i++)
      for (let j = Math.floor(y0); j <= Math.floor(y1); j++) {
        const k = `${L}|${i}|${j}`;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(obj);
      }
  }
  /** No other-net copper within r of point q on layer L. */
  clear(L: string, q: Pt, r: number, nets: ReadonlySet<string>): boolean {
    for (let i = Math.floor(q[0] - r - 1); i <= Math.floor(q[0] + r + 1); i++)
      for (let j = Math.floor(q[1] - r - 1); j <= Math.floor(q[1] + r + 1); j++)
        for (const o of this.cells.get(`${L}|${i}|${j}`) ?? []) {
          if (nets.has(o.net)) continue;
          const d = o.kind === "seg" ? segDist(q, o.a, o.b!) : dist(q, o.a);
          if (d - o.hw < r) return false;
        }
    return true;
  }
}

/** Copper layers of a pad: every layer for `*.Cu`, else the named copper layers (as the toolkit's board model). */
export function padLayers(p: Pad, stack: readonly string[]): string[] {
  return p.layers.some((l) => l.startsWith("*")) ? [...stack] : p.layers.filter((l) => l.endsWith(".Cu"));
}

export interface PairMeasure {
  class: string;
  target_mm: number;
  p_mm: number;
  n_mm: number;
  coupled_share: number;
  spacing: Array<[number, number]>;
  widths: Record<string, number>;
  uncoupled_mm?: Record<string, number>;
}

const len = (s: Segment) => dist(s.a, s.b);

export function measurePairs(board: Board, pairs: readonly PairSpec[], stack: readonly string[], why = false): Record<string, PairMeasure> {
  const grid = why ? new Grid(board.segments, board.pads, board.vias, stack) : null;
  const res: Record<string, PairMeasure> = {};
  for (const pr of pairs) {
    const ps = board.segments.filter((s) => s.net === pr.p);
    const ns = board.segments.filter((s) => s.net === pr.n);
    const own = board.pads.filter((q) => q.net === pr.p);
    const hist = new Map<number, number>();
    const cause = new Map<string, number>();
    let tot = 0;
    let got = 0;
    for (const s of ps) {
      const L = len(s);
      const k = Math.max(1, Math.trunc(L / 0.1));
      const mates = ns.filter((t) => t.layer === s.layer);
      for (let i = 0; i < k; i++) {
        const u = (i + 0.5) / k;
        const q: Pt = [s.a[0] + u * (s.b[0] - s.a[0]), s.a[1] + u * (s.b[1] - s.a[1])];
        let d = 9.0;
        let tm: Segment | null = null;
        for (const t of mates) {
          const dd = segDist(q, t.a, t.b);
          if (tm === null || dd < d) {
            d = dd;
            tm = t;
          }
        }
        const hk = Math.min(pyRound(d, 2), 2.0);
        hist.set(hk, (hist.get(hk) ?? 0) + L / k);
        tot += L / k;
        if (d <= pr.reach) {
          got += L / k;
          continue;
        }
        if (!why) continue;
        let pd = 9;
        for (const o of own) if (padOnLayer(o, s.layer) || padLayers(o, stack).includes(s.layer)) pd = Math.min(pd, dist(q, [o.x, o.y]) - o.r);
        let c: string;
        if (pd <= 0) c = "on_pad";
        else if (d > 1.6) c = "apart";
        else {
          const tmm = tm!;
          const ab = sub(tmm.b, tmm.a);
          const l2 = dot(ab, ab) || 1e-12;
          const w_ = Math.max(0, Math.min(1, dot(sub(q, tmm.a), ab) / l2));
          const m = add(tmm.a, mul(ab, w_));
          const free = (d - s.w / 2 - tmm.w / 2) / 2 - 0.01;
          c = free <= 0 || !grid!.clear(s.layer, mul(add(q, m), 0.5), free, new Set([pr.p, pr.n])) ? "between" : pd <= 1.5 ? "escape" : "loose";
        }
        cause.set(c, (cause.get(c) ?? 0) + L / k);
      }
    }
    const ws = new Map<number, number>();
    for (const s of [...ps, ...ns]) ws.set(pyRound(s.w, 3), (ws.get(pyRound(s.w, 3)) ?? 0) + 1);
    const spacing = [...hist].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([d, l]): [number, number] => [d, pyRound(l, 1)]);
    const row: PairMeasure = {
      class: pr.class,
      target_mm: pyRound(pr.w + pr.gap, 3),
      p_mm: pyRound(tot, 2),
      n_mm: pyRound(ns.reduce((t, s) => t + len(s), 0), 2),
      coupled_share: tot ? pyRound(got / tot, 2) : 0.0,
      spacing,
      widths: Object.fromEntries([...ws].map(([k, v]) => [pyFloat(k), v])),
    };
    if (why) row.uncoupled_mm = Object.fromEntries([...cause].sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, pyRound(v, 1)]));
    res[`${pr.p} / ${pr.n}`] = row;
  }
  return res;
}

/** The toolkit's one-line-per-pair text of `measure`. */
/**
 * The step to try next for pairs that are not coupled, from how they are routed: pairs routed apart (coupled share
 * under 0.5: single-ended routing, the eval's HDMI pairs at 0.02-0.03) need ripping and routing again together as
 * pairs (`bundle:REGEX`, or `pairs-all` for every pair); partly coupled ones (0.5-0.9) a local re-route of their
 * uncoupled stretches (`reroute:REGEX`). An agent given only the table tried reroute/tighten, which cannot couple a
 * pair routed apart, and then routed the pairs by hand. On the eval's HDMI board (0.5 mm pitch connector) bundle
 * fails in both the toolkit and here: KRT defers the short fan-out legs to single-ended; the line says so.
 */
export function pairsNext(m: Record<string, PairMeasure>): string[] {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pName = (k: string) => k.split(" / ")[0]!;
  const rx = (ks: string[]) => `^(${ks.map((k) => esc(pName(k))).join("|")})$`;
  const apart = Object.entries(m).filter(([, v]) => v.coupled_share < 0.5).map(([k]) => k);
  const partly = Object.entries(m).filter(([, v]) => v.coupled_share >= 0.5 && v.coupled_share < 0.9).map(([k]) => k);
  const out: string[] = [];
  if (apart.length)
    out.push(
      `Next: ${apart.length} pair(s) routed apart (coupled share < 0.5): rip and route them again together as pairs: try {"actions": ["bundle:${rx(apart)}"${apart.length > 2 ? ', "pairs-all"' : ""}]} (reroute / tighten only fix stretches of a pair that is already coupled). If that does not pass the gate, look at the try folder's krt/s1-pairs-*.log: KiCadRoutingTools routes a leg single-ended when it is "electrically short" (under max(5 x the centerline setback, 3 mm) of coupled run), which a tight connector fan-out makes common; those legs then need routing by hand to the pair rules (width, gap, length match), checked with this pairs report and the gate.`,
    );
  if (partly.length) out.push(`Next: ${partly.length} pair(s) partly coupled: try {"actions": ["reroute:${rx(partly)}", "reroute:${rx(partly)}!"]} (cut and re-route their uncoupled stretches; ! also re-routes uncoupled pad stubs)`);
  return out;
}

export function measureLines(m: Record<string, PairMeasure>, why: boolean): string[] {
  return Object.entries(m).map(([k, v]) => {
    const sp = `[${v.spacing.slice(0, 3).map(([d, l]) => `[${pyFloat(d)}, ${pyFloat(l)}]`).join(", ")}]`;
    return (
      `${k.padEnd(44)} share ${v.coupled_share.toFixed(2)}  target ${pyFloat(v.target_mm)}  P ${v.p_mm.toFixed(1).padStart(6)}  N ${v.n_mm.toFixed(1).padStart(6)}  ` +
      `spacing ${sp}  widths ${pyDict(v.widths, String)}` +
      (why ? `  uncoupled ${pyDict(v.uncoupled_mm ?? {}, pyFloat)}` : "")
    );
  });
}

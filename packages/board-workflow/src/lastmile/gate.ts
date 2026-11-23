/**
 * The whole-board gate of the last-mile bench (toolkit tools/lastmile.py: figures, key, gate).
 * A step is kept only when the whole board improves: fewer (open, other DRC errors, A7 nets, A8 nets, pairs to
 * re-route, A7 mm) in that order, no new DRC error class, A7/A8 nets not worse than the slack, and no failing pair
 * getting worse.
 */
import { pyRound, type AcceptanceResult } from "../accept";
import type { Requirements } from "../requirements";
import { pyDict } from "./geometry";


export interface OpenItem {
  net: string;
  a: [number, number];
  b: [number, number];
}

/** [coupled_share, length_difference_mm, skew_limit_mm, failing] per "P / N". */
export type PairFigure = [number, number, number, boolean];

export interface Figures {
  open: number;
  drc: Record<string, number>;
  a7: number;
  a7_mm: number;
  a8: number;
  pairs_todo: number;
  pairs: Record<string, PairFigure>;
}

export interface BoardNets {
  pairs: Array<[string, string]>;
  power: Set<string>;
  /**
   * DRC classes the board carries whatever is routed (`acceptance.lastmile.inherited_drc`); left out of the figures,
   * so they never count against a step. Empty unless the board's requirements name some (the toolkit hard-coded the
   * carrier board's `hole_clearance` for every board).
   */
  inheritedDrc: Set<string>;
}

/** DRC classes a board's requirements declare inherited (`acceptance.lastmile.inherited_drc`); refuses a malformed entry by name. */
export function inheritedDrc(req: Requirements): Set<string> {
  const v = req.acceptance.lastmile?.inherited_drc;
  if (v === undefined) return new Set();
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new Error("acceptance.lastmile.inherited_drc must be a list of DRC class names (e.g. [\"hole_clearance\"])");
  return new Set(v);
}

/** Pair list and power nets from the board's own requirements (every class that lists pairs; classes named PWR*), and its inherited DRC classes. */
export function boardNets(req: Requirements): BoardNets {
  const classes = req.acceptance.net_classes.classes;
  return {
    pairs: Object.values(classes).flatMap((c) => (c.pairs ?? []).map((p): [string, string] => [p[0], p[1]])),
    power: new Set(Object.entries(classes).filter(([k]) => k.startsWith("PWR")).flatMap(([, c]) => c.nets ?? [])),
    inheritedDrc: inheritedDrc(req),
  };
}

const sum = (xs: Iterable<number>) => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};

/**
 * Compared figures of a scored board. An open pair is not a passing pair, and an open power net is not a passing
 * one (eco95: routing a ripped pair after a connector move looked like "A8 worse" 0 -> 2 and vetoed open 47 -> 2).
 */
export function figuresOf(acc: AcceptanceResult, opens: readonly OpenItem[], nets: BoardNets): Figures {
  const r = acc.results;
  const openNets = new Set(opens.map((o) => o.net));
  const pairNets = new Set(nets.pairs.flat());
  const a8d = r.A8_pairs;
  const a8 = new Set(Object.keys((a8d["detail"] ?? {}) as object));
  const todo = new Map<string, [string, string]>();
  for (const p of (a8d["pairs_to_reroute"] ?? []) as Array<[string, string]>) todo.set(p.join("\u0000"), [p[0], p[1]]);
  for (const n of openNets) if (pairNets.has(n)) a8.add(n);
  for (const p of nets.pairs) if (openNets.has(p[0]) || openNets.has(p[1])) todo.set(p.join("\u0000"), p);
  const under = (r.A7_widths["undersize_length_mm"] ?? {}) as Record<string, number>;
  const a7 = new Set(Object.keys(under));
  for (const n of openNets) if (nets.power.has(n)) a7.add(n);
  const cp = (a8d["coupling"] ?? {}) as Record<string, { coupled_share: number; length_difference_mm: number; skew_limit_mm: number; uncoupled?: boolean }>;
  const pairs: Record<string, PairFigure> = {};
  for (const [k, v] of Object.entries(cp)) pairs[k] = [v.coupled_share, v.length_difference_mm, v.skew_limit_mm, Boolean(v.uncoupled) || a8.has(k.split(" / ")[0]!) || a8.has(k.split(" / ").at(-1)!)];
  const errors = (r.A2_drc["errors"] ?? {}) as Record<string, number>;
  return {
    open: Number(r.A1_connectivity["unconnected"] ?? 0),
    drc: Object.fromEntries(Object.entries(errors).filter(([k]) => !nets.inheritedDrc.has(k))),
    a7: a7.size,
    a7_mm: pyRound(sum(Object.values(under)), 2),
    a8: a8.size,
    pairs_todo: todo.size,
    pairs,
  };
}

export type FigureKey = [number, number, number, number, number, number];
export const keyOf = (f: Figures): FigureKey => [f.open, sum(Object.values(f.drc)), f.a7, f.a8, f.pairs_todo, f.a7_mm];

/** Python tuple comparison: -1, 0, 1. */
export function compareKeys(a: FigureKey, b: FigureKey): number {
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export interface GateSlack {
  a7_slack?: number;
  a8_slack?: number;
}

/** Reasons a step is rejected; empty = it passes. */
export function gate(next: Figures, cur: Figures, acc: GateSlack = {}): string[] {
  const why: string[] = [];
  const fresh = Object.keys(next.drc).filter((k) => !(k in cur.drc)).sort();
  if (fresh.length) why.push(`new DRC class [${fresh.map((x) => `'${x}'`).join(", ")}]`);
  if (next.a7 > cur.a7 + (acc.a7_slack ?? 0)) why.push("A7 worse");
  // A8 nets gate; pairs_todo also counts length-difference overruns (reported, not gating), so it may only veto a
  // step that does not improve A8 itself (2026-11-10: a bundle re-route took A8 2 -> 0 with pairs_todo 2 -> 3)
  const s8 = acc.a8_slack ?? 0;
  if (next.a8 > cur.a8 + s8 || (next.a8 >= cur.a8 && next.pairs_todo > cur.pairs_todo + s8)) why.push("A8 worse");
  // No pair that ends failing may get worse (2026-11-11, pairs98: a re-route took A8 8 -> 6 nets by fixing one pair
  // while an already failing pair fell from 0.39 to 0.16 coupled and to 9.4 mm length difference; counts hid it).
  const worse: string[] = [];
  for (const [k, [s1, d1, lim, fail1]] of Object.entries(next.pairs)) {
    const was = cur.pairs[k];
    if (!was) continue;
    const [s0, d0] = was;
    const name = k.split(" / ")[0];
    if (fail1 && s1 < s0 - 0.05) worse.push(`${name} coupled ${s0}->${s1}`);
    if (d1 > lim && d1 > d0 + (d0 > lim ? 0.2 : 0)) worse.push(`${name} length diff ${d0}->${d1}`);
  }
  if (worse.length) why.push("pair worse: " + worse.slice(0, 3).join(", "));
  if (compareKeys(keyOf(next), keyOf(cur)) >= 0) why.push("no gain");
  return why;
}

/** One line of figures (bench status and try output). */
export function figureLine(f: Figures): string {
  const drc = sum(Object.values(f.drc));
  return `open ${f.open}  drc ${drc}${drc ? " " + pyDict(f.drc, String) : ""}  a7 ${f.a7}  a8 ${f.a8}  pairs-todo ${f.pairs_todo}`;
}

/**
 * The layout spec: which board, which parts are fixed, how the placer groups the rest, which router plans to use.
 * `deriveLayout` proposes groups and escape keep-outs from the board (port of the groups/keep-out half of the toolkit's
 * `flow/onboard.py`); the agent owns the result and may edit `groups.json` and the spec.
 */
import type { Board, Pad } from "../board";
import { pyRound } from "../accept";
import { pyReEscape } from "./plan";

export interface Keepout {
  name: string;
  rect: [number, number, number, number];
  sides: string[];
  note: string;
}

export interface Group {
  name: string;
  role: string;
  refs: string[];
  anchor?: string;
  why: string;
}

export interface LayoutSpec {
  name: string;
  stem: string;
  /** Folder holding the project files the flow starts from (copied into the workspace). */
  base: string;
  /** Folder with acceptance.json, mechanical.json, circuit.json, heights.json. */
  requirements: string;
  /** Regex of references the placer may not move. */
  fixed: string;
  /** groups.json */
  groups: string;
  templates: string[];
  /** Plans by role: a file path, or `builtin:<role>`. */
  plans: { rank: string; tm: string; finish: string; finish_fine: string };
  keepouts?: Keepout[];
  clustered_seeds?: string;
  cull_keep_fraction?: number;
  budgets_min?: { place?: number; rank_seed?: number; tm?: number; finish?: number };
  lastmile_max_open?: number;
}

export const BUILTIN_PLAN_REFS = { rank: "builtin:rank", tm: "builtin:tm", finish: "builtin:finish", finish_fine: "builtin:finish_fine" } as const;

const SIGNALISH_SKIP = /(^|[_/])(GND|AGND|PGND|DGND|VSS)$|^unconnected-/i;

/**
 * Placer keep-outs in front of every fine-pitch pad row of a fixed part (connectors), so the placer leaves fan-out
 * room: a row is >= 8 pads on one line at <= 0.65 mm pitch; the band is on the side away from the part's pad centroid.
 */
export function escapeKeepouts(pads: Pad[], fixed: string[], sides = ["F", "B"]): Keepout[] {
  const out: Keepout[] = [];
  for (const ref of fixed) {
    const ps = pads.filter((p) => p.ref === ref);
    if (ps.length < 10) continue;
    const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    for (const [ax, ox] of [["y", "x"], ["x", "y"]] as const) {
      const rows = new Map<number, number[]>();
      for (const p of ps) {
        const k = pyRound(p[ax], 1);
        (rows.get(k) ?? rows.set(k, []).get(k)!).push(p[ox]);
      }
      for (const [key, along] of rows) {
        if (along.length < 8) continue;
        along.sort((a, b) => a - b);
        const gaps = along.slice(1).map((v, i) => v - along[i]!).sort((a, b) => a - b);
        const pitch = gaps[Math.floor(gaps.length / 2)]!;
        if (pitch > 0.65) continue;
        const sign = key > (ax === "y" ? cy : cx) ? 1 : -1;
        const depth = Math.min(3.0, Math.max(1.2, 0.1 * along.length + 0.8));
        const near = key + sign * 0.4;
        const far = key + sign * (0.4 + depth);
        const lo = along[0]! - 0.3;
        const hi = along[along.length - 1]! + 0.3;
        const rect = ax === "y" ? [lo, Math.min(near, far), hi, Math.max(near, far)] : [Math.min(near, far), lo, Math.max(near, far), hi];
        out.push({
          name: `escape_${ref}_${out.length}`,
          rect: rect.map((v) => pyRound(v, 3)) as Keepout["rect"],
          sides: [...sides],
          note: `${ref}: ${along.length} pads at ${pitch.toFixed(2)} mm pitch, fan-out room`,
        });
      }
    }
  }
  return out;
}

/** Anchor ICs plus the parts sharing their signal nets (rails and ground are not grouping evidence). */
export function deriveGroups(board: Board, fixed: Set<string>): Group[] {
  const pads = board.pads;
  const fanout = new Map<string, number>();
  for (const p of pads) if (p.net) fanout.set(p.net, (fanout.get(p.net) ?? 0) + 1);
  const big = new Set([...fanout].filter(([, k]) => k > 12).map(([n]) => n));
  const sig = new Map<string, Set<string>>();
  for (const ref of board.footprints.keys()) sig.set(ref, new Set());
  for (const p of pads) if (p.net && !big.has(p.net) && !SIGNALISH_SKIP.test(p.net)) (sig.get(p.ref) ?? sig.set(p.ref, new Set()).get(p.ref)!).add(p.net);
  const movable = [...board.footprints.keys()].filter((r) => !fixed.has(r));
  const netsOf = new Map<string, Set<string>>();
  for (const p of pads) (netsOf.get(p.ref) ?? netsOf.set(p.ref, new Set()).get(p.ref)!).add(p.net);
  let anchors = movable.filter((r) => /^(U|IC|Q)\d/.test(r) && (netsOf.get(r)?.size ?? 0) >= 6).sort();
  if (!anchors.length)
    anchors = [...movable]
      .map((r, i) => ({ r, i, k: sig.get(r)?.size ?? 0 }))
      .sort((a, b) => b.k - a.k || a.i - b.i)
      .slice(0, Math.max(1, Math.floor(movable.length / 15)))
      .map((x) => x.r);
  const member = new Map<string, string>(anchors.map((r) => [r, r]));
  for (let pass = 0; pass < 3; pass++)
    for (const r of movable) {
      if (member.has(r)) continue;
      const score = new Map<string, number>();
      for (const [q, m] of member) {
        let add = 0;
        for (const n of sig.get(r) ?? []) if (sig.get(q)?.has(n)) add += 1 / Math.max(1, (fanout.get(n) ?? 0) - 1);
        score.set(m, (score.get(m) ?? 0) + add);
      }
      let best: string | null = null;
      let bestV = 0;
      for (const [m, v] of score) if (v > bestV) ((best = m), (bestV = v));
      if (best !== null) member.set(r, best);
    }
  const groups = new Map<string, string[]>();
  for (const r of movable) (groups.get(member.get(r) ?? "_loose") ?? groups.set(member.get(r) ?? "_loose", []).get(member.get(r) ?? "_loose")!).push(r);
  for (const [g, rs] of [...groups]) {
    if (g !== "_loose" && rs.length < 3) {
      groups.delete(g);
      groups.set("_loose", [...(groups.get("_loose") ?? []), ...rs]);
    }
  }
  const gl: Group[] = [...groups]
    .filter(([g]) => g !== "_loose")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([g, rs]) => ({ name: g.toLowerCase(), role: "core", refs: [...rs].sort(), anchor: g, why: "onboard: shares signal nets with " + g }));
  if (groups.get("_loose")?.length) gl.push({ name: "misc", role: "core", refs: [...groups.get("_loose")!].sort(), why: "onboard: no signal-net anchor" });
  return gl.filter((g) => g.refs.length);
}

/** The spec's `fixed` regex for a list of references. */
export function fixedRegex(fixed: string[]): string {
  return "^(" + fixed.map(pyReEscape).join("|") + ")$";
}

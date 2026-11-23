/**
 * Pairs to class width and spacing, in place, on a routed board: no rip, no router (toolkit tools/pairfix.py `run`,
 * ops `width` and `tighten`). The path is kept and the copper moves:
 *
 *   width    pair segments to the class diff_pair_width (narrowing is always safe; a widening that DRC refuses falls back
 *            to the class neck width, then to the original)
 *   tighten  each P segment and its parallel N partner (same layer, overlapping, other copper not between them) move
 *            toward each other to the class centre spacing (width + gap). Bends are recomputed as the intersection of the
 *            moved lines; where a moved segment meets a pad, a via or a T it keeps its end there through a 45 degree jog.
 *
 * Native DRC (refilled zones, the board's own rules) is the judge: every round the edited board is checked and each group
 * (a coupled run, or one width change) named in a DRC item the source board does not have is reverted (or falls back) and
 * the board is built again, until no new item is left. Only pair-net segments are edited.
 *
 * Before the rounds, as their own DRC-guarded passes (pairops.ts): vias, mirror / mirror-force, retune; after them: skew.
 * The order and the default `--ops vias,mirror,retune,width,tighten,skew` are the toolkit's `cmd_run`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkAcceptance, profile, pyRound } from "../accept";
import { parseBoard, viaSpan, type Board, type Pad } from "../board";
import type { Requirements } from "../requirements";
import type { Step } from "./actions";
import type { StepInput, StepOutcome } from "./bench";
import { copyBoardFolder } from "./bench";
import { add, cross2, dot, mul, norm, segDist, sub, type Pt } from "./geometry";
import { Grid, classesAndPairs, measurePairs, padLayers, type PairSpec } from "./pairs";
import { NUM, drcItems, drcRun, fmt, mirrorPass, readSegments, retunePass, sig, skewPass, unit, uuid5url, viasPass, type Item, type PassCtx, type PSeg } from "./pairops";
import type { DrcFn } from "./scoring";

export { readSegments, readVias, uuid5url, type PSeg } from "./pairops";

type Iv = { lo: number; hi: number; vec: Pt; ov: number; key: string; role: "P" | "N" };
type Obst = Map<string, Array<[Pt, number]>>;

/** P/N segment pairs to move: same layer, near parallel (<= 11 deg), overlapping, nearest spacing over target, nothing between them. */
export function pairings(pr: PairSpec, segs: PSeg[], grid: Grid): Map<string, Iv[]> {
  const D = pr.w + pr.gap + 0.002;
  const out = new Map<string, Iv[]>();
  const P = segs.filter((s) => s.net === pr.p);
  const N = segs.filter((s) => s.net === pr.n);
  for (const s of P)
    for (const t of N) {
      if (s.layer !== t.layer) continue;
      const us = unit(sub(s.b, s.a));
      const ut = unit(sub(t.b, t.a));
      const Ls = norm(sub(s.b, s.a));
      const Lt = norm(sub(t.b, t.a));
      if (Ls < 0.05 || Lt < 0.05 || Math.abs(cross2(us, ut)) > 0.2) continue;
      const ivs: Array<[number, number]> = [];
      for (const [x, y, ux, Lx] of [[s, t, us, Ls], [t, s, ut, Lt]] as const) {
        const ya = dot(sub(y.a, x.a), ux);
        const yb = dot(sub(y.b, x.a), ux);
        ivs.push([Math.max(0, Math.min(ya, yb)), Math.min(Lx, Math.max(ya, yb))]);
      }
      const [slo, shi] = ivs[0]!;
      const [tlo, thi] = ivs[1]!;
      const ov = Math.min(shi - slo, thi - tlo);
      if (ov < Math.min(0.15, 0.5 * Math.min(Ls, Lt))) continue;
      const ptsS: Pt[] = [add(s.a, mul(us, slo)), add(s.a, mul(us, shi))];
      const ptsT: Pt[] = [add(t.a, mul(ut, tlo)), add(t.a, mul(ut, thi))];
      const ds = [...ptsS.map((q) => segDist(q, t.a, t.b)), ...ptsT.map((q) => segDist(q, s.a, s.b))];
      const d = Math.min(...ds);
      const dmax = Math.max(...ds);
      if (d < D + 0.005 || dmax > 1.6) continue;
      const free = (d - s.w / 2 - t.w / 2) / 2 - 0.01;
      if (free <= 0) continue;
      const k = Math.max(1, Math.trunc(ov / 0.1));
      const nets = new Set([pr.p, pr.n]);
      const same = dot(us, ut) > 0;
      const dsS = (shi - slo) / k;
      const dtT = (thi - tlo) / k;
      const tpos = (i: number) => (same ? tlo + i * dtT : thi - i * dtT);
      const ok: boolean[] = [];
      for (let i = 0; i < k; i++)
        ok.push(grid.clear(s.layer, mul(add(add(s.a, mul(us, slo + (i + 0.5) * dsS)), add(t.a, mul(ut, tpos(i + 0.5)))), 0.5), free, nets));
      const delta = (d - D) / 2;
      const runs: Array<[[number, number], [number, number]]> = [];
      let i = 0;
      while (i < k) {
        if (!ok[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < k && ok[j]) j++;
        let loS = slo + i * dsS;
        let hiS = slo + j * dsS;
        const tt = [tpos(i), tpos(j)].sort((x, y) => x - y);
        let loT = tt[0]!;
        let hiT = tt[1]!;
        if (i > 0) {
          loS += 2 * delta + 0.05;
          if (same) loT += 2 * delta + 0.05;
          else hiT -= 2 * delta + 0.05;
        }
        if (j < k) {
          hiS -= 2 * delta + 0.05;
          if (same) hiT -= 2 * delta + 0.05;
          else loT += 2 * delta + 0.05;
        }
        if (hiS - loS > 0.1 && hiT - loT > 0.1) runs.push([[loS, hiS], [loT, hiT]]);
        i = j;
      }
      const key = `t:${s.uuid.slice(0, 8)}${t.uuid.slice(0, 8)}`;
      for (const [sr, tr] of runs)
        for (const [x, y, [lo, hi], role] of [[s, t, sr, "P"], [t, s, tr, "N"]] as const) {
          const uy = unit(sub(y.b, y.a));
          const ny: Pt = [-uy[1], uy[0]];
          const side: Pt = dot(sub(y.a, x.a), ny) > 0 ? ny : mul(ny, -1);
          (out.get(x.uuid) ?? out.set(x.uuid, []).get(x.uuid)!).push({ lo, hi, vec: mul(side, delta), ov: hi - lo, key, role });
        }
    }
  return out;
}

type Piece = { t0: number; t1: number; vec: Pt | null; key: [string, "P" | "N"] | null };

/** Pieces of segment s; a range where the moved track would come within the gap of the partner's vias/pads stays put. */
function split(s: PSeg, ivs: Array<{ lo: number; hi: number; vec: Pt; ov: number; key: string; role: "P" | "N" }>, obstacles: Array<[Pt, number]>, gap: number): Piece[] {
  const L = norm(sub(s.b, s.a));
  const u = unit(sub(s.b, s.a));
  const n: Pt = [-u[1], u[0]];
  const cuts = [...new Set([0, L, ...ivs.flatMap((iv) => [iv.lo, iv.hi])])].sort((x, y) => x - y);
  const rng: Piece[] = [];
  for (let q = 0; q + 1 < cuts.length; q++) {
    const a = cuts[q]!;
    const b = cuts[q + 1]!;
    if (b - a < 1e-6) continue;
    let best: (typeof ivs)[number] | null = null;
    for (const iv of ivs) if (iv.lo <= a + 1e-9 && iv.hi >= b - 1e-9 && (best === null || iv.ov > best.ov)) best = iv;
    rng.push({ t0: a, t1: b, vec: best ? best.vec : null, key: best ? [best.key, best.role] : null });
  }
  let out: Piece[] = [];
  for (const { t0: a, t1: b, vec, key } of rng) {
    if (vec === null) {
      out.push({ t0: a, t1: b, vec: null, key: null });
      continue;
    }
    const blocked: Array<[number, number]> = [];
    const R0 = s.w / 2 + gap + 0.01;
    const o = add(s.a, vec);
    for (const [c, r] of obstacles) {
      const R = R0 + r;
      const perp = Math.abs(dot(sub(c, o), n));
      if (perp >= R) continue;
      const along = dot(sub(c, o), u);
      const half = Math.sqrt(R * R - perp * perp) + norm(vec) + 0.02;
      blocked.push([along - half, along + half]);
    }
    let pieces: Array<[number, number]> = [[a, b]];
    for (const [b0, b1] of blocked) {
      const nxt: Array<[number, number]> = [];
      for (const [p0, p1] of pieces) {
        if (b1 <= p0 || b0 >= p1) {
          nxt.push([p0, p1]);
          continue;
        }
        if (b0 > p0) nxt.push([p0, b0]);
        if (b1 < p1) nxt.push([b1, p1]);
      }
      pieces = nxt;
    }
    let last = a;
    for (const [p0, p1] of pieces) {
      if (p0 > last) out.push({ t0: last, t1: p0, vec: null, key: null });
      out.push({ t0: p0, t1: p1, vec, key });
      last = p1;
    }
    if (last < b) out.push({ t0: last, t1: b, vec: null, key: null });
  }
  for (const pc of out)
    if (pc.vec !== null && (pc.t0 > 1e-9 || pc.t1 < L - 1e-9) && pc.t1 - pc.t0 < 5 * norm(pc.vec) + 0.05) {
      pc.vec = null;
      pc.key = null;
    }
  const merged: Piece[] = [];
  const sameVec = (x: Pt | null, y: Pt | null) => (x === null ? y === null : y !== null && x[0] === y[0] && x[1] === y[1]);
  for (const pc of out) {
    const m = merged[merged.length - 1];
    if (m && sameVec(m.vec, pc.vec) && (m.key === null ? pc.key === null : pc.key !== null && m.key[0] === pc.key[0] && m.key[1] === pc.key[1])) m.t1 = pc.t1;
    else merged.push({ ...pc });
  }
  out = merged;
  return out;
}

export interface Plan {
  widths: Map<string, number[]>;
  ivs: Map<string, Iv[]>;
  obst: Obst;
  byNet: Map<string, PairSpec>;
}

export function plan(segs: PSeg[], pads: Pad[], board: Board, pairs: PairSpec[], ops: ReadonlySet<string>, stack: readonly string[]): Plan {
  const byNet = new Map<string, PairSpec>();
  for (const pr of pairs) {
    byNet.set(pr.p, pr);
    byNet.set(pr.n, pr);
  }
  const widths = new Map<string, number[]>();
  const ivs = new Map<string, Iv[]>();
  for (const s of segs) {
    const pr = byNet.get(s.net);
    if (pr && ops.has("width") && Math.abs(s.w - pr.w) > 1e-4) widths.set(s.uuid, [pr.w, ...(s.w < pr.neck_w - 1e-4 ? [pr.neck_w] : []), s.w]);
  }
  const obst: Obst = new Map();
  if (ops.has("tighten")) {
    const grid = new Grid(segs, pads, board.vias, stack);
    for (const pr of pairs) for (const [u, v] of pairings(pr, segs, grid)) ivs.set(u, [...(ivs.get(u) ?? []), ...v]);
    for (const v of board.vias) {
      const [lo, hi] = viaSpan(v, stack);
      for (const L of stack.slice(stack.indexOf(lo), stack.indexOf(hi) + 1)) (obst.get(`${v.net}|${L}`) ?? obst.set(`${v.net}|${L}`, []).get(`${v.net}|${L}`)!).push([[v.x, v.y], v.size / 2]);
    }
    for (const p of pads) for (const L of padLayers(p, stack)) (obst.get(`${p.net}|${L}`) ?? obst.set(`${p.net}|${L}`, []).get(`${p.net}|${L}`)!).push([[p.x, p.y], p.r]);
  }
  return { widths, ivs, obst, byNet };
}

/** Group modes: 0 both tracks move half, 1 only P moves (all of it), 2 only N, 3 none. */
export function factor(mode: number, role: "P" | "N"): number {
  return mode === 0 ? 1 : mode === 1 ? (role === "P" ? 2 : 0) : mode === 2 ? (role === "N" ? 2 : 0) : 0;
}

type Shift = [string, Pt, "P" | "N"];

export function makePieces(segs: PSeg[], ivs: Map<string, Iv[]>, obst: Obst, byNet: Map<string, PairSpec>, modes: Map<string, number>): { segs: PSeg[]; shifts: Map<string, Shift> } {
  const out: PSeg[] = [];
  const shifts = new Map<string, Shift>();
  for (const s of segs) {
    const mine = (ivs.get(s.uuid) ?? [])
      .map((iv) => ({ ...iv, f: factor(modes.get(iv.key) ?? 3, iv.role) }))
      .filter((iv) => iv.f)
      .map((iv) => ({ lo: iv.lo, hi: iv.hi, vec: mul(iv.vec, iv.f), ov: iv.ov, key: iv.key, role: iv.role }));
    if (!mine.length) {
      out.push(s);
      continue;
    }
    const pr = byNet.get(s.net)!;
    const mate = s.net === pr.p ? pr.n : pr.p;
    const L = norm(sub(s.b, s.a));
    const u = unit(sub(s.b, s.a));
    const pcs = split(s, mine, obst.get(`${mate}|${s.layer}`) ?? [], pr.gap);
    pcs.forEach(({ t0, t1, vec, key }, i) => {
      let a = add(s.a, mul(u, t0));
      const b = t1 < L - 1e-9 ? add(s.a, mul(u, t1)) : s.b;
      if (t0 <= 1e-9) a = s.a;
      let pc: PSeg;
      if (pcs.length === 1) pc = s;
      else if (i === 0) pc = { ...s, a, b, orig: s.uuid, orig_ab: [s.a, s.b] };
      else pc = { ...s, a, b, uuid: uuid5url(`pairfix-split:${s.uuid}:${t0.toFixed(4)}`), span: null, orig: s.uuid };
      if (vec !== null) shifts.set(pc.uuid, [key![0], vec, key![1]]);
      out.push(pc);
    });
  }
  return { segs: out, shifts };
}

/** A split segment none of whose pieces moves is put back whole. */
export function effective(psegs: PSeg[], shifts: Map<string, Shift>): PSeg[] {
  const moving = new Set(psegs.filter((s) => shifts.has(s.uuid)).map((s) => s.orig));
  const out: PSeg[] = [];
  for (const s of psegs) {
    const o = s.orig;
    if (o === undefined || moving.has(o)) out.push(s);
    else if (s.span !== null) {
      const [a, b] = s.orig_ab!;
      const { orig: _o, orig_ab: _ab, ...rest } = s;
      void _o;
      void _ab;
      out.push({ ...rest, a, b });
    }
  }
  return out;
}

export interface Built {
  res: Map<string, [Pt, Pt, number]>;
  jogs: Array<{ from: string; a: Pt; b: Pt; group: string | null; uuid?: string }>;
  touched: Map<string, Set<string>>;
  invalid: Set<string>;
}

const r4 = (x: number) => pyRound(x, 4);

export function build(segs: PSeg[], pads: Pad[], board: Board, shifts: Map<string, Shift>, widths: Map<string, number[]>, widx: Map<string, number>, byNet: Map<string, PairSpec>, stack: readonly string[]): Built {
  const sh = new Map([...shifts].map(([u, [, v]]) => [u, v] as [string, Pt]));
  const sib = new Map<string, Set<string>>();
  for (const s of segs)
    if (s.orig && sh.has(s.uuid)) (sib.get(s.orig) ?? sib.set(s.orig, new Set()).get(s.orig)!).add(shifts.get(s.uuid)![0]);
  const segBy = new Map(segs.map((s) => [s.uuid, s]));
  const oOf = (s: PSeg) => s.orig ?? s.uuid;
  const wOf = new Map<string, number>();
  for (const s of segs) if (byNet.has(s.net)) wOf.set(s.uuid, widths.has(oOf(s)) ? widths.get(oOf(s))![widx.get(oOf(s))!]! : s.w);
  const pairSegs = segs.filter((s) => byNet.has(s.net));
  const verts = new Map<string, { k: [number, number, string, string]; ents: Array<[string, number]> }>();
  const addV = (p: Pt, s: PSeg, e: number) => {
    const k: [number, number, string, string] = [r4(p[0]), r4(p[1]), s.layer, s.net];
    const id = k.join("|");
    (verts.get(id) ?? verts.set(id, { k, ents: [] }).get(id)!).ents.push([s.uuid, e]);
  };
  for (const s of pairSegs) {
    addV(s.a, s, 0);
    addV(s.b, s, 1);
  }
  const viaAt = new Map<string, Array<{ x: number; y: number; size: number }>>();
  for (const v of board.vias) (viaAt.get(v.net) ?? viaAt.set(v.net, []).get(v.net)!).push(v);
  const padAt = new Map<string, Pad[]>();
  for (const p of pads) (padAt.get(p.net) ?? padAt.set(p.net, []).get(p.net)!).push(p);
  const fixed = (k: [number, number, string, string], ents: Array<[string, number]>) => {
    if (ents.length !== 2) return true;
    const q: Pt = [k[0], k[1]];
    return (
      (viaAt.get(k[3]) ?? []).some((v) => norm(sub(q, [v.x, v.y])) <= v.size / 2 + 1e-3) ||
      (padAt.get(k[3]) ?? []).some((p) => padLayers(p, stack).includes(k[2]) && norm(sub(q, [p.x, p.y])) <= p.r + 1e-3)
    );
  };
  const zero: Pt = [0, 0];
  const newEnd = new Map<string, Pt>();
  const jogs: Built["jogs"] = [];
  const touched = new Map<string, Set<string>>();
  const touch = (u: string, gs: Iterable<string>) => {
    const t = touched.get(u) ?? touched.set(u, new Set()).get(u)!;
    for (const g of gs) t.add(g);
  };
  const invalid = new Set<string>();
  const gname = (u: string) => (sh.has(u) ? shifts.get(u)![0] : null);
  for (const { k, ents } of verts.values()) {
    const first = segBy.get(ents[0]![0])!;
    const v = ents[0]![1] === 0 ? first.a : first.b;
    if (!ents.some(([u]) => sh.has(u))) continue;
    if (fixed(k, ents)) {
      for (const [u, e] of ents) {
        if (!sh.has(u)) continue;
        const s = segBy.get(u)!;
        const other = e === 0 ? s.b : s.a;
        const d = norm(sh.get(u)!);
        if (norm(sub(other, v)) < 2 * d + 0.02) {
          invalid.add(gname(u)!);
          continue;
        }
        const p = add(add(v, sh.get(u)!), mul(unit(sub(other, v)), d));
        newEnd.set(`${u}|${e}`, p);
        jogs.push({ from: u, a: v, b: p, group: gname(u) });
      }
      continue;
    }
    const [[u1, e1], [u2, e2]] = ents as [[string, number], [string, number]];
    const s1 = segBy.get(u1)!;
    const s2 = segBy.get(u2)!;
    const d1 = unit(sub(e1 === 0 ? s1.b : s1.a, v));
    const d2 = unit(sub(e2 === 0 ? s2.b : s2.a, v));
    const h1 = sh.get(u1) ?? zero;
    const h2 = sh.get(u2) ?? zero;
    const gs = [gname(u1), gname(u2)].filter((g): g is string => !!g);
    const c = cross2(d1, d2);
    let p: Pt | null = null;
    if (Math.abs(c) > 0.05) {
      const a = cross2(sub(h2, h1), d2) / c;
      p = add(add(v, h1), mul(d1, a));
      if (norm(sub(p, v)) > 4 * Math.max(norm(h1), norm(h2)) + 1e-6) p = null;
    }
    if (p !== null) {
      newEnd.set(`${u1}|${e1}`, p);
      newEnd.set(`${u2}|${e2}`, p);
    } else if (dot(d1, d2) < 0 && norm(sub(h1, h2)) < 1e-4) {
      const q = add(v, h1);
      newEnd.set(`${u1}|${e1}`, q);
      newEnd.set(`${u2}|${e2}`, q);
    } else if (dot(d1, d2) < 0) {
      const one = norm(h1) >= norm(h2);
      const [big, bh, be, small, smh, sme, bd] = one ? [u1, h1, e1, u2, h2, e2, d1] : [u2, h2, e2, u1, h1, e1, d2];
      const delta = norm(sub(bh, smh));
      const sb = segBy.get(big)!;
      if (norm(sub(sb.b, sb.a)) < 2 * delta + 0.02) {
        for (const g of gs) invalid.add(g);
        continue;
      }
      const pb = add(add(v, bh), mul(bd, delta));
      const ps = add(v, smh);
      newEnd.set(`${big}|${be}`, pb);
      newEnd.set(`${small}|${sme}`, ps);
      jogs.push({ from: big, a: ps, b: pb, group: gname(big) ?? gname(small) });
    } else {
      for (const g of gs) invalid.add(g);
      continue;
    }
    touch(u1, gs);
    touch(u2, gs);
  }
  const res = new Map<string, [Pt, Pt, number]>();
  for (const s of pairSegs) {
    const u = s.uuid;
    const a = newEnd.get(`${u}|0`) ?? s.a;
    const b = newEnd.get(`${u}|1`) ?? s.b;
    const same = (p: Pt, q: Pt) => p[0] === q[0] && p[1] === q[1];
    if (!(same(a, s.a) && same(b, s.b))) {
      if (dot(sub(b, a), sub(s.b, s.a)) <= 0 || norm(sub(b, a)) < 0.01) {
        for (const g of touched.get(u) ?? []) invalid.add(g);
        const gn = gname(u);
        if (gn) invalid.add(gn);
        continue;
      }
    }
    const ab = s.orig_ab ?? [s.a, s.b];
    if (!(same(a, ab[0]) && same(b, ab[1])) || s.span === null || wOf.get(u) !== s.w) res.set(u, [a, b, wOf.get(u)!]);
    if (widths.has(oOf(s))) touch(u, ["w:" + oOf(s)]);
    if (s.orig) touch(u, sib.get(s.orig) ?? []);
  }
  return { res, jogs, touched, invalid };
}

/** Python's repr of a float (shortest round trip; `2.0`, `5e-05`). */
export function pyRepr(x: number): string {
  if (Object.is(x, -0)) return "-0.0";
  const a = Math.abs(x);
  if (Number.isInteger(x) && a < 1e16) return x.toFixed(1);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  return String(x);
}
/** Python's str() of a point tuple, `(15.3, 2.0)`: the jog uuids are uuid5 of it, as the toolkit's. */
const pyTuple = (p: Pt) => `(${pyRepr(p[0])}, ${pyRepr(p[1])})`;

export function writeBoard(text: string, segs: PSeg[], out: Map<string, [Pt, Pt, number]>, jogs: Built["jogs"], wOf: (u: string) => number): string {
  const segBy = new Map(segs.map((s) => [s.uuid, s]));
  const parts: string[] = [];
  let last = 0;
  for (const s of segs) {
    if (!out.has(s.uuid) || s.span === null) continue;
    const [a, b, w] = out.get(s.uuid)!;
    let blk = text.slice(s.span[0], s.span[1]);
    blk = blk.replace(new RegExp(`\\(start ${NUM} ${NUM}\\)`), `(start ${fmt(a[0])} ${fmt(a[1])})`);
    blk = blk.replace(new RegExp(`\\(end ${NUM} ${NUM}\\)`), `(end ${fmt(b[0])} ${fmt(b[1])})`);
    blk = blk.replace(new RegExp(`\\(width ${NUM}\\)`), `(width ${fmt(w)})`);
    parts.push(text.slice(last, s.span[0]), blk);
    last = s.span[1];
  }
  parts.push(text.slice(last));
  let t = parts.join("");
  const seg = (a: Pt, b: Pt, w: number, s: PSeg, uuid: string) =>
    `\t(segment\n\t\t(start ${fmt(a[0])} ${fmt(a[1])})\n\t\t(end ${fmt(b[0])} ${fmt(b[1])})\n\t\t(width ${fmt(w)})\n\t\t(layer "${s.layer}")\n\t\t(net ${s.net_raw})\n\t\t(uuid "${uuid}")\n\t)`;
  const added: string[] = [];
  for (const s of segs) if (s.span === null && out.has(s.uuid)) added.push(seg(out.get(s.uuid)![0], out.get(s.uuid)![1], out.get(s.uuid)![2], s, s.uuid));
  for (const j of jogs) {
    const s = segBy.get(j.from)!;
    j.uuid = uuid5url(`pairfix:${s.uuid}:${pyTuple(j.a)}:${pyTuple(j.b)}`);
    added.push(seg(j.a, j.b, wOf(s.uuid), s, j.uuid));
  }
  if (added.length) {
    const i = t.trimEnd().lastIndexOf(")");
    t = t.slice(0, i).trimEnd() + "\n" + added.join("\n") + "\n)\n";
  }
  return t;
}

/** Ops named in `--ops` that this port refuses (all of pairfix.py's ops are ported). */
const UNPORTED: string[] = [];
/** pairfix.py `run --ops` default: in-place via and path moves first, then widths and spacing, length matching last. */
export const DEFAULT_OPS = "vias,mirror,retune,width,tighten,skew";

export interface TightenInput {
  step: Step;
  input: StepInput;
  req: Requirements;
  drc: DrcFn;
  /** Rounds of DRC-guarded edits per pass (default 12; `--rounds N` in the step's args wins). */
  rounds?: number;
}

/**
 * Nets failing A8 on the source board (pairfix.py reads SRC/acceptance.json): the scorer's `.lastmile/acceptance.json` in
 * `cur` when present, else A8 computed here from the base DRC. null (every pair) when neither is available.
 */
async function failingNets(cur: string, text: string, req: Requirements, run: Awaited<ReturnType<typeof drcRun>>["run"]): Promise<Set<string> | null> {
  const det = (acc: { results?: Record<string, Record<string, unknown>> }) => new Set(Object.keys((acc.results?.["A8_pairs"]?.["detail"] ?? {}) as object));
  for (const f of [join(cur, ".lastmile", "acceptance.json"), join(cur, "acceptance.json")]) {
    const t = await readFile(f, "utf8").catch(() => null);
    if (t !== null) return det(JSON.parse(t));
  }
  try {
    return det(checkAcceptance(parseBoard(text), req, { violations: run.violations, unconnected: run.unconnected.length, parity: 0 }) as never);
  } catch {
    return null;
  }
}

/** One pairfix step: copy the board folder to `input.out`, edit the pair copper there, return the folder. */
export async function runTighten(o: TightenInput): Promise<StepOutcome> {
  const t0 = Date.now();
  const args = o.step.args ?? [];
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const ops = new Set((arg("--ops") ?? DEFAULT_OPS).split(","));
  const bad = UNPORTED.filter((x) => ops.has(x));
  if (bad.length) return { error: `pairfix ops not ported: ${bad.join(", ")}` };
  const { input } = o;
  await copyBoardFolder(input.cur, input.out);
  const boardFile = join(input.out, input.pcb);
  const textOrig = await readFile(boardFile, "utf8");
  let text = textOrig;
  const prof = profile(o.req.acceptance);
  const stack = prof.copper;
  const pairs = classesAndPairs(o.req, arg("--pairs") ?? null);
  const maxRounds = arg("--rounds") !== undefined ? Number(arg("--rounds")) : (o.rounds ?? 12);
  const baseRun = await drcRun(o.drc, join(input.cur, input.pcb), join(input.out, "base.drc.json"), input.signal);
  const base = new Set(baseRun.items.map(sig));
  const before = measurePairs(parseBoard(text), pairs, stack);
  const ctx: PassCtx = { boardFile, outDir: join(input.out, ".lastmile", "pairfix"), base, rounds: maxRounds, drc: o.drc, signal: input.signal, req: o.req, stack, ground: prof.ground };
  const passS: Record<string, number> = {};
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const r = await f();
    passS[name] = Math.round((Date.now() - t) / 100) / 10;
    return r;
  };
  let viasRep: unknown = null;
  let mirrorRep: unknown = null;
  let retuneRep: unknown = null;
  let skewRep: unknown = null;
  const needFailing = ops.has("vias") || ops.has("mirror") || ops.has("mirror-force");
  const failing = needFailing ? await failingNets(input.cur, text, o.req, baseRun.run) : null;
  const onlyFailing = pairs.filter((pr) => failing === null || failing.has(pr.p) || failing.has(pr.n));
  if (ops.has("vias")) ({ text, rep: viasRep } = await timed("vias", () => viasPass(text, onlyFailing, ctx)));
  if (ops.has("mirror") || ops.has("mirror-force")) {
    const force = ops.has("mirror-force");
    ({ text, rep: mirrorRep } = await timed("mirror", () => mirrorPass(text, onlyFailing, ctx, force)));
    if (force) for (const v of await drcItems(o.drc, boardFile, join(ctx.outDir, "mirror-final.drc.json"), input.signal)) base.add(sig(v)); // the displaced tracks: the repair step's
  }
  if (ops.has("retune")) ({ text, rep: retuneRep } = await timed("retune", () => retunePass(text, pairs, ctx)));
  const model = parseBoard(text);
  const pads = model.pads;
  const segs = readSegments(text);
  const tTight = Date.now();
  const { widths, ivs, obst, byNet } = plan(segs, pads, model, pairs, ops, stack);
  const widx = new Map([...widths.keys()].map((u) => [u, 0]));
  const active = new Map<string, number>();
  for (const v of ivs.values()) for (const iv of v) active.set(iv.key, 0);
  const tried = new Map<string, Set<number>>();
  const step = (g: string, roles: Set<string>) => {
    const t = tried.get(g) ?? tried.set(g, new Set()).get(g)!;
    t.add(active.get(g)!);
    const order = roles.size === 1 && roles.has("P") ? [2, 1] : [1, 2];
    return [...order, 3].find((m) => !t.has(m)) ?? 3;
  };
  const rounds: Array<Record<string, unknown>> = [];
  const reverted = new Map<string, number>();
  const invalidAll = new Set<string>();
  let newCount: number | null = null;
  for (let rnd = 1; rnd <= maxRounds; rnd++) {
    let built: Built;
    let psegs: PSeg[];
    let shifts: Map<string, Shift>;
    let eff: PSeg[];
    for (;;) {
      ({ segs: psegs, shifts } = makePieces(segs, ivs, obst, byNet, active));
      eff = effective(psegs, shifts);
      built = build(eff, pads, model, shifts, widths, widx, byNet, stack);
      if (!built.invalid.size) break;
      for (const g of built.invalid) {
        if (active.has(g)) active.set(g, step(g, new Set()));
        invalidAll.add(g);
      }
    }
    const pmap = new Map(psegs.map((s) => [s.uuid, s]));
    const origOf = (u: string) => pmap.get(u)?.orig ?? u;
    const wOf = (u: string) => (widths.has(origOf(u)) ? widths.get(origOf(u))![widx.get(origOf(u))!]! : pmap.get(u)!.w);
    await writeFile(boardFile, writeBoard(text, eff, built.res, built.jogs, wOf));
    const td = Date.now();
    const items = await drcItems(o.drc, boardFile, join(input.out, `round${rnd}.drc.json`), input.signal);
    const fresh = items.filter((v) => !base.has(sig(v)));
    newCount = fresh.length;
    const owner = new Map<string, Set<string>>();
    const own = (u: string) => owner.get(u) ?? owner.set(u, new Set()).get(u)!;
    for (const u of built.res.keys()) {
      for (const g of built.touched.get(u) ?? []) own(u).add(g);
      if (shifts.has(u)) own(u).add(shifts.get(u)![0]);
      if (widths.has(origOf(u))) own(u).add("w:" + origOf(u));
    }
    for (const j of built.jogs) {
      own(j.uuid!).add(j.group!);
      if (widths.has(origOf(j.from))) own(j.uuid!).add("w:" + origOf(j.from));
    }
    const bad = new Map<string, Set<string>>();
    const netOf = new Map<string, string>([...eff.map((s) => [s.uuid, s.net] as [string, string]), ...built.jogs.map((j) => [j.uuid!, pmap.get(j.from)?.net ?? ""] as [string, string])]);
    const role = (u: string): string | null => {
      const n = netOf.get(u);
      return n && byNet.has(n) ? (byNet.get(n)!.p === n ? "P" : "N") : null;
    };
    const ownedBy = (v: Item) => {
      const hit = new Set<string>();
      for (const i of v.items) for (const g of owner.get(i.uuid ?? "") ?? []) hit.add(g);
      return new Set([...hit].filter(Boolean));
    };
    for (const v of fresh) {
      let hit = ownedBy(v);
      const roles = new Set(v.items.map((i) => role(i.uuid ?? "")).filter((r): r is string => !!r));
      if (!hit.size)
        for (const i of v.items) {
          if (!i.pos) continue;
          const q: Pt = [i.pos.x, i.pos.y];
          for (const [u, [pa, pb]] of built.res) if (segDist(q, pa, pb) < 0.6) for (const g of owner.get(u) ?? []) hit.add(g);
        }
      hit = new Set([...hit].filter(Boolean));
      for (const g of hit) {
        const r = bad.get(g) ?? bad.set(g, new Set()).get(g)!;
        for (const x of roles) r.add(x);
      }
    }
    const newTypes: Record<string, number> = {};
    for (const v of fresh) newTypes[v.type] = (newTypes[v.type] ?? 0) + 1;
    rounds.push({
      round: rnd,
      drc_s: Math.round((Date.now() - td) / 100) / 10,
      active_groups: [...active.values()].filter((m) => m < 3).length,
      width_changes: [...widths].filter(([u, ws]) => widx.get(u)! < ws.length - 1).length,
      jogs: built.jogs.length,
      new_items: fresh.length,
      new_types: newTypes,
      unattributed: fresh.filter((v) => !ownedBy(v).size).length,
    });
    if (!fresh.length) break;
    if (!bad.size) break;
    for (const [g, roles] of bad) {
      reverted.set(g, (reverted.get(g) ?? 0) + 1);
      if (g.startsWith("w:")) {
        const u = g.slice(2);
        widx.set(u, Math.min((widx.get(u) ?? 0) + 1, widths.get(u)!.length - 1));
      } else if (active.has(g)) active.set(g, step(g, roles));
    }
  }
  passS["width_tighten"] = Math.round((Date.now() - tTight) / 100) / 10;
  if (ops.has("skew")) {
    const cur = await readFile(boardFile, "utf8");
    ({ rep: skewRep } = await timed("skew", () => skewPass(cur, pairs, ctx)));
  }
  const finalText = await readFile(boardFile, "utf8");
  const after = measurePairs(parseBoard(finalText), pairs, stack);
  // collateral: non-pair copper must be byte-identical (pair vias are this tool's to move)
  const nonpair = (t: string) => readSegments(t).filter((s) => !byNet.has(s.net)).map((s) => t.slice(s.span![0], s.span![1]));
  const viaTxt = (t: string) => [...t.matchAll(/\(via\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gs)].map((m) => m[0]).filter((v) => ![...byNet.keys()].some((n) => v.includes(`(net "${n}")`)));
  const symDiff = (x: string[], y: string[]) => {
    const a0 = new Set(x);
    const a1 = new Set(y);
    return [...a0].filter((v) => !a1.has(v)).length + [...a1].filter((v) => !a0.has(v)).length;
  };
  const collateral = symDiff(nonpair(textOrig), nonpair(finalText)) + symDiff(viaTxt(textOrig), viaTxt(finalText));
  const modes = { 0: "both", 1: "P only", 2: "N only", 3: "reverted" } as Record<number, string>;
  const groupModes: Record<string, number> = {};
  for (const m of active.values()) groupModes[modes[m]!] = (groupModes[modes[m]!] ?? 0) + 1;
  const widthApplied: Record<string, number> = {};
  for (const [u, ws] of widths)
    if (widx.get(u)! < ws.length - 1) {
      const k = Number.isInteger(ws[widx.get(u)!]!) ? ws[widx.get(u)!]!.toFixed(1) : String(ws[widx.get(u)!]!);
      widthApplied[k] = (widthApplied[k] ?? 0) + 1;
    }
  return {
    dir: input.out,
    info: {
      pairfix: {
        pairs: arg("--pairs") ?? null,
        ops: [...ops].sort(),
        rounds,
        final_new_drc: newCount,
        groups_planned: active.size,
        groups_applied: [...active.values()].filter((m) => m < 3).length,
        group_modes: groupModes,
        groups_reverted: [...reverted.keys()].filter((g) => !g.startsWith("w:")).sort(),
        groups_invalid_geometry: [...invalidAll].sort(),
        width_planned: widths.size,
        width_applied: widthApplied,
        vias: viasRep,
        mirror: mirrorRep,
        retune: retuneRep,
        skew: skewRep,
        collateral_items: collateral,
        wall_s: Math.round((Date.now() - t0) / 100) / 10,
        pass_s: passS,
        pairs_before_after: Object.fromEntries(
          Object.keys(before).map((k) => [k, { share: [before[k]!.coupled_share, after[k]!.coupled_share], len_diff: [pyRound(Math.abs(before[k]!.p_mm - before[k]!.n_mm), 2), pyRound(Math.abs(after[k]!.p_mm - after[k]!.n_mm), 2)] }]),
        ),
      },
    },
  };
}

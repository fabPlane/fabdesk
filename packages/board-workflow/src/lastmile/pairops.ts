/**
 * The pair ops of the toolkit's tools/pairfix.py `run` that run as their own DRC-guarded passes before (vias, mirror,
 * mirror-force, retune) and after (skew) the width/tighten rounds of tighten.ts:
 *
 *   vias          P/N via transitions further apart than via size + gap move toward each other, the pair segments on
 *                 them stretched; spot and segments checked clear, DRC judges (a refused option falls to the next)
 *   mirror        P and N chains between the same two end areas: one member rebuilt as the other's path offset by the
 *                 class spacing, joined to its own ends (N follows P, else P follows N); DRC judges
 *   mirror-force  as mirror, but the path may overlap tracks of ordinary signal nets and plane-only ground vias (moved
 *                 out of the way, never deleted); those signal-track DRC items are left for the next step
 *   retune        one-sided length-tune wiggles rebuilt as 45 degree jogs to the class spacing plus compact square bumps
 *                 away from the partner, same length
 *   skew          a pair over its class length-difference limit gets square bumps on the shorter member
 *
 * A faithful port, quirks included (each is named where it lives and in docs/evidence/board-workflow/lastmile-pairops-parity.md).
 * The shared text helpers (segment/via readers, uuid5, number format, DRC signature) live here too; tighten.ts re-exports them.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pyRound } from "../accept";
import { parseBoard, type Pad, type Segment, type Via } from "../board";
import type { Requirements } from "../requirements";
import { add, cross2, dot, mul, norm, segDist, sub, type Pt } from "./geometry";
import { classesAndPairs, padLayers, type PairSpec } from "./pairs";
import type { DrcFn, DrcRun } from "./scoring";

// ---------------------------------------------------------------- shared text helpers (pairfix.py top level)

export const ITEM = /\(segment\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gs;
export const NUM = "(-?[\\d.]+(?:e-?\\d+)?)";
const VIA = /\(via\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gs;

export interface PSeg extends Segment {
  net: string;
  net_raw: string;
  uuid: string;
  span: [number, number] | null;
  orig?: string;
  orig_ab?: [Pt, Pt];
}

export const unit = (a: Pt): Pt => {
  const n = norm(a);
  return n ? [a[0] / n, a[1] / n] : [0, 0];
};

/** Python's math.copysign(1, x): the sign of x, -0 included. */
const copysign1 = (x: number) => (x < 0 || Object.is(x, -0) ? -1 : 1);

/** UUID version 5 in the URL namespace, as Python's uuid5(NAMESPACE_URL, name). */
export function uuid5url(name: string): string {
  const ns = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const h = createHash("sha1").update(ns).update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function readSegments(text: string): PSeg[] {
  const segs: PSeg[] = [];
  for (const m of text.matchAll(ITEM)) {
    const blk = m[0];
    const g = (rx: RegExp) => rx.exec(blk);
    const st = g(new RegExp(`\\(start ${NUM} ${NUM}\\)`))!;
    const en = g(new RegExp(`\\(end ${NUM} ${NUM}\\)`))!;
    const netRaw = g(/\(net ("(?:[^"\\]|\\.)*"|\d+)\)/)![1]!;
    segs.push({
      a: [Number(st[1]), Number(st[2])],
      b: [Number(en[1]), Number(en[2])],
      w: Number(g(new RegExp(`\\(width ${NUM}\\)`))![1]),
      layer: g(/\(layer "([^"]+)"\)/)![1]!,
      net_raw: netRaw,
      net: netRaw.startsWith('"') ? (JSON.parse(netRaw) as string) : "",
      uuid: g(/\(uuid "([^"]+)"\)/)![1]!,
      span: [m.index!, m.index! + blk.length],
    });
  }
  return segs;
}

/** A via as written (pairfix.py read_vias): layers in write order, its text span. */
export interface RVia {
  xy: Pt;
  net: string | null;
  size: number;
  layers: string[];
  span: [number, number];
  uuid: string;
}

export function readVias(text: string): RVia[] {
  const out: RVia[] = [];
  for (const m of text.matchAll(VIA)) {
    const blk = m[0];
    const at = new RegExp(`\\(at ${NUM} ${NUM}\\)`).exec(blk)!;
    const net = /\(net ("(?:[^"\\]|\\.)*")\)/.exec(blk);
    const lay = [.../\(layers [^)]*\)/.exec(blk)![0].matchAll(/"([^"]+\.Cu)"/g)].map((x) => x[1]!);
    out.push({
      xy: [Number(at[1]), Number(at[2])],
      net: net ? (JSON.parse(net[1]!) as string) : null,
      size: Number(new RegExp(`\\(size ${NUM}`).exec(blk)![1]),
      layers: lay,
      span: [m.index!, m.index! + blk.length],
      uuid: /\(uuid "([^"]+)"\)/.exec(blk)![1]!,
    });
  }
  return out;
}

export const fmt = (x: number) => x.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

export type Item = { type: string; items: Array<{ description?: string; uuid?: string; pos?: { x: number; y: number } }> };
export const sig = (v: Item) => `${v.type}|${v.items.map((i) => i.description ?? "").sort().join("|")}`;

export async function drcRun(drc: DrcFn, board: string, outFile: string, signal: AbortSignal): Promise<{ run: DrcRun; items: Item[] }> {
  const run = await drc({ board, parity: false, outFile, signal });
  const items = [...run.violations.filter((v) => v.severity === "error").map((v) => ({ type: v.rule, items: v.items ?? [] })), ...run.unconnected.map((u) => ({ type: "unconnected", items: u.items }))];
  return { run, items };
}

export async function drcItems(drc: DrcFn, board: string, outFile: string, signal: AbortSignal): Promise<Item[]> {
  return (await drcRun(drc, board, outFile, signal)).items;
}

const r3 = (x: number) => pyRound(x, 3);
const r4 = (x: number) => pyRound(x, 4);
const plen = (vs: readonly Pt[]) => {
  let t = 0;
  for (let i = 0; i + 1 < vs.length; i++) t += norm(sub(vs[i + 1]!, vs[i]!));
  return t;
};
const slen = (s: Segment) => norm(sub(s.b, s.a));
const pairsOf = <T>(vs: readonly T[]): Array<[T, T]> => vs.slice(1).map((b, i) => [vs[i]!, b]);

// ---------------------------------------------------------------- Grid with soft nets (pairfix.py Grid)

type GObj = { kind: "seg" | "via" | "pt"; a: Pt; b: Pt | null; hw: number; net: string; vk: string | null };
const EMPTY: ReadonlySet<string> = new Set();
/** The key a soft (movable) via has in a `soft` set: Python's ('via', round(x, 4), round(y, 4)). */
export const viaKey = (p: Pt) => `via|${r4(p[0])}|${r4(p[1])}`;

/** Other copper per layer in 1 mm cells; `clear` may ignore tracks of `soft` nets and the soft vias (pairs.ts Grid plus `soft`). */
export class SoftGrid {
  private cells = new Map<string, GObj[]>();
  constructor(segs: readonly Segment[], pads: readonly Pad[], vias: ReadonlyArray<Pick<Via, "x" | "y" | "size" | "net" | "layers">>, stack: readonly string[]) {
    for (const s of segs) {
      this.put(s.layer, Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1]), { kind: "seg", a: s.a, b: s.b, hw: s.w / 2, net: s.net, vk: null });
    }
    for (const v of vias) {
      const i = [stack.indexOf(v.layers[0]), stack.indexOf(v.layers[1])].sort((x, y) => x - y);
      const o: GObj = { kind: "via", a: [v.x, v.y], b: null, hw: v.size / 2, net: v.net, vk: null };
      for (const L of stack.slice(i[0]!, i[1]! + 1)) this.put(L, v.x, v.y, v.x, v.y, o);
    }
    for (const p of pads) {
      const o: GObj = { kind: "pt", a: [p.x, p.y], b: null, hw: p.r, net: p.net, vk: null };
      for (const L of padLayers(p, stack)) this.put(L, p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, o);
    }
  }
  private put(L: string, x0: number, y0: number, x1: number, y1: number, obj: GObj) {
    for (let i = Math.floor(x0); i <= Math.floor(x1); i++)
      for (let j = Math.floor(y0); j <= Math.floor(y1); j++) {
        const k = `${L}|${i}|${j}`;
        (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(obj);
      }
  }
  /** No other-net copper within r of q on layer L (tracks of `soft` nets and soft vias ignored: they may be moved). */
  clear(L: string, q: Pt, r: number, nets: ReadonlySet<string>, soft: ReadonlySet<string> = EMPTY): boolean {
    for (let i = Math.floor(q[0] - r - 1); i <= Math.floor(q[0] + r + 1); i++)
      for (let j = Math.floor(q[1] - r - 1); j <= Math.floor(q[1] + r + 1); j++)
        for (const o of this.cells.get(`${L}|${i}|${j}`) ?? []) {
          if (nets.has(o.net)) continue;
          if (soft.size) {
            if (o.kind === "seg" && soft.has(o.net)) continue;
            if (o.kind === "via" && soft.has((o.vk ??= viaKey(o.a)))) continue;
          }
          const d = o.kind === "seg" ? segDist(q, o.a, o.b!) : norm(sub(q, o.a));
          if (d - o.hw < r) return false;
        }
    return true;
  }
}

// ---------------------------------------------------------------- pass context

export interface PassCtx {
  boardFile: string;
  /** Folder for the passes' DRC reports. */
  outDir: string;
  /** DRC signatures of the source board (and, after mirror-force, of the displaced tracks). */
  base: Set<string>;
  rounds: number;
  drc: DrcFn;
  signal: AbortSignal;
  req: Requirements;
  stack: readonly string[];
  ground: string;
  log?: (line: string) => void;
}

async function newItems(ctx: PassCtx, name: string): Promise<Item[]> {
  await mkdir(ctx.outDir, { recursive: true });
  const items = await drcItems(ctx.drc, ctx.boardFile, join(ctx.outDir, name), ctx.signal);
  return items.filter((v) => !ctx.base.has(sig(v)));
}

const say = (ctx: PassCtx, line: string) => ctx.log?.(line);

/** Chain keys whose new path passes within 0.6 mm of an item's position (the fallback attribution of every pass). */
function byPos(items: Item["items"], chains: ReadonlyArray<{ key: string; new: { verts: Pt[] } }>): Set<string> {
  const hit = new Set<string>();
  for (const i of items) {
    if (!i.pos) continue;
    const q: Pt = [i.pos.x, i.pos.y];
    for (const c of chains) if (pairsOf(c.new.verts).some(([a, b]) => segDist(q, a, b) < 0.6)) hit.add(c.key);
  }
  return hit;
}

// ---------------------------------------------------------------- vias

export interface ViaMove {
  v: RVia;
  q: Pt;
}
export interface ViaWork {
  key: string;
  pair: string;
  opts: Array<{ mode: string; moves: ViaMove[] }>;
  d: number;
  pitch: number;
  i: number;
}

/**
 * P/N via transitions of one pair (same layers as written, within 1.6 mm) further apart than via size + gap: moves that
 * bring them to that pitch along the line between them, each checked (new spot and stretched pair segments clear).
 * Quirk kept from the oracle: a move is kept only when its signed distance is > 1e-6, and N's is negative, so N never
 * moves: "both" moves P half the gap, "N only" moves nothing, "P only" moves P the whole gap.
 */
export function viaOptions(segs: readonly PSeg[], vias: readonly RVia[], pr: PairSpec, grid: SoftGrid, stack: readonly string[]): ViaWork[] {
  const out: ViaWork[] = [];
  const P = vias.filter((v) => v.net === pr.p);
  const N = vias.filter((v) => v.net === pr.n);
  const used = new Set<string>();
  const nets = new Set([pr.p, pr.n]);
  const sameLayers = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
  for (const vp of P) {
    let best: [number, RVia] | null = null;
    for (const vn of N) {
      if (!sameLayers(vn.layers, vp.layers) || used.has(vn.uuid)) continue;
      const d = norm(sub(vn.xy, vp.xy));
      if (best === null || d < best[0]) best = [d, vn];
    }
    if (!best) continue;
    const [d, vn] = best;
    const pitch = Math.max(pr.w + pr.gap, (vp.size + vn.size) / 2 + pr.gap + 0.01);
    if (d <= pitch + 0.02 || d > 1.6) continue;
    used.add(vn.uuid);
    const u = unit(sub(vn.xy, vp.xy));
    const gap = d - pitch;
    const opts: ViaWork["opts"] = [];
    for (const [mode, mp, mn] of [["both", gap / 2, gap / 2], ["N only", 0, gap], ["P only", gap, 0]] as const) {
      const moves: ViaMove[] = [];
      for (const [v, k] of [[vp, mp], [vn, -mn]] as const) if (k > 1e-6) moves.push({ v, q: add(v.xy, mul(u, k)) });
      let ok = true;
      for (const { v, q } of moves) {
        const i0 = stack.indexOf(v.layers[0]!);
        // write order, as the oracle: a via written bottom-up gets an empty slice (no spot check)
        const lay = i0 >= 0 ? stack.slice(i0, stack.indexOf(v.layers[1]!) + 1) : [...stack];
        if (!lay.every((L) => grid.clear(L, q, v.size / 2 + 0.2, nets))) ok = false;
        for (const s of segs) {
          if (s.net !== v.net) continue;
          for (const [e, o] of [[s.a, s.b], [s.b, s.a]] as const)
            if (norm(sub(e, v.xy)) < 1e-3) for (let k = 1; k < 6; k++) if (!grid.clear(s.layer, add(q, mul(sub(o, q), k / 6)), s.w / 2 + 0.2, nets)) ok = false;
        }
      }
      if (ok) opts.push({ mode, moves });
    }
    if (opts.length) out.push({ key: "v:" + vp.uuid.slice(0, 8), pair: pr.p, opts, d: pyRound(d, 3), pitch: pyRound(pitch, 3), i: 0 });
  }
  return out;
}

/** Text with each chosen move applied: the via's (at) and every same-net segment end on its old position. */
export function writeVias(text: string, segs: readonly PSeg[], chosen: readonly ViaMove[]): string {
  const rep: Array<[[number, number], string]> = [];
  const moved = new Map<string, ViaMove>();
  for (const m of chosen) {
    moved.set(m.v.uuid, m);
    const blk = text.slice(m.v.span[0], m.v.span[1]);
    rep.push([m.v.span, blk.replace(new RegExp(`\\(at ${NUM} ${NUM}\\)`), `(at ${fmt(m.q[0])} ${fmt(m.q[1])})`)]);
  }
  for (const s of segs) {
    let a = s.a;
    let b = s.b;
    for (const { v, q } of moved.values()) {
      if (s.net !== v.net) continue;
      if (norm(sub(a, v.xy)) < 1e-3) a = q;
      if (norm(sub(b, v.xy)) < 1e-3) b = q;
    }
    if (a !== s.a || b !== s.b) {
      let blk = text.slice(s.span![0], s.span![1]);
      blk = blk.replace(new RegExp(`\\(start ${NUM} ${NUM}\\)`), `(start ${fmt(a[0])} ${fmt(a[1])})`);
      blk = blk.replace(new RegExp(`\\(end ${NUM} ${NUM}\\)`), `(end ${fmt(b[0])} ${fmt(b[1])})`);
      rep.push([s.span!, blk]);
    }
  }
  rep.sort((x, y) => x[0][0] - y[0][0] || x[0][1] - y[0][1]);
  const out: string[] = [];
  let last = 0;
  for (const [[s0, s1], blk] of rep) {
    out.push(text.slice(last, s0), blk);
    last = s1;
  }
  out.push(text.slice(last));
  return out.join("");
}

export interface PassResult {
  text: string;
  rep: Record<string, unknown>;
}

/** Bring P/N via transitions to pair pitch (viaOptions), DRC-guarded per transition: a refused option falls to the next. */
export async function viasPass(text: string, pairs: readonly PairSpec[], ctx: PassCtx): Promise<PassResult> {
  const segs = readSegments(text);
  const vias = readVias(text);
  const model = parseBoard(text);
  const grid = new SoftGrid(segs, model.pads, model.vias, ctx.stack);
  let work: ViaWork[] = [];
  for (const pr of pairs) work.push(...viaOptions(segs, vias, pr, grid, ctx.stack));
  const rounds: Array<Record<string, unknown>> = [];
  const rep: Record<string, unknown> = { transitions: work.length, rounds };
  let newText = text;
  let broke = false;
  for (let rnd = 1; rnd <= ctx.rounds; rnd++) {
    const act = work.filter((w) => w.i < w.opts.length);
    if (!act.length) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      broke = true;
      break;
    }
    const chosen = act.flatMap((w) => w.opts[w.i]!.moves);
    newText = writeVias(text, segs, chosen);
    await writeFile(ctx.boardFile, newText);
    const fresh = await newItems(ctx, `vias${rnd}.drc.json`);
    const bad = new Set<string>();
    for (const v of fresh)
      for (const i of v.items) {
        const q: Pt | null = i.pos ? [i.pos.x, i.pos.y] : null;
        for (const w of act) {
          const moves = w.opts[w.i]!.moves;
          for (const { v: vv, q: nq } of moves) if (i.uuid === vv.uuid || (q && norm(sub(q, nq)) < 1.0)) bad.add(w.key);
          if ((i.description ?? "").includes(w.pair) && q && moves.some(({ q: nq }) => norm(sub(q, nq)) < 2.0)) bad.add(w.key);
        }
      }
    rounds.push({ round: rnd, active: act.length, new_items: fresh.length });
    say(ctx, `vias round ${rnd}: transitions ${act.length}  new DRC ${fresh.length}`);
    if (!fresh.length) {
      broke = true;
      break;
    }
    if (!bad.size) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      work = [];
      broke = true;
      break;
    }
    for (const w of work) if (bad.has(w.key)) w.i++;
  }
  if (!broke) {
    newText = text;
    await writeFile(ctx.boardFile, text);
    work = [];
  }
  rep["applied"] = work.filter((w) => w.i < w.opts.length).map((w) => ({ pair: w.pair, d: w.d, pitch: w.pitch, mode: w.opts[w.i]!.mode }));
  rep["refused"] = work.filter((w) => w.i >= w.opts.length).map((w) => w.pair);
  return { text: newText, rep };
}

// ---------------------------------------------------------------- mirror

export interface NetChain {
  layer: string;
  segs: PSeg[];
  verts: Pt[];
}

type K = { s: string; x: number; y: number; L: string };

/** Paths of one net's segments between fixed vertices (pad, via, T or end), per layer. */
export function netChains(segs: readonly PSeg[], pads: readonly Pad[], vias: readonly Via[], net: string, stack: readonly string[]): NetChain[] {
  const S = segs.filter((s) => s.net === net);
  const key = (e: Pt, L: string): K => {
    const x = r3(e[0]);
    const y = r3(e[1]);
    return { s: `${x}|${y}|${L}`, x, y, L };
  };
  const deg = new Map<string, number>();
  for (const s of S) for (const e of [s.a, s.b]) deg.set(key(e, s.layer).s, (deg.get(key(e, s.layer).s) ?? 0) + 1);
  const vv = vias.filter((v) => v.net === net);
  const pp = pads.filter((q) => q.net === net);
  const fixed = (k: K) =>
    (deg.get(k.s) ?? 0) !== 2 || vv.some((v) => norm(sub([k.x, k.y], [v.x, v.y])) <= v.size / 2) || pp.some((q) => padLayers(q, stack).includes(k.L) && norm(sub([k.x, k.y], [q.x, q.y])) <= q.r);
  const adj = new Map<string, { k: K; segs: PSeg[] }>();
  const put = (k: K, s: PSeg) => (adj.get(k.s) ?? adj.set(k.s, { k, segs: [] }).get(k.s)!).segs.push(s);
  for (const s of S) {
    put(key(s.a, s.layer), s);
    put(key(s.b, s.layer), s);
  }
  const seen = new Set<string>();
  const out: NetChain[] = [];
  for (const { k, segs: at } of [...adj.values()]) {
    if (!fixed(k)) continue;
    for (const s0 of at) {
      if (seen.has(s0.uuid)) continue;
      let cur = k;
      let seg = s0;
      const order: PSeg[] = [];
      const verts: Pt[] = [[k.x, k.y]];
      for (;;) {
        seen.add(seg.uuid);
        order.push(seg);
        const o = key(seg.a, seg.layer).s === cur.s ? seg.b : seg.a;
        cur = key(o, seg.layer);
        verts.push(o);
        if (fixed(cur)) break;
        const nx = adj.get(cur.s)!.segs.filter((x) => !seen.has(x.uuid));
        if (!nx.length) break;
        seg = nx[0]!;
      }
      out.push({ layer: s0.layer, segs: order, verts });
    }
  }
  return out;
}

/** Polyline offset by d to its left (mitred), collinear points merged. */
export function offsetPoly(vs: readonly Pt[], d: number): Pt[] {
  const pts: Pt[] = [vs[0]!];
  for (const q of vs.slice(1)) if (norm(sub(q, pts[pts.length - 1]!)) > 1e-6) pts.push(q);
  const keep: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) if (Math.abs(cross2(unit(sub(pts[i]!, keep[keep.length - 1]!)), unit(sub(pts[i + 1]!, pts[i]!)))) > 1e-6) keep.push(pts[i]!);
  keep.push(pts[pts.length - 1]!);
  const nrm: Pt[] = pairsOf(keep).map(([a, b]) => [-unit(sub(b, a))[1], unit(sub(b, a))[0]]);
  const out: Pt[] = [add(keep[0]!, mul(nrm[0]!, d))];
  for (let i = 1; i < keep.length - 1; i++) {
    const a0 = add(keep[i - 1]!, mul(nrm[i - 1]!, d));
    const d0 = unit(sub(keep[i]!, keep[i - 1]!));
    const a1 = add(keep[i]!, mul(nrm[i]!, d));
    const d1 = unit(sub(keep[i + 1]!, keep[i]!));
    const c = cross2(d0, d1);
    out.push(Math.abs(c) > 1e-9 ? add(a0, mul(d0, cross2(sub(a1, a0), d1) / c)) : add(keep[i]!, mul(nrm[i]!, d)));
  }
  out.push(add(keep[keep.length - 1]!, mul(nrm[nrm.length - 1]!, d)));
  return out;
}

/** (position along the polyline, point) of the nearest point to q. */
export function project(poly: readonly Pt[], q: Pt): [number, Pt] {
  let best: [number, number, Pt] = [9e9, 0.0, poly[0]!];
  let acc = 0.0;
  for (const [a, b] of pairsOf(poly)) {
    const ab = sub(b, a);
    const L = norm(ab);
    const u = L > 1e-12 ? Math.max(0.0, Math.min(1.0, dot(sub(q, a), ab) / (L * L))) : 0.0;
    const pnt = add(a, mul(ab, u));
    const dd = norm(sub(q, pnt));
    if (dd < best[0]) best = [dd, acc + u * L, pnt];
    acc += L;
  }
  return [best[1], best[2]];
}

export function cutPoly(poly: readonly Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  let acc = 0.0;
  for (const [a, b] of pairsOf(poly)) {
    const L = norm(sub(b, a));
    if (acc + L >= s0 && acc <= s1 && L > 1e-12) {
      const u0 = Math.max(0.0, (s0 - acc) / L);
      const u1 = Math.min(1.0, (s1 - acc) / L);
      const p0 = add(a, mul(sub(b, a), u0));
      const p1 = add(a, mul(sub(b, a), u1));
      if (!out.length) out.push(p0);
      out.push(p1);
    }
    acc += L;
  }
  return out;
}

export interface MirrorWork {
  key: string;
  pair: string;
  opts: Array<{ segs: PSeg[]; verts: Pt[]; follower: string }>;
  layer: string;
  len: number;
  i: number;
}

/** Python's str() of a float from round(x, 1). */
const pyStr = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/**
 * Chains of P and N on one layer between the same two end areas (both ends within 1.6 mm), >= 1 mm, under 80 % coupled:
 * rebuild one member as the other's path offset by the class centre spacing, joined to its own ends.
 */
export function mirrorOptions(segs: readonly PSeg[], pads: readonly Pad[], vias: readonly Via[], pr: PairSpec, grid: SoftGrid, stack: readonly string[], why: string[] | null = null, soft: ReadonlySet<string> = EMPTY): MirrorWork[] {
  const D = pr.w + pr.gap + 0.002;
  const cp = netChains(segs, pads, vias, pr.p, stack);
  const cn = netChains(segs, pads, vias, pr.n, stack);
  const nets = new Set([pr.p, pr.n]);
  const used = new Set<number>();
  const out: MirrorWork[] = [];
  const sorted = cp.map((c) => ({ c, l: plen(c.verts) })).sort((x, y) => y.l - x.l);
  for (const { c: pc } of sorted) {
    const { layer: L, segs: ps, verts: pv } = pc;
    if (plen(pv) < 1.0) continue;
    let best: [number, number, PSeg[], Pt[]] | null = null;
    for (let jj = 0; jj < cn.length; jj++) {
      const { layer: L2, segs: ns, verts: nv } = cn[jj]!;
      if (L2 !== L || used.has(jj) || plen(nv) < 0.5) continue;
      for (const nvv of [nv, [...nv].reverse()]) {
        const e = norm(sub(pv[0]!, nvv[0]!)) + norm(sub(pv[pv.length - 1]!, nvv[nvv.length - 1]!));
        if (norm(sub(pv[0]!, nvv[0]!)) < 1.6 && norm(sub(pv[pv.length - 1]!, nvv[nvv.length - 1]!)) < 1.6 && (best === null || e < best[0])) best = [e, jj, ns, nvv];
      }
    }
    if (!best) continue;
    const [, j, ns, nv] = best;
    let k = 0;
    let got = 0;
    const nsegs = pairsOf(nv);
    for (const [a, b] of pairsOf(pv)) {
      const n_ = Math.max(1, Math.trunc(norm(sub(b, a)) / 0.1));
      for (let i = 0; i < n_; i++) {
        const q = add(a, mul(sub(b, a), (i + 0.5) / n_));
        k++;
        if (Math.min(...nsegs.map(([x, y]) => segDist(q, x, y))) <= D * 1.25) got++;
      }
    }
    if (k && got / k >= 0.8) continue;
    used.add(j);
    const opts: MirrorWork["opts"] = [];
    const tag = `${pr.p} ${L} ${pyStr(pyRound(plen(pv), 1))} mm`;
    for (const [lead, lv, fol, fv, fnet] of [[pr.p, pv, ns, nv, pr.n], [pr.n, nv, ps, pv, pr.p]] as const) {
      const sides: number[] = [];
      for (const [[a, b], q] of [[[lv[0]!, lv[1]!], fv[0]!], [[lv[lv.length - 2]!, lv[lv.length - 1]!], fv[fv.length - 1]!]] as const) sides.push(copysign1(cross2(unit(sub(b, a)), sub(q, a))));
      if (sides[0] !== sides[1]) {
        why?.push(`${tag}: follower ${fnet} crosses the leader`);
        continue;
      }
      const off = offsetPoly(lv, sides[0]! * D);
      let [s0] = project(off, fv[0]!);
      let [s1] = project(off, fv[fv.length - 1]!);
      const obst: Array<[Pt, number]> = [
        ...vias.filter((v) => v.net === lead).map((v): [Pt, number] => [[v.x, v.y], v.size / 2]),
        ...pads.filter((q) => q.net === lead && padLayers(q, stack).includes(L)).map((q): [Pt, number] => [[q.x, q.y], q.r]),
      ];
      const R0 = pr.w / 2 + pr.gap + 0.01;
      const badAt = (s: number) => {
        const c = cutPoly(off, s, s + 1e-6);
        return c.length ? obst.some(([cc, r]) => norm(sub(c[0]!, cc)) < r + R0) : true;
      };
      while (s0 < s1 && badAt(s0)) s0 += 0.05;
      while (s1 > s0 && badAt(s1)) s1 -= 0.05;
      if (s1 - s0 < 0.3) {
        why?.push(`${tag}: follower ${fnet}: offset path too short after clearing the leader vias/pads`);
        continue;
      }
      const body = cutPoly(off, s0, s1);
      const verts: Pt[] = [fv[0]!, ...body, fv[fv.length - 1]!];
      let reason: string | null = null;
      const ownEnd = [
        ...vias.filter((v) => v.net === fnet).map((v): [Pt, number] => [[v.x, v.y], v.size / 2]),
        ...pads.filter((q) => q.net === fnet && padLayers(q, stack).includes(L)).map((q): [Pt, number] => [[q.x, q.y], q.r]),
      ].filter(([c, r]) => Math.min(norm(sub(c, verts[0]!)), norm(sub(c, verts[verts.length - 1]!))) <= r + 1e-3);
      for (const [a, b] of pairsOf(verts))
        for (let i = 0; i < 7; i++) {
          const q = add(a, mul(sub(b, a), i / 6));
          if (ownEnd.some(([c, r]) => norm(sub(q, c)) <= r)) continue;
          if (!grid.clear(L, q, pr.w / 2 + 0.2, nets, soft)) reason ??= `other copper at (${q[0].toFixed(2)}, ${q[1].toFixed(2)})`;
        }
      const lsegs = pairsOf(lv);
      for (const [a, b] of [[verts[0]!, verts[1]!], [verts[verts.length - 2]!, verts[verts.length - 1]!]] as const)
        for (let i = 1; i < 7; i++) {
          const q = add(a, mul(sub(b, a), i / 7));
          if (obst.some(([c, r]) => norm(sub(q, c)) < r + R0)) reason ??= `join at (${q[0].toFixed(2)}, ${q[1].toFixed(2)}) too close to a leader via/pad`;
          if (Math.min(...lsegs.map(([x, y]) => segDist(q, x, y))) < pr.w + pr.gap - 0.003) reason ??= `join at (${q[0].toFixed(2)}, ${q[1].toFixed(2)}) too close to the leader track`;
        }
      if (!reason) opts.push({ segs: fol, verts, follower: fnet });
      else why?.push(`${tag}: follower ${fnet}: ${reason}`);
    }
    if (opts.length) out.push({ key: "m:" + ps[0]!.uuid.slice(0, 8), pair: pr.p, opts, layer: L, len: pyRound(plen(pv), 2), i: 0 });
  }
  return out;
}

/** Signal nets whose tracks a forced pair path may displace: not ground, not a power class (PWR*), not a pair. */
export function softNets(segs: readonly PSeg[], pairNets: ReadonlySet<string>, req: Requirements, ground: string): Set<string> {
  const power = new Set<string>();
  for (const [k, c] of Object.entries(req.acceptance.net_classes.classes)) if (k.startsWith("PWR")) for (const n of c.nets ?? []) power.add(n);
  const out = new Set<string>();
  for (const s of segs) if (s.net && !power.has(s.net) && s.net !== ground && !pairNets.has(s.net)) out.add(s.net);
  return out;
}

export interface NewChain {
  segs: PSeg[];
  new: { verts: Pt[] };
  key: string;
}

/**
 * Plane-only vias within keep + radius (+ 0.08) of a new pair path go to the nearest free spot within 1.5 mm (clear of the
 * new paths and pair tracks by keep, of other copper by 0.2 mm). Quirks kept: the moved-via obstacles take the size, net and
 * layers of the via being placed, and vias already moved still stand at their old spot too.
 */
export function shoveVias(text: string, chains: readonly NewChain[], movable: readonly RVia[], owner: Map<string, string>, req: Requirements, stack: readonly string[], keep = 0.5): { moved: Map<string, Pt>; refuse: Set<string> } {
  const segs = readSegments(text);
  const model = parseBoard(text);
  const pairNets = new Set(classesAndPairs(req, null).flatMap((pr) => [pr.p, pr.n]));
  const paths = chains.map((c) => ({ key: c.key, ss: pairsOf(c.new.verts) }));
  const pairSegs = segs.filter((s) => pairNets.has(s.net)).map((s) => [s.a, s.b, s.w] as const);
  const nonPair = segs.filter((s) => !pairNets.has(s.net));
  const moved = new Map<string, Pt>();
  const refuse = new Set<string>();
  for (const v of movable) {
    const r = v.size / 2;
    const hit = paths.filter(({ ss }) => ss.some(([a, b]) => segDist(v.xy, a, b) < keep + r + 0.08)).map((p) => p.key);
    if (!hit.length) continue;
    const others = model.vias.filter((x) => norm(sub([x.x, x.y], v.xy)) > 1e-4);
    const lay: [string, string] = [v.layers[0] ?? stack[0]!, v.layers[1] ?? stack[stack.length - 1]!];
    const grid = new SoftGrid(nonPair, model.pads, [...others, ...[...moved.values()].map((q) => ({ x: q[0], y: q[1], size: v.size, net: v.net ?? "", layers: lay }))], stack);
    const own = new Set([v.net ?? ""]);
    let spot: Pt | null = null;
    for (let kr = 1; kr < 16 && !spot; kr++) {
      const rad = 0.1 * kr;
      for (let k = 0; k < 16; k++) {
        const q = add(v.xy, [rad * Math.cos((k * Math.PI) / 8), rad * Math.sin((k * Math.PI) / 8)]);
        if (
          pairSegs.every(([a, b, w]) => segDist(q, a, b) >= keep + r + w / 2 + 0.01) &&
          paths.every(({ ss }) => ss.every(([a, b]) => segDist(q, a, b) >= keep + r + 0.08)) &&
          stack.every((L) => grid.clear(L, q, r + 0.2, own))
        ) {
          spot = q;
          break;
        }
      }
    }
    if (spot) {
      moved.set(v.uuid, spot);
      owner.set(v.uuid, hit[0]!);
    } else for (const h of hit) refuse.add(h);
  }
  return { moved, refuse };
}

/** One member rebuilt as the other's offset path (mirrorOptions), DRC-guarded per chain pair. */
export async function mirrorPass(text: string, pairs: readonly PairSpec[], ctx: PassCtx, force = false): Promise<PassResult> {
  const segs = readSegments(text);
  const model = parseBoard(text);
  const { pads, vias } = model;
  const grid = new SoftGrid(segs, pads, vias, ctx.stack);
  const why: string[] = [];
  const allPairs = new Set(classesAndPairs(ctx.req, null).flatMap((pr) => [pr.p, pr.n]));
  const soft: Set<string> = force ? softNets(segs, allPairs, ctx.req, ctx.ground) : new Set();
  const movable: RVia[] = [];
  if (force)
    for (const v of readVias(text))
      if (v.net === ctx.ground && !segs.some((s) => s.net === ctx.ground && Math.min(norm(sub(s.a, v.xy)), norm(sub(s.b, v.xy))) <= v.size / 2)) {
        movable.push(v);
        soft.add(viaKey(v.xy));
      }
  let work: MirrorWork[] = [];
  for (const pr of pairs) work.push(...mirrorOptions(segs, pads, vias, pr, grid, ctx.stack, why, soft));
  const rounds: Array<Record<string, unknown>> = [];
  const rep: Record<string, unknown> = { chain_pairs: work.length, rounds, skipped: why };
  let newText = text;
  let broke = false;
  for (let rnd = 1; rnd <= ctx.rounds; rnd++) {
    const act = work.filter((w) => w.i < w.opts.length);
    if (!act.length) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      broke = true;
      break;
    }
    const chains: NewChain[] = act.map((w) => ({ segs: w.opts[w.i]!.segs, new: { verts: w.opts[w.i]!.verts }, key: w.key }));
    let owner: Map<string, string>;
    ({ text: newText, owner } = writeRetune(text, chains, new Set(chains.map((c) => c.key))));
    if (movable.length) {
      const { moved, refuse } = shoveVias(newText, chains, movable, owner, ctx.req, ctx.stack);
      rep["vias_moved"] = moved.size;
      if (refuse.size) {
        for (const w of work) if (refuse.has(w.key)) w.i++;
        rounds.push({ round: rnd, no_room_for_vias: [...refuse].sort() });
        continue;
      }
      const vt = readVias(newText);
      const subs: Array<[[number, number], string]> = [];
      for (const [u, q] of moved) {
        const v = vt.find((x) => x.uuid === u)!;
        subs.push([v.span, newText.slice(v.span[0], v.span[1]).replace(new RegExp(`\\(at ${NUM} ${NUM}\\)`), `(at ${fmt(q[0])} ${fmt(q[1])})`)]);
      }
      subs.sort((x, y) => x[0][0] - y[0][0]);
      const parts: string[] = [];
      let last = 0;
      for (const [[s0, s1], blk] of subs) {
        parts.push(newText.slice(last, s0), blk);
        last = s1;
      }
      newText = parts.join("") + newText.slice(last);
    }
    await writeFile(ctx.boardFile, newText);
    let fresh = await newItems(ctx, `mirror${rnd}.drc.json`);
    if (force) {
      // displaced signal tracks are left for the repair step; only other conflicts refuse
      const disp = (i: Item["items"][number]) => {
        const m = /^Track \[([^\]]*)\]/.exec(i.description ?? "");
        return !!m && soft.has(m[1]!);
      };
      const keepItems = fresh.filter((v) => !(["clearance", "tracks_crossing", "shorting_items"].includes(v.type) && v.items.some(disp) && v.items.every((i) => owner.has(i.uuid ?? "\0") || disp(i))));
      rep["displaced"] = fresh.length - keepItems.length;
      fresh = keepItems;
    }
    const bad = new Set<string>();
    for (const v of fresh) {
      let hit = new Set(v.items.filter((i) => i.uuid !== undefined && owner.has(i.uuid)).map((i) => owner.get(i.uuid!)!));
      if (!hit.size) hit = byPos(v.items, chains);
      for (const h of hit) bad.add(h);
    }
    rounds.push({ round: rnd, active: act.length, new_items: fresh.length });
    say(ctx, `mirror round ${rnd}: chain pairs ${act.length}  new DRC ${fresh.length}`);
    if (!fresh.length) {
      broke = true;
      break;
    }
    if (!bad.size) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      work = [];
      broke = true;
      break;
    }
    for (const w of work) if (bad.has(w.key)) w.i++;
  }
  if (!broke) {
    newText = text;
    await writeFile(ctx.boardFile, text);
    work = [];
  }
  rep["applied"] = work.filter((w) => w.i < w.opts.length).map((w) => ({ pair: w.pair, layer: w.layer, len: w.len, follower: w.opts[w.i]!.follower }));
  rep["refused"] = work.filter((w) => w.i >= w.opts.length).map((w) => w.pair);
  return { text: newText, rep };
}

// ---------------------------------------------------------------- retune

export interface Retuned {
  verts: Pt[];
  extra: number;
  bumps: number;
  h: number;
  L_old: number;
  L_new: number;
}

export interface TuneChain {
  member: string;
  segs: PSeg[];
  verts: Pt[];
  partner: PSeg;
  side: number;
  D: number;
  w: number;
  key: string;
  new?: Retuned | null;
}

/**
 * One-sided length-tune wiggles: a path of one member's segments (>= 4 not parallel to the partner) beside one straight
 * partner segment (>= 2 mm), all its vertices within 1.6 mm on one side. The walk starts at the path end met first
 * (the oracle takes the first of a Python set, which varies per process: same geometry, reversed vertex order).
 */
export function tuneChains(segs: readonly PSeg[], pads: readonly Pad[], vias: readonly Via[], pr: PairSpec): TuneChain[] {
  const D = pr.w + pr.gap + 0.002;
  const out: TuneChain[] = [];
  const padv: Array<[string, Pt, number]> = [...pads.map((o): [string, Pt, number] => [o.net, [o.x, o.y], o.r]), ...vias.map((v): [string, Pt, number] => [v.net, [v.x, v.y], v.size / 2])];
  const key = (e: Pt, L: string): K => {
    const x = r4(e[0]);
    const y = r4(e[1]);
    return { s: `${x}|${y}|${L}`, x, y, L };
  };
  for (const [me, mate] of [[pr.p, pr.n], [pr.n, pr.p]] as const) {
    const mine = segs.filter((s) => s.net === me);
    const deg = new Map<string, number>();
    for (const s of mine) for (const e of [s.a, s.b]) deg.set(key(e, s.layer).s, (deg.get(key(e, s.layer).s) ?? 0) + 1);
    const used = new Set<string>();
    const partners = segs.filter((x) => x.net === mate).map((t) => ({ t, l: slen(t) })).sort((x, y) => y.l - x.l);
    for (const { t } of partners) {
      const Lt = slen(t);
      if (Lt < 2) continue;
      const ut = unit(sub(t.b, t.a));
      const nt: Pt = [-ut[1], ut[0]];
      const inband = (v: Pt) => {
        const a = dot(sub(v, t.a), ut);
        const o = dot(sub(v, t.a), nt);
        return a >= 0 && a <= Lt && Math.abs(o) > 0 && Math.abs(o) <= 1.6;
      };
      const cand = mine.filter((s) => s.layer === t.layer && !used.has(s.uuid) && inband(s.a) && inband(s.b));
      if (cand.length < 4) continue;
      const adj = new Map<string, PSeg[]>();
      for (const s of cand) for (const e of [s.a, s.b]) (adj.get(key(e, s.layer).s) ?? adj.set(key(e, s.layer).s, []).get(key(e, s.layer).s)!).push(s);
      const seen = new Set<string>();
      for (const s0 of cand) {
        if (seen.has(s0.uuid)) continue;
        const comp: PSeg[] = [];
        const st: PSeg[] = [s0];
        while (st.length) {
          const s = st.pop()!;
          if (seen.has(s.uuid)) continue;
          seen.add(s.uuid);
          comp.push(s);
          for (const e of [s.a, s.b]) {
            const k = key(e, s.layer).s;
            if (deg.get(k) === 2 && !padv.some(([n, c, r]) => n === me && norm(sub(e, c)) <= r + 1e-3)) st.push(...adj.get(k)!.filter((x) => !seen.has(x.uuid)));
          }
        }
        const sides = new Set(comp.flatMap((s) => [s.a, s.b]).map((v) => copysign1(dot(sub(v, t.a), nt))));
        const wig = comp.filter((s) => Math.abs(cross2(unit(sub(s.b, s.a)), ut)) > 0.15);
        if (sides.size !== 1 || wig.length < 4) continue;
        const cnt = new Map<string, { k: K; n: number }>();
        for (const s of comp) for (const e of [s.a, s.b]) {
          const k = key(e, s.layer);
          (cnt.get(k.s) ?? cnt.set(k.s, { k, n: 0 }).get(k.s)!).n++;
        }
        const ends = [...cnt.values()].filter((x) => x.n === 1).map((x) => x.k);
        if (ends.length !== 2) continue;
        let cur = ends[0]!;
        let prev: PSeg | null = null;
        const verts: Pt[] = [[cur.x, cur.y]];
        const order: PSeg[] = [];
        const inComp = new Set(comp);
        for (;;) {
          const nxt = adj.get(cur.s)!.filter((s) => inComp.has(s) && s !== prev);
          if (!nxt.length) break;
          const s = nxt[0]!;
          order.push(s);
          const other = key(s.a, s.layer).s === cur.s ? s.b : s.a;
          cur = key(other, s.layer);
          prev = s;
          verts.push([cur.x, cur.y]);
          if (cur.s === ends[1]!.s) break;
        }
        if (order.length !== comp.length) continue;
        for (const s of comp) used.add(s.uuid);
        out.push({ member: me, segs: order, verts, partner: t, side: [...sides][0]!, D, w: pr.w, key: "r:" + order[0]!.uuid.slice(0, 8) });
      }
    }
  }
  return out;
}

/** New vertices for a chain: 45 degree jogs to the class spacing beside the partner, the removed length put back as square bumps away from the partner, no higher than the old wiggle (and 0.5 mm). Same length; null if it cannot fit. */
export function retunePath(ch: TuneChain, pitch?: number): Retuned | null {
  const t = ch.partner;
  const ut = unit(sub(t.b, t.a));
  const nt = mul([-ut[1], ut[0]], ch.side);
  const S = ch.verts[0]!;
  const E = ch.verts[ch.verts.length - 1]!;
  const along = (v: Pt) => dot(sub(v, t.a), ut);
  const off = (v: Pt) => dot(sub(v, t.a), nt);
  const sS = along(S);
  const sE = along(E);
  const dirn = sE >= sS ? 1 : -1;
  const D = ch.D;
  const pt = (s: number, o: number) => add(add(t.a, mul(ut, s)), mul(nt, o));
  const jS = Math.abs(off(S) - D);
  const jE = Math.abs(off(E) - D);
  const S2 = pt(sS + dirn * jS, D);
  const E2 = pt(sE - dirn * jE, D);
  const run = (sE - sS) * dirn - jS - jE;
  const Lold = plen(ch.verts);
  const Lbase = norm(sub(S2, S)) + run + norm(sub(E, E2));
  const extra = Lold - Lbase;
  if (run < 0.3) return null;
  const hmax = Math.min(Math.max(...ch.verts.map(off)) - D, 0.5);
  const p = pitch || Math.max(2.5 * ch.w, 0.3);
  let bumps: number;
  let h: number;
  if (extra < 0.01) {
    bumps = 0;
    h = 0;
  } else {
    if (hmax < 0.05) return null;
    const n = Math.ceil(extra / (2 * hmax));
    h = extra / (2 * n);
    bumps = n;
  }
  const need = bumps * 2 * p;
  if (need > run - 0.1) return null;
  const vs: Pt[] = [S, ...(jS > 1e-4 ? [S2] : [])];
  const s0 = sS + dirn * (jS + (run - need) / 2);
  for (let i = 0; i < bumps; i++) {
    const a = s0 + dirn * (2 * i * p + p / 2);
    vs.push(pt(a, D), pt(a, D + h), pt(a + dirn * p, D + h), pt(a + dirn * p, D));
  }
  vs.push(...(jE > 1e-4 ? [E2] : []), E);
  return { verts: vs, extra: pyRound(extra, 3), bumps, h: pyRound(h, 3), L_old: pyRound(Lold, 3), L_new: pyRound(plen(vs), 3) };
}

/** Board text with the active chains replaced (old segments removed, new ones appended). -> text, {new uuid: chain key}. */
export function writeRetune(text: string, chains: readonly NewChain[], active: ReadonlySet<string>): { text: string; owner: Map<string, string> } {
  const added: Array<{ uuid: string; key: string; txt: string }> = [];
  for (const ch of chains) {
    if (!active.has(ch.key)) continue;
    const s0 = ch.segs[0]!;
    pairsOf(ch.new.verts).forEach(([a, b], i) => {
      if (norm(sub(b, a)) < 1e-4) return;
      const u = uuid5url(`pairfix-retune:${s0.uuid}:${i}`);
      added.push({
        uuid: u,
        key: ch.key,
        txt: `\t(segment\n\t\t(start ${fmt(a[0])} ${fmt(a[1])})\n\t\t(end ${fmt(b[0])} ${fmt(b[1])})\n\t\t(width ${fmt(s0.w)})\n\t\t(layer "${s0.layer}")\n\t\t(net ${s0.net_raw})\n\t\t(uuid "${u}")\n\t)`,
      });
    });
  }
  const parts: string[] = [];
  let last = 0;
  const gone = chains.filter((ch) => active.has(ch.key)).flatMap((ch) => ch.segs).sort((x, y) => x.span![0] - y.span![0]);
  for (const s of gone) {
    const st = text.lastIndexOf("\n", s.span![0] - 1); // the whole line block, indentation included
    parts.push(text.slice(last, st));
    last = s.span![1];
  }
  parts.push(text.slice(last));
  let t = parts.join("");
  if (added.length) {
    const i = t.trimEnd().lastIndexOf(")");
    t = t.slice(0, i).trimEnd() + "\n" + added.map((n) => n.txt).join("\n") + "\n)\n";
  }
  return { text: t, owner: new Map(added.map((n) => [n.uuid, n.key])) };
}

/** Straighten one-sided wiggles (tuneChains) into compact bumps, DRC-guarded per chain. */
export async function retunePass(text: string, pairs: readonly PairSpec[], ctx: PassCtx): Promise<PassResult> {
  const segs = readSegments(text);
  const model = parseBoard(text);
  const chains: Array<TuneChain & { new: Retuned }> = [];
  for (const pr of pairs)
    for (const ch of tuneChains(segs, model.pads, model.vias, pr)) {
      const n = retunePath(ch);
      if (n) chains.push({ ...ch, new: n });
    }
  let active = new Set(chains.map((c) => c.key));
  const rounds: Array<Record<string, unknown>> = [];
  const rep: Record<string, unknown> = { chains: chains.length, rounds };
  let newText = text;
  let broke = false;
  for (let rnd = 1; rnd <= ctx.rounds; rnd++) {
    if (!active.size) {
      newText = text; // the oracle leaves the board file as the last round wrote it here
      broke = true;
      break;
    }
    let owner: Map<string, string>;
    ({ text: newText, owner } = writeRetune(text, chains, active));
    await writeFile(ctx.boardFile, newText);
    const t0 = Date.now();
    const fresh = await newItems(ctx, `retune${rnd}.drc.json`);
    const bad = new Set<string>();
    for (const v of fresh) {
      let hit = new Set(v.items.filter((i) => i.uuid !== undefined && owner.has(i.uuid)).map((i) => owner.get(i.uuid!)!));
      if (!hit.size) hit = byPos(v.items, chains.filter((c) => active.has(c.key)));
      for (const h of hit) bad.add(h);
    }
    rounds.push({ round: rnd, active: active.size, new_items: fresh.length, drc_s: Math.round((Date.now() - t0) / 100) / 10 });
    say(ctx, `retune round ${rnd}: chains ${active.size}  new DRC ${fresh.length}`);
    if (!fresh.length) {
      broke = true;
      break;
    }
    if (!bad.size) {
      active = new Set();
      newText = text;
      await writeFile(ctx.boardFile, text);
      broke = true;
      break;
    }
    active = new Set([...active].filter((k) => !bad.has(k)));
  }
  if (!broke) {
    active = new Set();
    newText = text;
    await writeFile(ctx.boardFile, text);
  }
  rep["applied"] = chains.filter((c) => active.has(c.key)).map((c) => ({ member: c.member, layer: c.segs[0]!.layer, extra: c.new.extra, bumps: c.new.bumps, h: c.new.h, L_old: c.new.L_old, L_new: c.new.L_new }));
  rep["refused"] = chains.filter((c) => !active.has(c.key)).map((c) => c.member);
  return { text: newText, rep };
}

// ---------------------------------------------------------------- skew

export function bumpVerts(s: Segment, side: Pt, nb: number, h: number, pitch: number): { verts: Pt[]; bumps: Array<[Pt, Pt, Pt, Pt]> } {
  const L = slen(s);
  const u = unit(sub(s.b, s.a));
  const s0 = (L - nb * 2 * pitch) / 2 + pitch / 2;
  const vs: Pt[] = [s.a];
  const bumps: Array<[Pt, Pt, Pt, Pt]> = [];
  for (let i = 0; i < nb; i++) {
    const b0 = add(s.a, mul(u, s0 + 2 * i * pitch));
    const b1 = add(b0, mul(side, h));
    const b3 = add(b0, mul(u, pitch));
    const b2 = add(b3, mul(side, h));
    vs.push(b0, b1, b2, b3);
    bumps.push([b0, b1, b2, b3]);
  }
  vs.push(s.b);
  return { verts: vs, bumps };
}

export interface SkewPlanned {
  seg: PSeg;
  verts: Pt[];
  bumps: number;
  h: number;
  coupled: boolean;
}

/**
 * Bumps on the shorter member spread over as many straight segments as it takes, away from the partner, uncoupled segments
 * first, then the longest; each bump's surroundings checked free of other-net copper. A coupled segment is used only when
 * the coupling it costs keeps the pair's share (A8 samples P) above the class minimum. -> (plan, mm placed).
 */
export function skewPlan(segs: readonly PSeg[], pr: PairSpec, grid: SoftGrid, extra: number, banned: ReadonlySet<string>, cov: [number, number, number, number] | null = null): [SkewPlanned[], number] {
  let Lp = 0;
  let Ln = 0;
  for (const s of segs) if (s.net === pr.p) Lp += slen(s);
  for (const s of segs) if (s.net === pr.n) Ln += slen(s);
  const [short, other] = Lp < Ln ? [pr.p, pr.n] : [pr.n, pr.p];
  const w = pr.w;
  const pitch = Math.max(2.5 * w, 0.3);
  const mates = segs.filter((s) => s.net === other);
  const cands: Array<{ coupled: boolean; negL: number; s: PSeg; sides: Pt[] }> = [];
  for (const s of segs) {
    if (s.net !== short || banned.has(s.uuid)) continue;
    const L = slen(s);
    const u = unit(sub(s.b, s.a));
    const n0: Pt = [-u[1], u[0]];
    if (L < 2 * pitch + 0.4) continue;
    const mid = mul(add(s.a, s.b), 0.5);
    const near = mates.filter((t) => t.layer === s.layer && segDist(mid, t.a, t.b) < 1.0);
    let sides: Pt[];
    if (near.length) {
      let t = near[0]!;
      for (const x of near) if (segDist(mid, x.a, x.b) < segDist(mid, t.a, t.b)) t = x;
      const ab = sub(t.b, t.a);
      const q = add(t.a, mul(ab, Math.max(0, Math.min(1, dot(sub(mid, t.a), ab) / Math.max(1e-9, dot(ab, ab))))));
      sides = [dot(sub(q, mid), n0) > 0 ? mul(n0, -1) : n0];
    } else sides = [n0, mul(n0, -1)];
    cands.push({ coupled: near.length > 0, negL: -L, s, sides });
  }
  cands.sort((x, y) => Number(x.coupled) - Number(y.coupled) || x.negL - y.negL);
  const plan: SkewPlanned[] = [];
  let left = extra;
  const [got, tot, need, applies] = cov ?? [0, 0, 0, 9e9];
  const nets = new Set([pr.p, pr.n]);
  for (const { coupled, negL, s, sides } of cands) {
    if (left <= 1e-3) break;
    const L = -negL;
    if (coupled && cov && tot >= applies) {
      const nbEst = Math.max(1, Math.ceil(Math.min(left, L) / (2 * 0.4)));
      const lost = nbEst * (pitch + (short === pr.p ? 2 * 0.4 : 2 * w));
      const now = got / tot;
      const after = (got - lost) / (tot + (short === pr.p ? Math.min(left, L) : 0));
      if (now >= need ? after < need + 0.03 : after < now - 0.04) continue;
    }
    const nmax = Math.floor((L - 0.4) / (2 * pitch));
    let done = false;
    for (const hmax of [0.4, 0.25, 0.15]) {
      if (done) break;
      const nb = Math.min(nmax, Math.ceil(left / (2 * hmax)));
      if (nb < 1) continue;
      const h = Math.min(hmax, left / (2 * nb));
      for (const side of sides) {
        const { verts, bumps } = bumpVerts(s, side, nb, h, pitch);
        let clear = true;
        outer: for (const [b0, b1, b2, b3] of bumps)
          for (const [p0, p1] of [[b0, b1], [b1, b2], [b3, b2]] as const)
            for (let k = 0; k < 5; k++)
              if (!grid.clear(s.layer, add(p0, mul(sub(p1, p0), k / 4)), 0.2 + w / 2, nets)) {
                clear = false;
                break outer;
              }
        if (clear) {
          plan.push({ seg: s, verts, bumps: nb, h: pyRound(h, 3), coupled });
          left -= 2 * nb * h;
          done = true;
          break;
        }
      }
    }
  }
  return [plan, pyRound(extra - left, 3)];
}

/** (coupled mm, total mm) of P as A8 counts it. */
export function measureOne(segs: readonly PSeg[], pr: PairSpec): [number, number] {
  const ps = segs.filter((s) => s.net === pr.p);
  const ns = segs.filter((s) => s.net === pr.n);
  let got = 0.0;
  let tot = 0.0;
  for (const s of ps) {
    const L = slen(s);
    const k = Math.max(1, Math.trunc(L / 0.1));
    const mates = ns.filter((x) => x.layer === s.layer);
    for (let i = 0; i < k; i++) {
      const q = add(s.a, mul(sub(s.b, s.a), (i + 0.5) / k));
      tot += L / k;
      if (mates.length && Math.min(...mates.map((x) => segDist(q, x.a, x.b))) <= pr.reach) got += L / k;
    }
  }
  return [got, tot];
}

/** Pairs over their class length-difference limit get bumps on the shorter member (skewPlan), DRC-guarded: segments named in a new DRC item are banned and the pair planned again. */
export async function skewPass(text: string, pairs: readonly PairSpec[], ctx: PassCtx, target = 0.1): Promise<PassResult> {
  const acc = ctx.req.acceptance.net_classes.classes;
  const segs = readSegments(text);
  const model = parseBoard(text);
  const grid = new SoftGrid(segs, model.pads, model.vias, ctx.stack);
  type W = { pair: string; pr: PairSpec; extra: number; banned: Set<string>; cov: [number, number, number, number]; plan?: SkewPlanned[]; placed?: number };
  let work: W[] = [];
  for (const pr of pairs) {
    let Lp = 0;
    let Ln = 0;
    for (const s of segs) if (s.net === pr.p) Lp += slen(s);
    for (const s of segs) if (s.net === pr.n) Ln += slen(s);
    const c = acc[pr.class] ?? {};
    if (Math.abs(Lp - Ln) > (c.intra_pair_skew_max_mm ?? 9e9)) {
      const m = measureOne(segs, pr);
      work.push({ pair: `${pr.p} / ${pr.n}`, pr, extra: pyRound(Math.abs(Lp - Ln) - target, 3), banned: new Set(), cov: [m[0], m[1], c.min_coupled_share ?? 0, c.coupling_applies_from_mm ?? 0] });
    }
  }
  const rounds: Array<Record<string, unknown>> = [];
  const rep: Record<string, unknown> = { pairs_over_limit: work.length, rounds };
  let newText = text;
  let broke = false;
  for (let rnd = 1; rnd <= ctx.rounds; rnd++) {
    const chains: NewChain[] = [];
    for (const w of work) {
      [w.plan, w.placed] = skewPlan(segs, w.pr, grid, w.extra, w.banned, w.cov);
      chains.push(...w.plan.map((x) => ({ segs: [x.seg], new: { verts: x.verts }, key: "k:" + x.seg.uuid })));
    }
    if (!chains.length) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      broke = true;
      break;
    }
    let owner: Map<string, string>;
    ({ text: newText, owner } = writeRetune(text, chains, new Set(chains.map((c) => c.key))));
    await writeFile(ctx.boardFile, newText);
    const fresh = await newItems(ctx, `skew${rnd}.drc.json`);
    const bad = new Set<string>();
    for (const v of fresh) {
      let hit = new Set(v.items.filter((i) => i.uuid !== undefined && owner.has(i.uuid)).map((i) => owner.get(i.uuid!)!));
      if (!hit.size) hit = byPos(v.items, chains);
      for (const h of hit) bad.add(h);
    }
    rounds.push({ round: rnd, segments: chains.length, new_items: fresh.length });
    say(ctx, `skew round ${rnd}: segments ${chains.length}  new DRC ${fresh.length}`);
    if (!fresh.length) {
      broke = true;
      break;
    }
    if (!bad.size) {
      newText = text;
      await writeFile(ctx.boardFile, text);
      work = [];
      broke = true;
      break;
    }
    for (const w of work) for (const k of bad) w.banned.add(k.slice(2));
  }
  if (!broke) {
    newText = text;
    await writeFile(ctx.boardFile, text);
    work = [];
  }
  rep["pairs"] = work.map((w) => ({ pair: w.pair, extra: w.extra, placed: w.placed ?? 0, segments: (w.plan ?? []).length, on_coupled: (w.plan ?? []).filter((x) => x.coupled).length, banned: w.banned.size }));
  return { text: newText, rep };
}

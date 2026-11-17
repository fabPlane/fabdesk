/**
 * Reference-based local copper edits (the toolkit's `flow/copper_plan.py`, line for line): a filled/capped F-B via at a
 * saved pad's centre, leaf pruning of named nets, and removal of named copper items by uuid. Never routes.
 *
 * Leaf pruning splits each straight track of the net at same-net physical junctions (crossings and track ends within
 * the joint width) before dropping unanchored ends, so a T-connected track keeps every branch that joins anchors; the
 * net's surviving tracks are written again as split pieces with fresh uuids. A via on a single conducting layer is
 * removed only when its tracks share an exact endpoint, so it cannot bridge a gap. Plane nets refuse signal pruning
 * (`prune_track_leaves` keeps their vias); arcs refuse.
 */
import { createHash, randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import { padOnLayer, readBoard, type Pad, type Segment, type Via } from "../board";
import { kid, kids, parseSexpr, splice, topLevelSpans } from "../sexpr";
import { crossPoint, interpolate, pointSegDist, project, segLen, type P } from "./geos";
import { EditStop } from "./sch";

export interface ViaAtPad {
  ref: string;
  pad: string | number;
  diameter: number;
  drill: number;
}

export interface CopperSpec {
  /** Filled/capped F.Cu-B.Cu vias at saved pad centres (the pad's own net). */
  via_at_pad?: ViaAtPad[];
  /** Nets whose unanchored track ends (and redundant one-layer vias) go; refused on plane nets. */
  prune_signal_leaves?: string[];
  /** As prune_signal_leaves, for plane nets: track leaves only, every via kept. */
  prune_track_leaves?: string[];
  /** Copper items (segment, via, arc) by uuid; each must match exactly one. */
  remove_items?: string[];
  /** sha256 of the source board the plan was written against. */
  source_sha256?: string;
}

export type CopperRemoved =
  | { kind: "explicit-item"; native: string }
  | { kind: "single-layer-via"; net: string; at: P }
  | { kind: "leaf-track"; a: P; b: P; w: number; layer: string; net: string };

export interface CopperLedger {
  added_vias: ViaAtPad[];
  removed: CopperRemoved[];
}

const fail = (m: string): never => {
  throw new EditStop(`FAIL copper: ${m}`);
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Python `f"{x:.6f}"` (ties to even on the exact value; the sign of a negative zero kept). */
export function f6(x: number): string {
  const s = pyRound(x, 6).toFixed(6);
  return (x < 0 || Object.is(x, -0)) && !s.startsWith("-") ? "-" + s : s;
}

/** Python `str(float)` (repr): integers keep `.0`, small and huge magnitudes use a two-digit exponent. */
export function pyFloat(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return (Object.is(x, -0) ? "-" : "") + Math.abs(x).toFixed(0) + ".0";
  const a = Math.abs(x);
  if (a < 1e-4 || a >= 1e16) {
    const [m, e] = x.toExponential().split("e") as [string, string];
    const n = Number(e);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  return String(x);
}

/** A JSON number as Python prints it after `json.load` (an integral JSON number reads as int there; JSON `1.0` cannot be told apart here). */
const pyJsonNum = (x: number) => String(x);

const dist = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** check_acceptance.seg_dist. */
function segDist(p: P, a: P, b: P): number {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - a[0] - u * (b[0] - a[0]), p[1] - a[1] - u * (b[1] - a[1]));
}

const netOfItem = (block: string): string | null => {
  const n = kid(parseSexpr(block), "net");
  return n ? String(n[n.length - 1]) : null;
};

/** Nets a copper plan touches on `text` (the via pads' nets, the pruned nets, the removed items' nets): planned change. */
export function copperNets(text: string, spec: CopperSpec, ledger: CopperLedger): string[] {
  const out = new Set<string>([...(spec.prune_signal_leaves ?? []), ...(spec.prune_track_leaves ?? [])]);
  const pads = readBoard(parseSexpr(text)).pads;
  for (const v of spec.via_at_pad ?? []) for (const p of pads) if (p.ref === v.ref && p.pad === String(v.pad)) out.add(p.net);
  for (const r of ledger.removed) if (r.kind === "explicit-item") {
    const n = netOfItem(r.native);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/**
 * `copper_plan.apply(text, plan)`: the edited board text and the ledger. `uid` makes the new items' uuids (uuid4 by
 * default; the parity harness passes the oracle's sequence). Throws EditStop("FAIL copper: ...") where the script raises.
 */
export function copperPlan(text: string, plan: CopperSpec, uid: () => string = randomUUID): { text: string; ledger: CopperLedger } {
  if (plan.source_sha256 && sha256(text) !== plan.source_sha256) fail("Source revision mismatch");
  const exact: Array<[number, number, string]> = [];
  const seen = new Set<string>();
  for (const target of plan.remove_items ?? []) {
    if (seen.has(target)) fail(`copper UUID ${target} listed twice`);
    seen.add(target);
    const hits: Array<[number, number, string]> = [];
    for (const kind of ["segment", "via", "arc"])
      for (const s of topLevelSpans(text, kind)) {
        const body = text.slice(s.start, s.end);
        if (body.includes(`(uuid "${target}")`)) hits.push([s.start, s.end, body]);
      }
    if (hits.length !== 1) fail(`Expected one copper UUID ${target}, got ${hits.length}`);
    exact.push(...hits);
  }
  text = splice(text, exact.map(([start, end]) => ({ start, end, text: "" })));
  const root = parseSexpr(text);
  const board = readBoard(root);
  const pads: Pad[] = board.pads;
  const segs: Segment[] = board.segments;
  const vias: Via[] = board.vias;
  const made: string[] = [];
  const removed: CopperRemoved[] = exact.map(([, , body]) => ({ kind: "explicit-item", native: body }));
  for (const v of plan.via_at_pad ?? []) {
    const hit = pads.filter((p) => p.ref === v.ref && p.pad === String(v.pad));
    if (hit.length !== 1) fail(`via_at_pad ${v.ref}.${v.pad}: expected one netted pad, found ${hit.length}`);
    const p = hit[0]!;
    if (vias.some((q) => dist([p.x, p.y], [q.x, q.y]) < 0.001)) fail(`via already exists at ${v.ref}.${v.pad} (${f6(p.x)}, ${f6(p.y)})`);
    made.push(
      `(via (at ${f6(p.x)} ${f6(p.y)}) (size ${pyJsonNum(v.diameter)}) (drill ${pyJsonNum(v.drill)}) ` +
        `(layers "F.Cu" "B.Cu") (net "${p.net}") ` +
        `(uuid "${uid()}") (filling yes) (capping yes))`,
    );
  }
  const signal = new Set(plan.prune_signal_leaves ?? []);
  const zoneNets = new Set<string>();
  for (const z of kids(root, "zone")) {
    const n = kid(z, "net");
    if (n) zoneNets.add(String(n[n.length - 1]));
  }
  const arcNets = new Set<string>();
  for (const a of kids(root, "arc")) {
    const n = kid(a, "net");
    if (n) arcNets.add(String(n[n.length - 1]));
  }
  for (const net of [...new Set([...(plan.prune_signal_leaves ?? []), ...(plan.prune_track_leaves ?? [])])].sort()) {
    const plane = zoneNets.has(net);
    if (plane && signal.has(net)) fail("Refuse to prune plane vias; use prune_track_leaves");
    if (arcNets.has(net)) fail("Arc pruning not implemented");
    const ss = segs.filter((s) => s.net === net);
    const vv = vias.filter((v) => v.net === net);
    const pp = pads.filter((p) => p.net === net);
    // a redundant one-layer via is not an anchor or series delay element
    const keepV: Via[] = [];
    for (const v of vv) {
      const q: P = [v.x, v.y];
      const touching = ss.filter((s) => segDist(q, s.a, s.b) <= v.size / 2 + s.w / 2 - 1e-6);
      const onPad = pp.some((p) => dist(q, [p.x, p.y]) <= p.r + v.size / 2 + 1e-6);
      if (!plane && !onPad && new Set(touching.map((s) => s.layer)).size === 1 && touching.every((s) => Math.min(dist(q, s.a), dist(q, s.b)) < 1e-5))
        removed.push({ kind: "single-layer-via", net, at: q });
      else keepV.push(v);
    }
    // split at physical centreline junctions, keeping every branch that connects anchors
    let split: Segment[] = [];
    for (const s of ss) {
      const cuts = new Set<number>([0, segLen(s.a, s.b)]);
      for (const t of ss) {
        if (t === s || t.layer !== s.layer) continue;
        const ip = crossPoint(s.a, s.b, t.a, t.b);
        if (ip) cuts.add(project(s.a, s.b, ip));
        for (const e of [t.a, t.b]) if (pointSegDist(e, s.a, s.b) <= (s.w + t.w) / 2 - 1e-6) cuts.add(project(s.a, s.b, e));
      }
      const cs = [...cuts].sort((x, y) => x - y);
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i]!, b = cs[i + 1]!;
        if (b - a > 1e-6) split.push({ ...s, a: interpolate(s.a, s.b, a), b: interpolate(s.a, s.b, b) });
      }
    }
    for (;;) {
      const drop: number[] = [];
      split.forEach((s, i) => {
        for (const e of [s.a, s.b]) {
          const anchor = pp.some((p) => padOnLayer(p, s.layer) && dist(e, [p.x, p.y]) <= p.r + s.w / 2 + 1e-6) || keepV.some((v) => dist(e, [v.x, v.y]) <= v.size / 2 + s.w / 2);
          const joined = split.some((t, j) => j !== i && t.layer === s.layer && segDist(e, t.a, t.b) <= (s.w + t.w) / 2 - 1e-6);
          if (!anchor && !joined) {
            drop.push(i);
            break;
          }
        }
      });
      if (!drop.length) break;
      for (const i of [...drop].reverse()) {
        const s = split[i]!;
        removed.push({ kind: "leaf-track", a: s.a, b: s.b, w: s.w, layer: s.layer, net: s.net });
      }
      const gone = new Set(drop);
      split = split.filter((_, i) => !gone.has(i));
    }
    for (const s of split)
      made.push(`(segment (start ${f6(s.a[0])} ${f6(s.a[1])}) (end ${f6(s.b[0])} ${f6(s.b[1])}) (width ${pyFloat(s.w)}) (layer "${s.layer}") (net "${net}") (uuid "${uid()}"))`);
    const keep = new Set(keepV.map((v) => `${pyRound(v.x, 6)}|${pyRound(v.y, 6)}`));
    const spans: Array<{ start: number; end: number; text: string }> = [];
    for (const kind of ["segment", "via"])
      for (const sp of topLevelSpans(text, kind)) {
        const body = text.slice(sp.start, sp.end);
        if (!body.includes(`"${net}"`)) continue;
        const r = parseSexpr(body);
        const n = kid(r, "net");
        if (!n || String(n[n.length - 1]) !== net) continue;
        if (kind === "via") {
          const at = kid(r, "at");
          if (keep.has(`${pyRound(Number(at?.[1]), 6)}|${pyRound(Number(at?.[2]), 6)}`)) continue;
        }
        spans.push({ ...sp, text: "" });
      }
    text = splice(text, spans);
  }
  const end = text.trimEnd().lastIndexOf(")");
  return { text: text.slice(0, end) + "\n" + made.join("\n") + "\n)\n", ledger: { added_vias: plan.via_at_pad ?? [], removed } };
}

/**
 * A direct track from an added part to the pad it was placed next to (`add[].near: "U602.5"`): the connection a
 * decoupling capacitor needs, which a pour-only connection (no open in the ratsnest, so nothing for the last mile to
 * route) does not give. In the pcb-vs-fabdesk eval three of four arms built this track by hand after an add; neither
 * the toolkit's edit nor board_edit did.
 *
 * Candidates, shortest first: straight, then the two single-bend paths. A candidate is kept only when every piece clears
 * every other net's copper on that layer (pads as their real rectangles, tracks, vias) by the board clearance; the
 * edit's proof then judges the whole board with KiCad DRC. Nothing fits: the add stays pour-connected and the log says
 * why.
 */
import { randomUUID } from "node:crypto";
import { readBoard } from "../board";
import { parseSexpr } from "../sexpr";
import { padList, segBoxHit, type Box, type Pt } from "./geom";
import { rawFootprints } from "./move";

export type LinkLog =
  | { from: string; to: string; layer: string; width: number; mm: number; points: Pt[]; /** The pose the part was moved to so the track fits. */ placed?: [number, number, number] }
  | { from: string; to: string; skipped: string };

const d2 = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Shortest distance between segments p1-p2 and q1-q2. */
export function segSegDist(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  const ptSeg = (p: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return d2(p, [a[0] + t * dx, a[1] + t * dy]);
  };
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const s1 = cross(p1, p2, q1), s2 = cross(p1, p2, q2), s3 = cross(q1, q2, p1), s4 = cross(q1, q2, p2);
  if (s1 * s2 < 0 && s3 * s4 < 0) return 0;
  return Math.min(ptSeg(p1, q1, q2), ptSeg(p2, q1, q2), ptSeg(q1, p1, p2), ptSeg(q2, p1, p2));
}

const onLayer = (layers: Iterable<string>, L: string) => [...layers].some((l) => l === L || l === "*.Cu" || (l === "F&B.Cu" && (L === "F.Cu" || L === "B.Cu")));

/**
 * Add the shortest clear track from `newRef`'s pad on the target pad's net to the target pad (`REF.PAD`). Returns the
 * text (unchanged when nothing fits) and what happened.
 */
export function directLink(text: string, newRef: string, target: string, clearance: number): { text: string; log: LinkLog } {
  const dot = target.indexOf(".");
  const [tRef, tPad] = [target.slice(0, dot), target.slice(dot + 1)];
  const root = parseSexpr(text);
  const board = readBoard(root);
  const raw = rawFootprints(root);
  const geo = new Map<string, ReturnType<typeof padList>>();
  for (const [ref, fp] of raw) {
    const f = board.footprints.get(ref);
    if (f) geo.set(ref, padList(fp, f.x, f.y, f.rot));
  }
  const tp = geo.get(tRef)?.find((p) => p.name === tPad);
  const from = `${newRef}.?`;
  if (!tp) return { text, log: { from, to: target, skipped: `${target}: no such pad` } };
  const net = tp.net;
  if (!net) return { text, log: { from, to: target, skipped: `${target} has no net` } };
  const ctr = (b: Box): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const mine = (geo.get(newRef) ?? []).filter((p) => p.net === net).sort((a, b) => d2(ctr(a.box), ctr(tp.box)) - d2(ctr(b.box), ctr(tp.box)));
  const np = mine[0];
  if (!np) return { text, log: { from, to: target, skipped: `${newRef} has no pad on ${net}` } };
  const fromName = `${newRef}.${np.name}`;
  const layer = ["F.Cu", "B.Cu", "In1.Cu", "In2.Cu"].find((L) => onLayer(np.layers, L) && onLayer(tp.layers, L));
  if (!layer) return { text, log: { from: fromName, to: target, skipped: `${fromName} and ${target} share no copper layer` } };
  // the net's usual width (by length), within 0.2-0.5 mm
  const byW = new Map<number, number>();
  for (const s of board.segments) if (s.net === net) byW.set(s.w, (byW.get(s.w) ?? 0) + d2(s.a, s.b));
  const usual = [...byW].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0.25;
  const widths = [...new Set([Math.min(0.5, Math.max(0.2, usual)), 0.25, 0.2])].filter((w) => w <= Math.min(0.5, Math.max(0.2, usual)) + 1e-9);
  const a = ctr(np.box), b = ctr(tp.box);
  const bend1: Pt = [b[0], a[1]], bend2: Pt = [a[0], b[1]];
  const paths: Pt[][] = ([[a, b], [a, bend1, b], [a, bend2, b]] as Pt[][]).filter((p, i) => i === 0 || (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6));
  const padsOther = [...geo.values()].flat().filter((p) => p.net !== net && onLayer(p.layers, layer));
  const segsOther = board.segments.filter((s) => s.net !== net && s.layer === layer);
  const viasOther = board.vias.filter((v) => v.net !== net);
  const blockers = new Set<string>();
  const clear = (p: Pt, q: Pt, hw: number) => {
    let ok = true;
    for (const o of padsOther) if (segBoxHit(p, q, hw + clearance, o.box)) (ok = false), blockers.add(`pad ${o.net || "(no net)"}`);
    for (const s of segsOther) if (segSegDist(p, q, s.a, s.b) < hw + s.w / 2 + clearance) (ok = false), blockers.add(`track ${s.net}`);
    for (const v of viasOther) if (segSegDist(p, q, [v.x, v.y], [v.x, v.y]) < hw + v.size / 2 + clearance) (ok = false), blockers.add(`via ${v.net}`);
    return ok;
  };
  const ranked = paths.map((pts) => ({ pts, mm: pts.slice(1).reduce((t, p, i) => t + d2(pts[i]!, p), 0) })).sort((x, y) => x.mm - y.mm);
  let ok: { pts: Pt[]; mm: number } | undefined;
  let width = widths[0]!;
  for (const w of widths) {
    ok = ranked.find(({ pts }) => pts.slice(1).every((p, i) => clear(pts[i]!, p, w / 2)));
    if (ok) {
      width = w;
      break;
    }
  }
  if (!ok)
    return { text, log: { from: fromName, to: target, skipped: `no straight or single-bend track (${widths.join(" / ")} mm) clears the other copper on ${layer}: in the way ${[...blockers].slice(0, 6).join(", ")}` } };
  const q = (s: string) => JSON.stringify(s);
  const segs = ok.pts
    .slice(1)
    .map((p, i) => `  (segment (start ${ok.pts[i]![0].toFixed(4)} ${ok.pts[i]![1].toFixed(4)}) (end ${p[0].toFixed(4)} ${p[1].toFixed(4)}) (width ${width.toFixed(4)}) (layer ${q(layer)}) (net ${q(net)}) (uuid ${q(randomUUID())}))`)
    .join("\n");
  const end = text.trimEnd().lastIndexOf(")");
  return { text: `${text.slice(0, end).trimEnd()}\n${segs}\n)\n`, log: { from: fromName, to: target, layer, width, mm: Math.round(ok.mm * 100) / 100, points: ok.pts } };
}

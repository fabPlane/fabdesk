/**
 * Fine-pitch power escapes (port of the toolkit's `tools/power_escape.py`): same-net pin bridges and short pad-width
 * escape stubs, added as tracks before routing.
 *
 * For pads of power nets whose class width exceeds the pad's narrow side (a 0.2 mm QFN pin on a 0.6-1.0 mm class),
 * routers either box the pin in (no neck-down) or narrow whole connections (TraceMaker). This adds the standard escape
 * the neck rule allows (narrow copper only within 1 mm of the pad):
 * - bridge: a pad-width segment between two pins of the same footprint and net that are adjacent (centre distance
 *   <= 0.7 mm) and clear of every other-net pad, track and via;
 * - stub: a pad-width segment from the pad centre outward (along the axis of the larger offset from the footprint
 *   centre) to `maxStub` mm beyond the pad edge, capped at 1.0 mm from the centre, when it clears every other-net pad,
 *   track, via and earlier escape by `clearance`. The router then connects at full class width to the stub end.
 * Only SMD pads on F.Cu/B.Cu of footprints with 6+ pads, on nets of `PWR_*` classes wider than the pad's narrow side by
 * more than 0.25 mm. The geometry comes from the rules; native DRC remains the check.
 */
import { randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import { parseBoard } from "../board";
import type { Acceptance } from "../requirements";
import { appendBeforeClose } from "../layout/text";
import { kid, kids, num, parseSexpr, quote, type SNode } from "../sexpr";

export interface EscapeOptions {
  /** How far a stub reaches beyond the pad edge, mm (default 0.9; the stub never ends more than 1.0 mm from the centre). */
  maxStub?: number;
  /** Clearance kept to other-net copper, mm (default 0.1). */
  clearance?: number;
  /** Track uuids (tests pass a deterministic source). */
  uuid?: () => string;
}

export interface EscapeStats {
  bridges: number;
  stubs: number;
  stubs_blocked: number;
}

export interface EscapeSegment {
  a: [number, number];
  b: [number, number];
  w: number;
  net: string;
  layer: string;
  kind: "bridge" | "stub";
}

interface EPad {
  ref: string;
  num: string;
  net: string;
  x: number;
  y: number;
  /** Narrow and wide side of the pad. */
  ws: number;
  wl: number;
  /** "F.Cu", "B.Cu", "all" (through hole / every copper layer) or null (no copper side found). */
  layer: string | null;
  /** Pads of its footprint. */
  n: number;
}

type Pt = [number, number];

function segPoint(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ccw = (p: Pt, q: Pt, r: Pt) => (r[1] - p[1]) * (q[0] - p[0]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (ccw(a, b, c) > 0 !== ccw(a, b, d) > 0 && ccw(c, d, a) > 0 !== ccw(c, d, b) > 0) return 0;
  return Math.min(segPoint(...a, ...b, ...c), segPoint(...a, ...b, ...d), segPoint(...c, ...d, ...a), segPoint(...c, ...d, ...b));
}

/** Python `math.copysign(1, x)`. */
const sign1 = (x: number) => (x > 0 || Object.is(x, 0) ? 1 : -1);

/** Every pad with a position and size, in world coordinates, with its copper side (the script's own pad list). */
function escapePads(root: SNode, fps: Map<string, { x: number; y: number; rot: number }>): EPad[] {
  const pads: EPad[] = [];
  for (const fp of kids(root, "footprint")) {
    const props: Record<string, string> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2] ?? "");
    const ref = props["Reference"];
    if (ref === undefined) continue;
    const f = fps.get(ref);
    if (!f) continue;
    const rad = (f.rot * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const all = kids(fp, "pad");
    for (const pd of all) {
      const at = kid(pd, "at"), size = kid(pd, "size"), net = kid(pd, "net");
      if (!at || !size) continue;
      const px = num(at[1]), py = num(at[2]);
      const layers = (kid(pd, "layers") ?? []).slice(1).map(String);
      let side: string | null = layers.some((l) => l.startsWith("F.")) ? "F.Cu" : layers.some((l) => l.startsWith("B.")) ? "B.Cu" : null;
      if (pd[2] === "thru_hole" || layers.includes("*.Cu")) side = "all";
      const [w1, w2] = [num(size[1]), num(size[2])].sort((p, q) => p - q) as [number, number];
      pads.push({ ref, num: String(pd[1]), net: net ? String(net[net.length - 1]) : "", x: f.x + px * c + py * s, y: f.y - px * s + py * c, ws: w1, wl: w2, layer: side, n: all.length });
    }
  }
  return pads;
}

/** The power nets and their class widths (`PWR_*` classes of the acceptance). */
export function powerWidths(acc: Acceptance): Map<string, number> {
  const width = new Map<string, number>();
  for (const [k, c] of Object.entries(acc.net_classes.classes)) {
    if (!k.startsWith("PWR_")) continue;
    const nets = (typeof c.nets === "string" ? JSON.parse(c.nets) : (c.nets ?? [])) as string[];
    for (const n of nets) width.set(n, c.track_width!);
  }
  return width;
}

/** Add the escapes to a board's text; the tracks go before the board's closing parenthesis. */
export function powerEscape(text: string, acc: Acceptance, o: EscapeOptions = {}): { text: string; stats: EscapeStats; segments: EscapeSegment[] } {
  const maxStub = o.maxStub ?? 0.9;
  const clearance = o.clearance ?? 0.1;
  const width = powerWidths(acc);
  const root = parseSexpr(text);
  const board = parseBoard(text);
  const pads = escapePads(root, board.footprints);
  const segs = board.segments;
  const vias = board.vias;
  const byRef = new Map<string, EPad[]>();
  for (const p of pads) {
    let l = byRef.get(p.ref);
    if (!l) byRef.set(p.ref, (l = []));
    l.push(p);
  }
  const added: EscapeSegment[] = [];
  const stats: EscapeStats = { bridges: 0, stubs: 0, stubs_blocked: 0 };
  let curRef = "";
  const clear = (ax: number, ay: number, bx: number, by: number, w: number, net: string, layer: string): boolean => {
    for (const q of pads) {
      if (q.net === net || (q.layer !== layer && q.layer !== "all")) continue;
      // a pad of the part being escaped by its narrow side (the escape runs between its pins), any other by its half-diagonal
      const r = q.ref === curRef ? q.ws / 2 : Math.hypot(q.ws, q.wl) / 2;
      if (segPoint(ax, ay, bx, by, q.x, q.y) < r + w / 2 + clearance) return false;
    }
    for (const sg of segs) {
      if (sg.net === net || sg.layer !== layer) continue;
      if (segSeg([ax, ay], [bx, by], sg.a, sg.b) < sg.w / 2 + w / 2 + clearance) return false;
    }
    for (const v of vias) if (v.net !== net && segPoint(ax, ay, bx, by, v.x, v.y) < v.size / 2 + w / 2 + clearance) return false;
    for (const e of added) if (e.net !== net && e.layer === layer && segSeg([ax, ay], [bx, by], e.a, e.b) < w / 2 + e.w / 2 + clearance) return false;
    return true;
  };
  for (const [ref, ps] of byRef) {
    curRef = ref;
    if (ps[0]!.n < 6) continue;
    const f = board.footprints.get(ref)!;
    for (const [i, p] of ps.entries()) {
      const w = width.get(p.net);
      // pins near the class width need no escape
      if ((p.layer !== "F.Cu" && p.layer !== "B.Cu") || w === undefined || w <= p.ws + 0.25) continue;
      // bridges to adjacent same-net pins, each pair once (the script ordered pairs by object id; file order here)
      for (const [j, q] of ps.entries()) {
        if (j <= i || q.net !== p.net || q.layer !== p.layer) continue;
        const bw = Math.min(p.ws, q.ws);
        if (Math.hypot(q.x - p.x, q.y - p.y) <= 0.7 && clear(p.x, p.y, q.x, q.y, bw, p.net, p.layer)) {
          added.push({ a: [p.x, p.y], b: [q.x, q.y], w: bw, net: p.net, layer: p.layer, kind: "bridge" });
          stats.bridges++;
        }
      }
      const dx = p.x - f.x, dy = p.y - f.y;
      const [ux, uy] = Math.abs(dx) >= Math.abs(dy) ? [sign1(dx), 0] : [0, sign1(dy)];
      const L = Math.min(p.wl / 2 + maxStub, 1.0); // A7: narrow copper only within 1.0 mm of the pad
      const ex = p.x + ux * L, ey = p.y + uy * L;
      if (clear(p.x, p.y, ex, ey, p.ws, p.net, p.layer)) {
        added.push({ a: [p.x, p.y], b: [ex, ey], w: p.ws, net: p.net, layer: p.layer, kind: "stub" });
        stats.stubs++;
      } else stats.stubs_blocked++;
    }
  }
  if (!added.length) return { text, stats, segments: added };
  const uuid = o.uuid ?? randomUUID;
  const f4 = (x: number) => pyRound(x, 4).toFixed(4);
  const items = added
    .map((e) => `\n  (segment (start ${f4(e.a[0])} ${f4(e.a[1])}) (end ${f4(e.b[0])} ${f4(e.b[1])}) (width ${f4(Math.max(e.w, 0.123))}) (layer ${quote(e.layer)}) (net ${quote(e.net)}) (uuid "${uuid()}"))`)
    .join("");
  return { text: appendBeforeClose(text, items), stats, segments: added };
}

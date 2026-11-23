/**
 * Pour splits (fabdesk, not in the toolkit): a router candidate whose new tracks cross another net's copper pour can
 * leave that pour, once KiCad refills it, in pieces, islanding a pad that was connected (jetson reroute, 2026-11-14:
 * `opens` closed the 4 TPM nets and opened /Power/USBPD2_HV; with F/B costed it opened +5V on In4.Cu instead). The bench
 * names the split on the try line and retries the step with the layers in question kept out of reach (`~avoid`).
 *
 * Everything here reads board text with light scans (the zones' outlines and the copper a step added), never a full
 * parse: on an 86 MB board a parse costs most of a GiB.
 */
import { childLists, topLevelSpans } from "../sexpr";

export type XY = [number, number];

/** A copper pour: a top-level zone that names a net (rule areas and keepouts are not pours). */
export interface Pour {
  net: string;
  layers: string[];
  /** The zone's outline polygon(s), not its fill. */
  outlines: XY[][];
  box: [number, number, number, number];
}

/** A track (segment, or an arc as start-mid-end) as a polyline on one layer. */
export interface Track {
  net: string;
  layer: string;
  pts: XY[];
}

/** A net that is open on the candidate, was connected on the start board, and whose pour new tracks cross on `layers`. */
export interface PourSplit {
  net: string;
  layers: string[];
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;
const XY_RE = /\(xy\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)/g;
const headOf = (text: string, at: number) => /^\(([^\s()]+)/.exec(text.slice(at, at + 40))?.[1] ?? "";

/** Layer names as a zone writes them: `*.Cu` is every copper layer, `F&B.Cu` the two outer ones. */
function expandLayers(names: string[], copperLayers: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n === "*.Cu") copperLayers.forEach((l) => out.add(l));
    else if (n === "F&B.Cu") ["F.Cu", "B.Cu"].forEach((l) => out.add(l));
    else if (/\.Cu$/.test(n)) out.add(n);
  }
  return [...out];
}

function boxOf(pts: Iterable<XY>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** The pours of a board: each zone with a net, its copper layers and outline (the `polygon`, never `filled_polygon`). */
export function boardPours(text: string, copperLayers: readonly string[]): Pour[] {
  const out: Pour[] = [];
  for (const z of topLevelSpans(text, "zone")) {
    let net = "";
    let netName: string | null = null;
    let layers: string[] = [];
    let keepout = false;
    const outlines: XY[][] = [];
    for (const c of childLists(text, z)) {
      const head = headOf(text, c.start);
      if (head === "filled_polygon" || head === "fill" || head === "fill_segments") continue;
      const body = text.slice(c.start, c.end);
      if (head === "net") net = [...body.matchAll(QUOTED)].at(-1)?.[1] ?? /\(net\s+([^\s()]+)/.exec(body)?.[1] ?? "";
      else if (head === "net_name") netName = [...body.matchAll(QUOTED)].at(-1)?.[1] ?? "";
      else if (head === "layer" || head === "layers") layers = [...body.matchAll(QUOTED)].map((m) => m[1]!).concat(body.match(/(?<=[\s(])[^\s"()]+\.Cu(?=[\s)])/g) ?? []);
      else if (head === "keepout") keepout = true;
      else if (head === "polygon") {
        const pts = [...body.matchAll(XY_RE)].map((m): XY => [Number(m[1]), Number(m[2])]);
        if (pts.length >= 3) outlines.push(pts);
      }
    }
    const name = netName ?? net;
    // a legacy zone names its net by number and by name; a rule area names none
    if (keepout || !name || /^\d+$/.test(name) || !outlines.length) continue;
    const ls = expandLayers(layers, copperLayers);
    if (ls.length) out.push({ net: name, layers: ls, outlines, box: boxOf(outlines.flat()) });
  }
  return out;
}

const PT = (key: string) => new RegExp(`\\(${key}\\s+(-?[\\d.]+(?:e-?\\d+)?)\\s+(-?[\\d.]+(?:e-?\\d+)?)\\s*\\)`);
const START = PT("start"), MID = PT("mid"), END = PT("end");
const LAYER = /\(layer\s+"?([^"\s()]+)"?\s*\)/;
const NET = /\(net\s+(?:\d+\s+)?"((?:[^"\\]|\\.)*)"\s*\)|\(net\s+(\d+)\s*\)/;

/** Tracks among copper item texts (segments and arcs; vias are left out: they do not belong to one layer). */
export function tracksOf(items: Iterable<string>): Track[] {
  const out: Track[] = [];
  for (const it of items) {
    if (!/^\((segment|arc)\s/.test(it)) continue;
    const a = START.exec(it), b = END.exec(it), m = MID.exec(it);
    const layer = LAYER.exec(it)?.[1];
    if (!a || !b || !layer) continue;
    const n = NET.exec(it);
    const xy = (r: RegExpExecArray): XY => [Number(r[1]), Number(r[2])];
    out.push({ net: n?.[1] ?? n?.[2] ?? "", layer, pts: m ? [xy(a), xy(m), xy(b)] : [xy(a), xy(b)] });
  }
  return out;
}

/** Track length per layer, mm (arcs as their two chords). */
export function trackLengthByLayer(tracks: Iterable<Track>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tracks) {
    let len = 0;
    for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i]![0] - t.pts[i - 1]![0], t.pts[i]![1] - t.pts[i - 1]![1]);
    out.set(t.layer, (out.get(t.layer) ?? 0) + len);
  }
  return out;
}

function inside([x, y]: XY, poly: XY[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const orient = (a: XY, b: XY, c: XY) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
function segmentsCross(p: XY, q: XY, r: XY, s: XY): boolean {
  const d1 = orient(p, q, r), d2 = orient(p, q, s), d3 = orient(r, s, p), d4 = orient(r, s, q);
  return d1 !== d2 && d3 !== d4 && d1 * d2 <= 0 && d3 * d4 <= 0;
}

const boxesMeet = (a: readonly number[], b: readonly number[]) => a[0]! <= b[2]! && b[0]! <= a[2]! && a[1]! <= b[3]! && b[1]! <= a[3]!;

/** True when the polyline has a point inside the polygon or crosses its edge. */
export function trackCrossesPolygon(pts: readonly XY[], poly: XY[]): boolean {
  if (pts.some((p) => inside(p, poly))) return true;
  for (let i = 1; i < pts.length; i++)
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) if (segmentsCross(pts[i - 1]!, pts[i]!, poly[j]!, poly[k]!)) return true;
  return false;
}

const crossesPour = (t: Track, p: Pour) => p.layers.includes(t.layer) && t.net !== p.net && boxesMeet(boxOf(t.pts), p.box) && p.outlines.some((o) => trackCrossesPolygon(t.pts, o));

/**
 * The fresh opens (nets open on the candidate that were connected on the start board) that have a pour which the
 * candidate's new tracks (of other nets) cross, with the layers where they cross it. A fresh open on a net without a
 * pour, or whose pours no new track crosses, is not a split (the try line still names it as a NEW open).
 */
export function pourSplits(pours: readonly Pour[], newTracks: readonly Track[], fresh: Iterable<string>): PourSplit[] {
  const out: PourSplit[] = [];
  for (const net of [...new Set(fresh)].sort()) {
    const layers = new Set<string>();
    for (const p of pours) if (p.net === net) for (const t of newTracks) if (!layers.has(t.layer) && crossesPour(t, p)) layers.add(t.layer);
    if (layers.size) out.push({ net, layers: [...layers] });
  }
  return out;
}

/** `split a pour: NET on L1, L2; NET2 on L3` for a try line. */
export function splitLine(splits: readonly PourSplit[]): string {
  return splits.length ? `split a pour: ${splits.map((s) => `${s.net} on ${s.layers.join(", ")}`).join("; ")}` : "";
}

/** An inner layer counts as plane-like when its tracks are under this share of the busiest inner routing layer's. */
export const PLANE_LIKE_TRACK_SHARE = 0.25;
/** How far round the candidate's new tracks pours are looked for, mm. */
const REGION_MARGIN_MM = 2;

/**
 * The layers a `~avoid` retry keeps out of reach, in stack order:
 *   - every layer a pour was split on;
 *   - outer layers carrying a pour of a connected net near the candidate's new tracks (they get a cost; leaving F/B out
 *     makes KRT write no board);
 *   - inner layers carrying such a pour that are plane-like: tracks there come to under a quarter of the busiest inner
 *     routing layer's. jetson's In4.Cu (+5V and eight more pours, 644 mm of track against 8590 on In7.Cu) is one, though
 *     the onboarding listed only In1/In3/In6/In8 as planes; In2.Cu and In5.Cu carry full pours too but are signal
 *     layers (3958 and 8399 mm), and routing over them split nothing. Retrying with only the split layer avoided moves
 *     the tracks onto such a layer: the agent's F/B-costed plan split +5V on In4.Cu.
 * `routingLayers` (what `@layers` expands to, when the host knows) limits the answer to layers a plan can route on.
 */
export function avoidLayersFor(o: {
  splits: readonly PourSplit[];
  pours: readonly Pour[];
  newTracks: readonly Track[];
  /** The start board's track length per layer. */
  trackLength: ReadonlyMap<string, number>;
  /** Nets open on the start board (their pours are not someone else's to keep whole). */
  openBefore: ReadonlySet<string>;
  copperLayers: readonly string[];
  routingLayers?: readonly string[] | undefined;
}): string[] {
  const routing = o.routingLayers ? new Set(o.routingLayers) : null;
  const can = (l: string) => !routing || routing.has(l);
  const outer = (l: string) => l === "F.Cu" || l === "B.Cu";
  const want = new Set(o.splits.flatMap((s) => s.layers));
  if (o.newTracks.length) {
    const [x0, y0, x1, y1] = boxOf(o.newTracks.flatMap((t) => t.pts));
    const region = [x0 - REGION_MARGIN_MM, y0 - REGION_MARGIN_MM, x1 + REGION_MARGIN_MM, y1 + REGION_MARGIN_MM];
    const innerRouting = o.copperLayers.filter((l) => !outer(l) && can(l));
    const busiest = Math.max(0, ...innerRouting.map((l) => o.trackLength.get(l) ?? 0));
    for (const p of o.pours) {
      if (o.openBefore.has(p.net) || !boxesMeet(p.box, region)) continue;
      for (const l of p.layers) if (outer(l) || (o.trackLength.get(l) ?? 0) < PLANE_LIKE_TRACK_SHARE * busiest) want.add(l);
    }
  }
  return o.copperLayers.filter((l) => want.has(l) && can(l));
}

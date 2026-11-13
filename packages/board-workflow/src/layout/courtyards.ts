/**
 * The toolkit's `tools/add_courtyards.py` (toolkit main 066fea8): a rectangular courtyard for every footprint with pads
 * and none of its own, inverted courtyard rectangles put right, optional escape halos for the placement base, and a
 * targeted refit of named footprints' courtyards (optionally round a datasheet body).
 *
 * - Added courtyard: the pad extent in the footprint's own frame plus `margin` (IPC-7351 nominal 0.25 mm), on
 *   F.CrtYd / B.CrtYd by the footprint's side. Without one the placer packs parts against the pads and courtyard DRC
 *   cannot see the part. Pad angles in a .kicad_pcb are absolute (they include the footprint rotation): a pad's own
 *   rotation is pad angle - footprint rotation, taken mod 180 (Python's modulo). At 0 / 180 the pad's sizes stand, at
 *   90 they swap, off the axes the pad counts as a circle of its larger size. (Before the toolkit's 2026-11-13 fix the
 *   absolute angle was used, which swapped pad width/length on 90/270-degree footprints: C6 C18_J101's courtyard was
 *   0.45 mm narrower than its lands.)
 * - Inverted rectangles: a courtyard fp_rect stored with start > end reads as empty to tracemaker-place (it placed
 *   parts over a connector); the corners are reordered.
 * - Halo (placement base only, never the fab board): the part's own-side courtyard replaced by the pad extent (pads as
 *   circles) plus `haloMm`, so the placer leaves escape room round escape-heavy parts. tracemaker-place honours one
 *   courtyard outline per footprint: replace, don't add.
 * - Refit (`refit`): only the named footprints change (no courtyards added elsewhere, no rect normalising). Each one's
 *   own-side courtyard is replaced by the rectilinear union of pads + margin and, when `bodies` names it, the datasheet
 *   body + margin (IPC-7351: the courtyard encloses both); four corners give an fp_rect, more an fp_poly. The body is
 *   drawn once on F.Fab / B.Fab (an identical rect is not repeated). A pad-only courtyard can be smaller than the part
 *   (C18_J101: socket body 12.30 mm, pad box 10.3 mm).
 */
import { randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import { footprintSpans, sideOf } from "../edit/text";
import { pyMod } from "./placement";
import { pose } from "./text";

const PAD = /\(pad\s+"[^"]*"\s+\w+\s+\w+[\s\S]*?\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)[\s\S]*?\(size ([-\d.]+) ([-\d.]+)\)/g;

/** A datasheet body in the footprint frame (mm): `size` [X, Y], `center` (default [0, 0]), `source` for the record. */
export interface PartBody {
  size: [number, number];
  center?: [number, number];
  source?: string;
}

export interface RefitInfo {
  /** Pad extent [x0, y0, x1, y1] in the footprint frame. */
  pads: number[];
  body?: number[];
  source?: string;
  /** Courtyard outline points. */
  courtyard: Array<[number, number]>;
}

export interface CourtyardResult {
  text: string;
  /** ref -> [width, height, layer] of the added rectangle. */
  added: Record<string, [number, number, string]>;
  inverted_rects_fixed: number;
  /** ref -> [width, height] of the halo. */
  halos: Record<string, [number, number]>;
  /** ref -> what a refit wrote (refit mode only; nothing else is done then). */
  refitted: Record<string, RefitInfo>;
}

export interface CourtyardOptions {
  margin?: number;
  halo?: string[];
  haloMm?: number;
  /** Refit mode: replace these footprints' own-side courtyards and change nothing else. */
  refit?: string[];
  /** Datasheet bodies by reference (keys starting with `_` are comments and ignored). */
  bodies?: Record<string, unknown>;
}

const r2 = (x: number) => pyRound(x, 2);
const r3 = (x: number) => pyRound(x, 3);
/** Python's `:.3f` (ties to even on the exact binary value; a negative that rounds to zero keeps its sign). */
const f3 = (x: number) => {
  const s = pyRound(x, 3).toFixed(3);
  return (x < 0 || Object.is(x, -0)) && !s.startsWith("-") ? `-${s}` : s;
};
/** Python's `:g` for the corner coordinates the inverted-rect fix writes. */
const pyG = (x: number) => String(Number(x.toPrecision(6)));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The pad extent in the footprint frame, (x0, y0, x1, y1), or null without pads (add_courtyards.pad_box). */
export function padBox(body: string): [number, number, number, number] | null {
  const fr = pose(body)[2];
  const xs: number[] = [], ys: number[] = [];
  for (const m of body.matchAll(PAD)) {
    const x = Number(m[1]), y = Number(m[2]), w = Number(m[4]), h = Number(m[5]);
    const rel = pyMod(Number(m[3] ?? 0) - fr, 180);
    let hw: number, hh: number;
    if (Math.abs(rel) < 1e-6 || near(rel, 180)) [hw, hh] = [w / 2, h / 2];
    else if (near(rel, 90)) [hw, hh] = [h / 2, w / 2];
    else hw = hh = Math.max(w, h) / 2;
    xs.push(x - hw, x + hw);
    ys.push(y - hh, y + hh);
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

/** The halo's pad extent: every pad as a circle of its larger size, whatever its angle. */
function circleBox(body: string): [number, number, number, number] | null {
  const xs: number[] = [], ys: number[] = [];
  for (const m of body.matchAll(PAD)) {
    const x = Number(m[1]), y = Number(m[2]), r = Math.max(Number(m[4]), Number(m[5])) / 2;
    xs.push(x - r, x + r);
    ys.push(y - r, y + r);
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

type Rect = [number, number, number, number];

/**
 * The outline (closed point list, counter-clockwise in board axes from the lowest grid corner) of the union of
 * axis-aligned rects that form one connected region (add_courtyards.union_outline): the rects' edges cut a grid,
 * covered cells are found by their centres, boundary edges are walked and collinear points dropped.
 */
export function unionOutline(rects: Rect[]): Array<[number, number]> {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const covered = (i: number, j: number) => {
    const cx = (xs[i]! + xs[i + 1]!) / 2, cy = (ys[j]! + ys[j + 1]!) / 2;
    return rects.some((r) => r[0] <= cx && cx <= r[2] && r[1] <= cy && cy <= r[3]);
  };
  const key = (i: number, j: number) => `${i},${j}`;
  const cells = new Set<string>();
  const order: Array<[number, number]> = [];
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++)
      if (covered(i, j)) {
        cells.add(key(i, j));
        order.push([i, j]);
      }
  const edges = new Map<string, [number, number]>();
  for (const [i, j] of order) {
    // boundary edges, counter-clockwise round each covered cell
    const sides: Array<[[number, number], [number, number], [number, number]]> = [
      [[i, j], [i + 1, j], [i, j - 1]],
      [[i + 1, j], [i + 1, j + 1], [i + 1, j]],
      [[i + 1, j + 1], [i, j + 1], [i, j + 1]],
      [[i, j + 1], [i, j], [i - 1, j]],
    ];
    for (const [a, b, nb] of sides) if (!cells.has(key(nb[0], nb[1]))) edges.set(key(a[0], a[1]), b);
  }
  // min(edges): the lexicographically smallest grid corner
  let start: [number, number] | null = null;
  for (const k of edges.keys()) {
    const [i, j] = k.split(",").map(Number) as [number, number];
    if (!start || i < start[0] || (i === start[0] && j < start[1])) start = [i, j];
  }
  if (!start) throw new Error("courtyard union is empty");
  const pts: Array<[number, number]> = [start];
  let cur = edges.get(key(start[0], start[1]))!;
  while (cur[0] !== start[0] || cur[1] !== start[1]) {
    pts.push(cur);
    cur = edges.get(key(cur[0], cur[1]))!;
  }
  const out: Array<[number, number]> = [];
  for (let k = 0; k < pts.length; k++) {
    // drop collinear points
    const a = pts[(k - 1 + pts.length) % pts.length]!, p = pts[k]!, c = pts[(k + 1) % pts.length]!;
    if (!((a[0] === p[0] && p[0] === c[0]) || (a[1] === p[1] && p[1] === c[1]))) out.push([xs[p[0]]!, ys[p[1]]!]);
  }
  if (edges.size !== pts.length) throw new Error("courtyard union is not one region");
  return out;
}

const rectItem = (x0: number, y0: number, x1: number, y1: number, layer: string) =>
  `\n    (fp_rect (start ${f3(x0)} ${f3(y0)}) (end ${f3(x1)} ${f3(y1)}) (stroke (width 0.05) (type solid)) (fill no) (layer "${layer}") (uuid "${randomUUID()}"))`;

/** Insert `item` before a footprint body's closing paren. */
const appendTo = (body: string, item: string) => {
  const close = body.trimEnd().lastIndexOf(")");
  return body.slice(0, close).trimEnd() + item + "\n  " + body.slice(close);
};

/** Each item of `kind` (by paren matching) in `text`. */
function* items(text: string, kind: string): Generator<[number, number]> {
  let i = 0;
  for (;;) {
    const j = text.indexOf(kind, i);
    if (j < 0) return;
    let depth = 0, k = j;
    for (;;) {
      const c = text[k++];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 || k >= text.length) break;
    }
    yield [j, k];
    i = k;
  }
}

/** The body with every graphic item on `layer` taken out (the line's leading blanks with it). */
function stripLayer(body: string, layer: string): string {
  const spans: Array<[number, number]> = [];
  for (const kind of ["(fp_rect", "(fp_line", "(fp_poly", "(fp_circle", "(fp_arc"])
    for (const [j, k] of items(body, kind)) if (body.slice(j, k).includes(`"${layer}"`)) spans.push([j, k]);
  for (const [j, k] of spans.sort((a, b) => b[0] - a[0])) body = body.slice(0, j).replace(/[ \t]+$/, "") + body.slice(k);
  return body;
}

/** Footprints from the end of the file backwards, so an insertion does not move the spans still to visit. */
const bySpan = (t: string) => [...footprintSpans(t)].sort((a, b) => b[1].start - a[1].start);

const isBody = (v: unknown): v is PartBody =>
  !!v && typeof v === "object" && Array.isArray((v as PartBody).size) && (v as PartBody).size.length === 2 && (v as PartBody).size.every((n) => typeof n === "number");

/** add_courtyards.refit: the named footprints' own-side courtyards rebuilt from pads (+ body) + margin; nothing else changes. */
function refitCourtyards(text0: string, refs: string[], bodies: Record<string, PartBody>, margin: number): { text: string; refitted: Record<string, RefitInfo> } {
  let text = text0;
  const done: Record<string, RefitInfo> = {};
  const fps = footprintSpans(text);
  for (const ref of refs) if (!fps.has(ref)) throw new Error(`refit: no footprint ${ref} on the board`);
  // each footprint once (the toolkit would refit a repeated reference twice on stale spans), from the end backwards
  for (const ref of [...new Set(refs)].sort((a, b) => fps.get(b)!.start - fps.get(a)!.start)) {
    const { start: s, end: e } = fps.get(ref)!;
    let body = text.slice(s, e);
    const side = sideOf(body);
    const pb = padBox(body);
    if (!pb) throw new Error(`refit: ${ref} has no pads`);
    const rects: Rect[] = [[pb[0] - margin, pb[1] - margin, pb[2] + margin, pb[3] + margin]];
    let add = "";
    // keys in the script's order: pads, body, source, courtyard
    const info: Omit<RefitInfo, "courtyard"> & { courtyard?: RefitInfo["courtyard"] } = { pads: pb.map(r3) };
    const bd = bodies[ref];
    if (bd) {
      const [sx, sy] = bd.size;
      const [cx, cy] = bd.center ?? [0, 0];
      const bx: Rect = [cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2];
      rects.push([bx[0] - margin, bx[1] - margin, bx[2] + margin, bx[3] + margin]);
      const rect = `(fp_rect (start ${f3(bx[0])} ${f3(bx[1])}) (end ${f3(bx[2])} ${f3(bx[3])}) (stroke (width 0.1)`;
      // idempotent: the same body rect is added once
      if (!body.includes(rect)) add += `\n    ${rect} (type solid)) (fill no) (layer "${side}.Fab") (uuid "${randomUUID()}"))`;
      info.body = bx.map(r3);
      info.source = bd.source ?? "";
    }
    const own = `${side}.CrtYd`;
    body = stripLayer(body, own);
    const pts = unionOutline(rects);
    if (pts.length === 4) {
      const px = pts.map((p) => p[0]), py = pts.map((p) => p[1]);
      add += rectItem(Math.min(...px), Math.min(...py), Math.max(...px), Math.max(...py), own);
    } else {
      const xy = pts.map(([x, y]) => `(xy ${f3(x)} ${f3(y)})`).join(" ");
      add += `\n    (fp_poly (pts ${xy}) (stroke (width 0.05) (type solid)) (fill no) (layer "${own}") (uuid "${randomUUID()}"))`;
    }
    const close = body.trimEnd().lastIndexOf(")");
    text = text.slice(0, s) + body.slice(0, close).trimEnd() + add + "\n  " + body.slice(close) + text.slice(e);
    info.courtyard = pts.map(([x, y]) => [r3(x), r3(y)]);
    done[ref] = info as RefitInfo;
  }
  return { text, refitted: done };
}

/** Datasheet bodies from a `--bodies` JSON object: `_` keys are comments; every other entry needs `size: [X, Y]`. */
export function readBodies(raw: Record<string, unknown>): Record<string, PartBody> {
  const bodies: Record<string, PartBody> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (!isBody(v)) throw new Error(`bodies: ${k} needs "size": [X, Y] in mm (footprint frame)`);
    bodies[k] = v;
  }
  return bodies;
}

export function addCourtyards(text0: string, o: CourtyardOptions = {}): CourtyardResult {
  const margin = o.margin ?? 0.25;
  if (o.refit?.length) {
    // targeted edit: only the named footprints change (no adds, no rect normalising elsewhere)
    const r = refitCourtyards(text0, o.refit, readBodies(o.bodies ?? {}), margin);
    return { text: r.text, added: {}, inverted_rects_fixed: 0, halos: {}, refitted: r.refitted };
  }
  let text = text0;
  const added: CourtyardResult["added"] = {};
  for (const [ref, sp] of bySpan(text)) {
    const body = text.slice(sp.start, sp.end);
    if (body.includes('CrtYd"')) continue;
    const ext = padBox(body);
    if (!ext) continue;
    const layer = sideOf(body) === "B" ? "B.CrtYd" : "F.CrtYd";
    const [x0, y0, x1, y1] = [ext[0] - margin, ext[1] - margin, ext[2] + margin, ext[3] + margin];
    text = text.slice(0, sp.start) + appendTo(body, rectItem(x0, y0, x1, y1, layer)) + text.slice(sp.end);
    added[ref] = [r2(x1 - x0), r2(y1 - y0), layer];
  }
  // inverted courtyard rectangles
  let fixed = 0;
  const out: string[] = [];
  let i = 0;
  for (const [j, k] of items(text, "(fp_rect")) {
    let item = text.slice(j, k);
    const m = /\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)/.exec(item);
    if (m && item.includes('CrtYd"')) {
      const [x0, y0, x1, y1] = m.slice(1, 5).map(Number) as [number, number, number, number];
      if (x0 > x1 || y0 > y1) {
        fixed++;
        item = item.slice(0, m.index) + `(start ${pyG(Math.min(x0, x1))} ${pyG(Math.min(y0, y1))}) (end ${pyG(Math.max(x0, x1))} ${pyG(Math.max(y0, y1))})` + item.slice(m.index + m[0].length);
      }
    }
    out.push(text.slice(i, j), item);
    i = k;
  }
  out.push(text.slice(i));
  text = out.join("");
  // halos (placement base only)
  const halos: CourtyardResult["halos"] = {};
  const want = new Set(o.halo ?? []);
  if (want.size) {
    const hm = o.haloMm ?? 0.8;
    for (const [ref, sp] of bySpan(text)) {
      if (!want.has(ref)) continue;
      let body = text.slice(sp.start, sp.end);
      const ext = circleBox(body);
      if (!ext) continue;
      const own = sideOf(body) === "B" ? "B.CrtYd" : "F.CrtYd";
      body = stripLayer(body, own);
      const [x0, y0, x1, y1] = [ext[0] - hm, ext[1] - hm, ext[2] + hm, ext[3] + hm];
      text = text.slice(0, sp.start) + appendTo(body, rectItem(x0, y0, x1, y1, own)) + text.slice(sp.end);
      halos[ref] = [r2(x1 - x0), r2(y1 - y0)];
    }
  }
  return { text, added, inverted_rects_fixed: fixed, halos, refitted: {} };
}

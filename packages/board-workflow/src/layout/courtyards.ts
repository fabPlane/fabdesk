/**
 * The toolkit's `tools/add_courtyards.py`: a rectangular courtyard for every footprint with pads and none of its own,
 * inverted courtyard rectangles put right, and optional escape halos for the placement base.
 *
 * - Added courtyard: the pad extent in the footprint's own frame (a pad rotated off the axes counts as a circle of
 *   its larger size; at 90 degrees its sides swap) plus `margin` (IPC-7351 nominal 0.25 mm), on F.CrtYd / B.CrtYd by
 *   the footprint's side. Without one the placer packs parts against the pads and courtyard DRC cannot see the part.
 * - Inverted rectangles: a courtyard fp_rect stored with start > end reads as empty to tracemaker-place (it placed
 *   parts over a connector); the corners are reordered.
 * - Halo (placement base only, never the fab board): the part's own-side courtyard replaced by the pad extent (pads as
 *   circles) plus `haloMm`, so the placer leaves escape room round escape-heavy parts. tracemaker-place honours one
 *   courtyard outline per footprint: replace, don't add.
 */
import { randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import { footprintSpans } from "../edit/text";

const PAD = /\(pad\s+"[^"]*"\s+\w+\s+\w+[\s\S]*?\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)[\s\S]*?\(size ([-\d.]+) ([-\d.]+)\)/g;

export interface CourtyardResult {
  text: string;
  /** ref -> [width, height, layer] of the added rectangle. */
  added: Record<string, [number, number, string]>;
  inverted_rects_fixed: number;
  /** ref -> [width, height] of the halo. */
  halos: Record<string, [number, number]>;
}

const r2 = (x: number) => pyRound(x, 2);
const f3 = (x: number) => x.toFixed(3);
/** Python's `:g` for the corner coordinates the inverted-rect fix writes. */
const pyG = (x: number) => String(Number(x.toPrecision(6)));
const sideOf = (body: string) => (/\(layer "B\.Cu"\)/.test(body.slice(0, 600)) ? "B" : "F");

/** The extent of a footprint's pads in its own frame; `circles` counts every pad as a circle of its larger size. */
function padExtent(body: string, circles: boolean): [number, number, number, number] | null {
  const xs: number[] = [], ys: number[] = [];
  for (const m of body.matchAll(PAD)) {
    const x = Number(m[1]), y = Number(m[2]), w = Number(m[4]), h = Number(m[5]);
    const rot = Number(m[3] ?? 0) % 180;
    let hw: number, hh: number;
    if (circles || (rot !== 0 && rot !== 90)) hw = hh = Math.max(w, h) / 2;
    else [hw, hh] = rot === 0 ? [w / 2, h / 2] : [h / 2, w / 2];
    xs.push(x - hw, x + hw);
    ys.push(y - hh, y + hh);
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

const rect = (x0: number, y0: number, x1: number, y1: number, layer: string) =>
  `\n    (fp_rect (start ${f3(x0)} ${f3(y0)}) (end ${f3(x1)} ${f3(y1)}) (stroke (width 0.05) (type solid)) (fill no) (layer "${layer}") (uuid "${randomUUID()}"))`;

/** Insert `item` before a footprint body's closing paren. */
const appendTo = (body: string, item: string) => {
  const close = body.trimEnd().lastIndexOf(")");
  return body.slice(0, close).trimEnd() + item + "\n  " + body.slice(close);
};

/** Each top-level-in-footprint item of `kind` (by paren matching) in `text` from `from`. */
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

export function addCourtyards(text0: string, o: { margin?: number; halo?: string[]; haloMm?: number } = {}): CourtyardResult {
  const margin = o.margin ?? 0.25;
  let text = text0;
  const added: CourtyardResult["added"] = {};
  // footprints from the end of the file backwards, so an insertion does not move the spans still to visit
  const bySpan = (t: string) => [...footprintSpans(t)].sort((a, b) => b[1].start - a[1].start);
  for (const [ref, sp] of bySpan(text)) {
    const body = text.slice(sp.start, sp.end);
    if (body.includes('CrtYd"')) continue;
    const ext = padExtent(body, false);
    if (!ext) continue;
    const layer = sideOf(body) === "B" ? "B.CrtYd" : "F.CrtYd";
    const [x0, y0, x1, y1] = [ext[0] - margin, ext[1] - margin, ext[2] + margin, ext[3] + margin];
    text = text.slice(0, sp.start) + appendTo(body, rect(x0, y0, x1, y1, layer)) + text.slice(sp.end);
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
      const ext = padExtent(body, true);
      if (!ext) continue;
      const own = sideOf(body) === "B" ? "B.CrtYd" : "F.CrtYd";
      const spans: Array<[number, number]> = [];
      for (const kind of ["(fp_rect", "(fp_line", "(fp_poly", "(fp_circle", "(fp_arc"])
        for (const [j, k] of items(body, kind)) if (body.slice(j, k).includes(`"${own}"`)) spans.push([j, k]);
      for (const [j, k] of spans.sort((a, b) => b[0] - a[0])) body = body.slice(0, j).replace(/[ \t]+$/, "") + body.slice(k);
      const [x0, y0, x1, y1] = [ext[0] - hm, ext[1] - hm, ext[2] + hm, ext[3] + hm];
      text = text.slice(0, sp.start) + appendTo(body, rect(x0, y0, x1, y1, own)) + text.slice(sp.end);
      halos[ref] = [r2(x1 - x0), r2(y1 - y0)];
    }
  }
  return { text, added, inverted_rects_fixed: fixed, halos };
}

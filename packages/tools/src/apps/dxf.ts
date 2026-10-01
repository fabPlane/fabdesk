/**
 * Minimal DXF → SVG for the CAD drawing viewer. Covers what KiCad's DXF plotter and typical
 * mechanical drawings emit in model space: LINE, CIRCLE, ARC, LWPOLYLINE (with bulges), POLYLINE /
 * VERTEX, SPLINE (control polygon), SOLID / TRACE / 3DFACE, POINT. Text, blocks and dimensions are
 * skipped and counted. DXF's Y axis points up, so the output flips Y inside a viewBox in drawing units.
 */

export type DxfSvg = {
  svg: string;
  /** Drawn entity count. */
  entities: number;
  /** Entity types that were present but not drawn, with counts. */
  skipped: Record<string, number>;
  layers: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

type Pair = { code: number; value: string };
type Entity = { type: string; pairs: Pair[] };

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push({ code, value: lines[i + 1]!.trim() });
  }
  return out;
}

/** Entities of the ENTITIES section (whole file when there are no sections). */
function entitiesOf(pairs: Pair[]): Entity[] {
  let start = 0;
  let end = pairs.length;
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (
      pairs[i]!.code === 0 &&
      pairs[i]!.value === "SECTION" &&
      pairs[i + 1]!.value === "ENTITIES"
    ) {
      start = i + 2;
      for (let j = start; j < pairs.length; j++)
        if (pairs[j]!.code === 0 && pairs[j]!.value === "ENDSEC") {
          end = j;
          break;
        }
      break;
    }
  }
  const out: Entity[] = [];
  let cur: Entity | null = null;
  for (let i = start; i < end; i++) {
    const pr = pairs[i]!;
    if (pr.code === 0) {
      cur = { type: pr.value.toUpperCase(), pairs: [] };
      out.push(cur);
    } else cur?.pairs.push(pr);
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0): number => {
  const hit = e.pairs.find((pr) => pr.code === code);
  const v = hit ? Number(hit.value) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (e: Entity, code: number): string | undefined =>
  e.pairs.find((pr) => pr.code === code)?.value;

const f = (n: number): string => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? "0" : String(r);
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Pt = { x: number; y: number; bulge: number };

/** Vertices with bulges (LWPOLYLINE groups 10/20/42 in order). */
function lwVertices(e: Entity): Pt[] {
  const pts: Pt[] = [];
  for (const pr of e.pairs) {
    if (pr.code === 10) pts.push({ x: Number(pr.value), y: 0, bulge: 0 });
    else if (pr.code === 20 && pts.length) pts[pts.length - 1]!.y = Number(pr.value);
    else if (pr.code === 42 && pts.length) pts[pts.length - 1]!.bulge = Number(pr.value);
  }
  return pts.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
}

/** SVG path for a polyline whose segments may be bulged arcs. */
function polyPath(pts: Pt[], closed: boolean): string {
  if (pts.length === 0) return "";
  let d = `M${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (a.bulge) {
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      const theta = 4 * Math.atan(Math.abs(a.bulge));
      const r = chord / (2 * Math.sin(theta / 2));
      const large = theta > Math.PI ? 1 : 0;
      // Positive bulge is counter-clockwise in DXF's Y-up space; SVG's sweep flag is in the same
      // (unflipped) coordinates here because the flip is applied as a group transform.
      const sweep = a.bulge > 0 ? 1 : 0;
      d += ` A${f(r)} ${f(r)} 0 ${large} ${sweep} ${f(b.x)} ${f(b.y)}`;
    } else d += ` L${f(b.x)} ${f(b.y)}`;
  }
  return closed ? `${d} Z` : d;
}

export function dxfToSvg(text: string, opts: { stroke?: string } = {}): DxfSvg {
  const entities = entitiesOf(pairsOf(text));
  const shapes: string[] = [];
  const skipped: Record<string, number> = {};
  const layers = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, r = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
  };
  const push = (e: Entity, el: string) => {
    const layer = str(e, 8) ?? "0";
    layers.add(layer);
    shapes.push(el.replace(/^<(\w+)/, `<$1 data-layer="${esc(layer)}"`));
  };

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    switch (e.type) {
      case "LINE": {
        const [x1, y1, x2, y2] = [num(e, 10), num(e, 20), num(e, 11), num(e, 21)];
        grow(x1, y1);
        grow(x2, y2);
        push(e, `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`);
        break;
      }
      case "CIRCLE": {
        const [cx, cy, r] = [num(e, 10), num(e, 20), num(e, 40)];
        grow(cx, cy, r);
        push(e, `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}"/>`);
        break;
      }
      case "ARC": {
        const [cx, cy, r] = [num(e, 10), num(e, 20), num(e, 40)];
        const a0 = (num(e, 50) * Math.PI) / 180;
        let a1 = (num(e, 51) * Math.PI) / 180;
        if (a1 <= a0) a1 += 2 * Math.PI;
        const sx = cx + r * Math.cos(a0);
        const sy = cy + r * Math.sin(a0);
        const ex = cx + r * Math.cos(a1);
        const ey = cy + r * Math.sin(a1);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        grow(cx, cy, r);
        push(e, `<path d="M${f(sx)} ${f(sy)} A${f(r)} ${f(r)} 0 ${large} 1 ${f(ex)} ${f(ey)}"/>`);
        break;
      }
      case "LWPOLYLINE": {
        const pts = lwVertices(e);
        for (const pt of pts) grow(pt.x, pt.y);
        const width = num(e, 43, 0);
        const d = polyPath(pts, (num(e, 70) & 1) === 1);
        if (d)
          push(
            e,
            `<path d="${d}"${width > 0 ? ` style="stroke-width:${f(width)};vector-effect:none"` : ""}/>`,
          );
        break;
      }
      case "POLYLINE": {
        const closed = (num(e, 70) & 1) === 1;
        const pts: Pt[] = [];
        let j = i + 1;
        for (; j < entities.length && entities[j]!.type === "VERTEX"; j++) {
          const v = entities[j]!;
          pts.push({ x: num(v, 10), y: num(v, 20), bulge: num(v, 42) });
        }
        if (entities[j]?.type === "SEQEND") j++;
        i = j - 1;
        for (const pt of pts) grow(pt.x, pt.y);
        const d = polyPath(pts, closed);
        if (d) push(e, `<path d="${d}"/>`);
        break;
      }
      case "SPLINE": {
        const pts = lwVertices({
          type: e.type,
          pairs: e.pairs.filter((pr) => pr.code === 10 || pr.code === 20),
        });
        for (const pt of pts) grow(pt.x, pt.y);
        const d = polyPath(pts, (num(e, 70) & 1) === 1);
        if (d) push(e, `<path d="${d}"/>`);
        break;
      }
      case "SOLID":
      case "TRACE":
      case "3DFACE": {
        // Corner order for SOLID/TRACE is 1-2-4-3 (bow-tie otherwise).
        const c = [10, 11, 12, 13].map((k) => ({ x: num(e, k), y: num(e, k + 10), bulge: 0 }));
        const ring = e.type === "3DFACE" ? c : [c[0]!, c[1]!, c[3]!, c[2]!];
        for (const pt of ring) grow(pt.x, pt.y);
        push(e, `<path class="fill" d="${polyPath(ring, true)}"/>`);
        break;
      }
      case "POINT": {
        const [x, y] = [num(e, 10), num(e, 20)];
        grow(x, y);
        push(e, `<circle class="fill" cx="${f(x)}" cy="${f(y)}" r="0.1"/>`);
        break;
      }
      case "VERTEX":
      case "SEQEND":
      case "EOF":
        break;
      default:
        skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
  }

  const bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  const w = bounds ? Math.max(bounds.maxX - bounds.minX, 1e-3) : 100;
  const h = bounds ? Math.max(bounds.maxY - bounds.minY, 1e-3) : 100;
  const pad = Math.max(w, h) * 0.02;
  const vx = (bounds?.minX ?? 0) - pad;
  // After flipping Y the drawing spans [-maxY, -minY].
  const vy = -(bounds?.maxY ?? 100) - pad;
  const stroke = opts.stroke ?? "currentColor";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vx)} ${f(vy)} ${f(w + 2 * pad)} ${f(h + 2 * pad)}" ` +
    `width="${f(w + 2 * pad)}mm" height="${f(h + 2 * pad)}mm">` +
    `<style>*{fill:none;stroke:${esc(stroke)};stroke-width:1px;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}.fill{fill:${esc(stroke)}}</style>` +
    `<g transform="scale(1,-1)">${shapes.join("")}</g></svg>`;
  return { svg, entities: shapes.length, skipped, layers: [...layers].sort(), bounds };
}

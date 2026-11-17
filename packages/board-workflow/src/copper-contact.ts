import polygonClipping, { type Polygon } from "polygon-clipping";
/** Layer-local copper geometry. Callers use one coordinate unit throughout (mm or nm).
 * Arcs are supplied as tessellated centrelines; stroke width supplies their copper extent.
 */
export type ContactPoint = { x: number; y: number };
export type ContactPolygon = { outline: ContactPoint[]; holes?: ContactPoint[][];
  /** Outer-only growth for tessellated curved polygon boundaries. */
  padding?: number;
};
export type CopperGeometry = { path: ContactPoint[]; width: number } | { polygon: ContactPolygon; radius?: number };
/** Explicit proof allow-list. Adapters must certify the source kind, not infer
 * exactness from the envelope's representation. New/unknown kinds default false.
 * Via disks include drill voids and are deliberately absent, as are all arcs. */
export type ExactCopperKind = "straight-track" | "circle-pad" | "rect-pad" | "oval-pad" | "roundrect-pad" | "current-fill";
export type CopperShape = CopperGeometry & {
  exact?: ExactCopperKind;
  /** Original stroke used for endpoint incidence; the outer circle is not a centreline. */
  centerline?: { path: ContactPoint[]; width: number };
  /** Legacy inner bounds cannot authorize proofs; null also vetoes a certificate. */
  inner?: CopperGeometry | null;
};

/** One deliberately blunt retention envelope. Symmetrize the box about the
 * source anchor: half a diagonal of an off-centre box alone would miss copper.
 * padding and margin use the caller's coordinate unit; neither proves contact. */
export function copperOuterCircle(points: ContactPoint[], padding = 0, margin = .000001, anchor?: ContactPoint): CopperShape {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const center = anchor ?? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  const hx = Math.max(0, ...points.map(p => Math.abs(p.x - center.x))) + padding;
  const hy = Math.max(0, ...points.map(p => Math.abs(p.y - center.y))) + padding;
  return { path: [center], width: 2 * (Math.hypot(hx, hy) + margin), inner: null };
}

function exactGeometry(shape: CopperShape): CopperGeometry | null {
  if (shape.inner === null || ("polygon" in shape && shape.polygon.padding)) return null;
  switch (shape.exact) {
    case "straight-track":
      return "path" in shape && shape.path.length === 2 ? shape : null;
    case "circle-pad":
    case "oval-pad":
      return "path" in shape && shape.path.length <= 2 ? shape : null;
    case "rect-pad":
    case "roundrect-pad":
    case "current-fill":
      return "polygon" in shape ? shape : null;
    default:
      return null;
  }
}
// No positive epsilon here: growth belongs only to the outer contact query.
const GEOMETRY_EPSILON = 0;

export function contactDistance(a: ContactPoint, b: ContactPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegmentDistance(p: ContactPoint, a: ContactPoint, b: ContactPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return contactDistance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return contactDistance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function orientation(a: ContactPoint, b: ContactPoint, c: ContactPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(
  a: ContactPoint,
  b: ContactPoint,
  c: ContactPoint,
  d: ContactPoint,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  )
    return true;
  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && pointSegmentDistance(c, a, b) <= GEOMETRY_EPSILON) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointSegmentDistance(d, a, b) <= GEOMETRY_EPSILON) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointSegmentDistance(a, c, d) <= GEOMETRY_EPSILON) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointSegmentDistance(b, c, d) <= GEOMETRY_EPSILON)
  );
}

function segmentDistance(a: ContactPoint, b: ContactPoint, c: ContactPoint, d: ContactPoint): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function pointInRing(point: ContactPoint, ring: ContactPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (pointSegmentDistance(point, a, b) <= GEOMETRY_EPSILON) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function ringDistance(point: ContactPoint, ring: ContactPoint[]): number {
  let closest = Infinity;
  for (let i = 0; i < ring.length; i++)
    closest = Math.min(
      closest,
      pointSegmentDistance(point, ring[i]!, ring[(i + 1) % ring.length]!),
    );
  return closest;
}

export function pointPolygonDistance(point: ContactPoint, polygon: ContactPolygon): number {
  if (!polygon.outline.length) return Infinity;
  if (!pointInRing(point, polygon.outline)) return ringDistance(point, polygon.outline);
  for (const hole of polygon.holes ?? []) {
    if (pointInRing(point, hole)) return ringDistance(point, hole);
  }
  return 0;
}

function segmentPolygonDistance(a: ContactPoint, b: ContactPoint, polygon: ContactPolygon): number {
  if (pointPolygonDistance(a, polygon) === 0 || pointPolygonDistance(b, polygon) === 0) return 0;
  let closest = Infinity;
  for (const ring of [polygon.outline, ...(polygon.holes ?? [])])
    for (let i = 0; i < ring.length; i++)
      closest = Math.min(closest, segmentDistance(a, b, ring[i]!, ring[(i + 1) % ring.length]!));
  return closest;
}


function edges(p: ContactPolygon): Array<[ContactPoint, ContactPoint]> {
  return [p.outline, ...(p.holes ?? [])].flatMap(r => r.map((a, i): [ContactPoint, ContactPoint] => [a, r[(i + 1) % r.length]!]));
}

/** True when the two copper shapes contact on the specified layer. */
export function copperShapesTouch<L>(a: CopperShape, aLayers: readonly L[], b: CopperShape, bLayers: readonly L[], layer: L, tolerance = 0): boolean {
  if (!aLayers.includes(layer) || !bLayers.includes(layer)) return false;
  if ("polygon" in a && "polygon" in b) {
    const reach = (a.radius ?? 0) + (a.polygon.padding ?? 0) + (b.radius ?? 0) + (b.polygon.padding ?? 0) + tolerance;
    return a.polygon.outline.some(p => pointPolygonDistance(p, b.polygon) <= reach) ||
      b.polygon.outline.some(p => pointPolygonDistance(p, a.polygon) <= reach) ||
      edges(a.polygon).some(([p, q]) => edges(b.polygon).some(([r, s]) => segmentDistance(p, q, r, s) <= reach));
  }
  if ("polygon" in a) return copperShapesTouch(b, bLayers, a, aLayers, layer, tolerance);
  if ("polygon" in b) {
    const reach = a.width / 2 + (b.radius ?? 0) + (b.polygon.padding ?? 0) + tolerance;
    return a.path.length === 1 ? pointPolygonDistance(a.path[0]!, b.polygon) <= reach :
      a.path.some((p, i) => i > 0 && segmentPolygonDistance(a.path[i - 1]!, p, b.polygon) <= reach);
  }
  const reach = (a.width + b.width) / 2 + tolerance;
  const segments = (path: ContactPoint[]): Array<[ContactPoint, ContactPoint]> => path.length === 1 ? [[path[0]!, path[0]!]] : path.slice(1).map((p, i) => [path[i]!, p]);
  return segments(a.path).some(([p, q]) => segments(b.path).some(([r, s]) => segmentDistance(p, q, r, s) <= reach));
}

/** Outer contacts retain copper; only certified exact contacts can prove an alternate path.
 * Numerical/board tolerance expands mayTouch only, never surelyTouches. */
export function copperContact<L>(a: CopperShape, aLayers: readonly L[], b: CopperShape, bLayers: readonly L[], layer: L, tolerance = 0): { mayTouch: boolean; surelyTouches: boolean } {
  const mayTouch = copperShapesTouch(a, aLayers, b, bLayers, layer, tolerance);
  const ai = exactGeometry(a);
  const bi = exactGeometry(b);
  return { mayTouch, surelyTouches: mayTouch && ai !== null && bi !== null && copperShapesTouch(ai, aLayers, bi, bLayers, layer) };
}

/** Exact straight-boundary subtraction handles crossing/enclosing keepouts.
 * Chord rings with padding are outer bounds, not valid exclusion interiors.
 * Decline the entire operation if either side is uncertain: clipping the raw
 * rings then forwarding padding can lose the uncertainty band at new edges. */
export function subtractCopperKeepouts(polygon: ContactPolygon, keepouts: ContactPolygon[]): ContactPolygon[] {
  if (!keepouts.length || polygon.padding || keepouts.some(p => p.padding)) return [polygon];
  const rings = (p: ContactPolygon): Polygon => [p.outline, ...(p.holes ?? [])].map(r => r.map(({ x, y }) => [x, y]));
  const result = polygonClipping.difference(rings(polygon), ...keepouts.map(rings));
  return result.map(([outline, ...holes]) => ({
    outline: (outline ?? []).map(([x, y]) => ({ x, y })),
    holes: holes.map(r => r.map(([x, y]) => ({ x, y }))),
  }));
}

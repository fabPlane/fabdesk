import type { MechanicalBox } from "./mechanical-design";

export type CablePoint = { x: number; y: number; z: number };
const axes = ["x", "y", "z"] as const;
const orders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const distance = (a: CablePoint, b: CablePoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const bounds = (b: MechanicalBox, pad: number) => ({
  min: { x: b.x - pad, y: b.y - pad, z: b.z - pad },
  max: { x: b.x + b.width + pad, y: b.y + b.depth + pad, z: b.z + b.height + pad },
});
/** Inclusive segment/AABB intersection. Touching reserved space is not clearance. */
function intersects(a: CablePoint, b: CablePoint, box: ReturnType<typeof bounds>) {
  let low = 0,
    high = 1;
  for (const k of axes) {
    const delta = b[k] - a[k];
    if (Math.abs(delta) < 1e-8) {
      if (a[k] < box.min[k] || a[k] > box.max[k]) return false;
    } else {
      const t1 = (box.min[k] - a[k]) / delta,
        t2 = (box.max[k] - a[k]) / delta;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return true;
}
function simplify(points: CablePoint[]) {
  const result: CablePoint[] = [];
  for (const p of points) {
    if (result.length && distance(result.at(-1)!, p) < 1e-6) continue;
    if (result.length > 1) {
      const a = result.at(-2)!,
        b = result.at(-1)!;
      if (Math.abs(distance(a, b) + distance(b, p) - distance(a, p)) < 1e-6) result.pop();
    }
    result.push(p);
  }
  return result;
}
function dogleg(a: CablePoint, b: CablePoint, order: number[]) {
  const points = [a];
  let p = a;
  for (const index of order) {
    const key = axes[index]!;
    p = { ...p, [key]: b[key] };
    points.push(p);
  }
  return points;
}

/** Bounded, conservative corridor search, not a flexible-cable simulation.
 * Axis-aligned paths reserve a full bend-radius cube at each corner. Length
 * includes sharp corners (an upper bound after rounding), plus caller slack.
 * A failed search means no candidate found, not proof that routing is impossible.
 */
export function routeCable(
  a: CablePoint,
  b: CablePoint,
  cavity: MechanicalBox,
  obstacles: MechanicalBox[],
  diameter: number,
  bendRadius: number,
  clearance: number,
) {
  const padding = diameter / 2 + clearance;
  const room = bounds(cavity, -padding),
    blocked = obstacles.map((o) => bounds(o, padding));
  const inside = (p: CablePoint, extra = 0) =>
    axes.every((k) => p[k] - extra >= room.min[k] && p[k] + extra <= room.max[k]);
  let best: { points: CablePoint[]; length: number; bends: number } | null = null;
  let tested = 0;
  const consider = (raw: CablePoint[]) => {
    tested++;
    const points = simplify(raw);
    if (points.length < 2 || points.some((p) => !inside(p))) return;
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1]!,
        end = points[i]!,
        segment = distance(start, end);
      // Each 90-degree bend consumes one radius from both adjacent segments.
      const needed = (i > 1 ? bendRadius : 0) + (i < points.length - 1 ? bendRadius : 0);
      if (segment + 1e-6 < needed || blocked.some((box) => intersects(start, end, box))) return;
      length += segment;
    }
    for (const p of points.slice(1, -1)) {
      if (
        !inside(p, bendRadius) ||
        obstacles.some((o) => intersects(p, p, bounds(o, padding + bendRadius)))
      )
        return;
    }
    if (!best || length < best.length - 1e-6) best = { points, length, bends: points.length - 2 };
  };
  for (const order of orders) consider(dogleg(a, b, order));
  // One detour plane at each obstacle face, plus room edges. Bounded even for
  // dense PCBs: return the best route found and expose the search limit.
  for (const axis of axes) {
    const planes = new Set([room.min[axis] + bendRadius, room.max[axis] - bendRadius]);
    for (const box of blocked) {
      planes.add(box.min[axis] - bendRadius - 0.01);
      planes.add(box.max[axis] + bendRadius + 0.01);
    }
    for (const plane of planes) {
      if (tested >= 2400) break;
      const entry = { ...a, [axis]: plane },
        exit = { ...b, [axis]: plane };
      for (const order of orders) consider([a, ...dogleg(entry, exit, order), b]);
    }
  }
  return {
    route: best as { points: CablePoint[]; length: number; bends: number } | null,
    tested,
    limited: tested >= 2400,
  };
}

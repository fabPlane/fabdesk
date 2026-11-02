import type { Manifold } from "@fabdesk/kicad/enclosure-solid";

type Bounds = ReturnType<Manifold["boundingBox"]>;

/** Conservative lower bound: overlapping boxes still require the exact solid check. */
export function boundsSeparation(a: Bounds, b: Bounds): number {
  return Math.hypot(
    ...[0, 1, 2].map((axis) =>
      Math.max(0, a.min[axis]! - b.max[axis]!, b.min[axis]! - a.max[axis]!),
    ),
  );
}

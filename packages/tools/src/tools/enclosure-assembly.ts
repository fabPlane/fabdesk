import type { Manifold } from "@fabdesk/kicad/enclosure-solid";
import { boundsSeparation } from "./enclosure-bounds";

/** Bounded samples of a rigid upward removal path (reverse of downward assembly).
 * Clear samples are not a continuous sweep or proof of an assembly sequence. */
export function sampleVerticalAssembly(
  moving: Manifold,
  barriers: Array<{ path: string; solid: Manifold }>,
  signal?: AbortSignal,
) {
  const bottom = moving.boundingBox().min[2];
  const distance = Math.max(1, ...barriers.map((b) => b.solid.boundingBox().max[2] - bottom + 1));
  const samples = 12;
  const bounds = barriers.map((b) => b.solid.boundingBox());
  for (let step = 1; step <= samples; step++) {
    signal?.throwIfAborted();
    const offset = (distance * step) / samples;
    const shifted = moving.translate([0, 0, offset]);
    try {
      const movingBounds = shifted.boundingBox();
      for (const [index, barrier] of barriers.entries()) {
        if (boundsSeparation(movingBounds, bounds[index]!) > 0) continue;
        const hit = shifted.intersect(barrier.solid);
        try {
          if (hit.volume() > 0.01) {
            const bounds = hit.boundingBox();
            return {
              samplesTested: step,
              samples,
              distance,
              obstruction: {
                path: barrier.path,
                offset,
                volume: hit.volume(),
                bounds,
              },
            };
          }
        } finally {
          hit.delete();
        }
      }
    } finally {
      shifted.delete();
    }
  }
  return { samplesTested: samples, samples, distance, obstruction: null };
}

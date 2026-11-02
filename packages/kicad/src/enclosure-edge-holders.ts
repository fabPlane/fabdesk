import type { MechanicalBox, MechanicalDesign } from "@fabdesk/protocol";
import type { EnclosureSolid } from "./enclosure";

export const EDGE_HOLDER_FIT = { play: 0.25, pad: 2, capture: 0.5, length: 4, wall: 1.5 } as const;

export function edgeHolderFit(allowance = 0) {
  return {
    ...EDGE_HOLDER_FIT,
    play: EDGE_HOLDER_FIT.play + 2 * allowance,
    // Keep 0.25 mm engagement after maximum lateral play and opposing surface error.
    capture: EDGE_HOLDER_FIT.capture + 4 * allowance,
  };
}

/** Four distributed supports/capture pegs, plus low stops on the other two edges.
 * Search is bounded and never relaxes the supplied keepouts to find a solution. */
export function findEdgeHolders(
  pcb: MechanicalBox,
  space: MechanicalDesign["space"],
  clear: (solid: EnclosureSolid) => boolean,
  allowance = 0,
): EnclosureSolid[] | null {
  // A 3 mm contact length can fit between connectors on a dense narrow board.
  // Keep the 2 mm underside depth and full capture profile; never reduce keepouts.
  for (const length of [4, 3]) {
    const found = searchEdgeHolders(pcb, space, clear, allowance, length);
    if (found) return found;
  }
  return null;
}

function searchEdgeHolders(
  pcb: MechanicalBox,
  space: MechanicalDesign["space"],
  clear: (solid: EnclosureSolid) => boolean,
  allowance: number,
  length: number,
): EnclosureSolid[] | null {
  const { play, pad, capture, wall } = edgeHolderFit(allowance);
  const top = pcb.z + pcb.height,
    ceiling = space.floor + space.height;
  // Low stops must still engage after the PCB rises through its allowed play.
  const stopTop = pcb.z + Math.max(pcb.height / 2, play + 2 * allowance + 0.2);
  if (stopTop > top - 0.1) return null;
  const box = (
    name: string,
    role: "standoff" | "lid",
    x: number,
    y: number,
    z: number,
    width: number,
    depth: number,
    height: number,
  ): EnclosureSolid => ({
    name,
    role,
    kind: "box",
    min: { x, y, z },
    max: { x: x + width, y: y + depth, z: z + height },
  });
  type Side = "minX" | "maxX" | "minY" | "maxY";
  const along = (side: Side) =>
    side.endsWith("X") ? { start: pcb.y, span: pcb.depth } : { start: pcb.x, span: pcb.width };
  function pieces(side: Side, center: number, stop = false) {
    const vertical = side.endsWith("X"),
      positive = side.startsWith("max");
    const edge = vertical ? pcb.x + (positive ? pcb.width : 0) : pcb.y + (positive ? pcb.depth : 0);
    const fence = positive ? edge + play : edge - play - wall;
    const inner = positive ? edge - pad : edge;
    const origin = Math.min(inner, fence),
      extent = pad + play + wall;
    // The lid peg is anchored outside the PCB rather than being a slender
    // column on top of it. Capture scales with play and opposing surface error;
    // printing and load-bearing still need a sample.
    const captureOrigin = positive ? edge - capture : fence;
    // Side fences touch no PCB copper; the clearance is measured from the board edge.
    const make = (
      name: string,
      role: "standoff" | "lid",
      at: number,
      width: number,
      z: number,
      height: number,
    ) =>
      box(
        name,
        role,
        vertical ? at : center - length / 2,
        vertical ? center - length / 2 : at,
        z,
        vertical ? width : length,
        vertical ? length : width,
        height,
      );
    if (stop)
      return [make("EdgeStop", "standoff", fence, wall, space.floor, stopTop - space.floor)];
    return [
      make("EdgeFoot", "standoff", origin, extent, space.floor, pcb.z - space.floor),
      make("EdgeFence", "standoff", fence, wall, pcb.z, pcb.height),
      make(
        "EdgeCapture",
        "lid",
        captureOrigin,
        capture + play + wall,
        top + play,
        ceiling + space.lid - top - play,
      ),
    ];
  }
  const positions = (side: Side) => {
    const { start, span } = along(side);
    return Array.from({ length: 65 }, (_, i) => start + length / 2 + ((span - length) * i) / 64);
  };
  function pair(side: Side) {
    const candidates = positions(side)
      .map((center) => ({ center, solids: pieces(side, center) }))
      .filter((c) => c.solids.every(clear));
    const first = candidates[0],
      last = candidates.at(-1),
      { start, span } = along(side);
    if (
      !first ||
      !last ||
      last.center - first.center < Math.max(length, span / 4) ||
      first.center > start + span / 2 ||
      last.center < start + span / 2
    )
      return null;
    return [...first.solids, ...last.solids];
  }
  // Prefer supports along the longer edges. All four captures must fit before any
  // geometry is accepted; a board with no safe strips remains blocked.
  const axes: Side[][] =
    pcb.width >= pcb.depth
      ? [
          ["minY", "maxY", "minX", "maxX"],
          ["minX", "maxX", "minY", "maxY"],
        ]
      : [
          ["minX", "maxX", "minY", "maxY"],
          ["minY", "maxY", "minX", "maxX"],
        ];
  for (const [a, b, c, d] of axes) {
    const left = pair(a!),
      right = pair(b!);
    if (!left || !right) continue;
    const stops = [c!, d!].map((side) => {
      const { start, span } = along(side);
      return positions(side)
        .sort((a, b) => Math.abs(a - start - span / 2) - Math.abs(b - start - span / 2))
        .map((center) => pieces(side, center, true))
        .find((solids) => solids.every(clear));
    });
    if (stops.some((s) => !s)) continue;
    return [...left, ...right, ...stops.flatMap((s) => s!)];
  }
  return null;
}

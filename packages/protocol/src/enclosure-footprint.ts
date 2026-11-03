import type { MechanicalDesign } from "./mechanical-design";

type Bounds = {
  min: { x: number; y: number; z?: number };
  max: { x: number; y: number; z?: number };
};
type Point = [number, number];

/** Outside dimensions include projecting hardware, not only the cavity and walls. */
export function enclosureFootprint(d: MechanicalDesign, hardware: readonly Bounds[] = []) {
  const s = d.space;
  const minX = Math.min(s.x - s.wall, ...hardware.map((p) => p.min.x));
  const minY = Math.min(s.y - s.wall, ...hardware.map((p) => p.min.y));
  const maxX = Math.max(s.x + s.width + s.wall, ...hardware.map((p) => p.max.x));
  const maxY = Math.max(s.y + s.depth + s.wall, ...hardware.map((p) => p.max.y));
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    depth: maxY - minY,
    height:
      Math.max(s.floor + s.height + s.lid, ...hardware.map((p) => p.max.z ?? 0)) -
      Math.min(0, ...hardware.map((p) => p.min.z ?? 0)),
  };
}

export function fitsEnclosureSizeLimit(
  d: MechanicalDesign,
  size: { width: number; depth: number },
) {
  return (
    !d.layoutLimit ||
    (size.width <= d.layoutLimit.width + 1e-5 && size.depth <= d.layoutLimit.depth + 1e-5)
  );
}

/** Shared by the layout search and the real hardware generator. */
export function lidScrewCandidates(d: MechanicalDesign): Point[][] {
  if (d.closure?.kind !== "screws") return [];
  const s = d.space,
    diameter = d.closure.bossDiameter,
    r = diameter / 2;
  const candidates: Point[][] = [];
  const offsets = (length: number) =>
    Array.from({ length: 9 }, (_, i) => r + 1 + ((length / 2 - 2 * r - 2) * i) / 8);
  if (s.depth >= diameter * 2 + 4)
    for (const offset of offsets(s.depth))
      candidates.push(
        [s.x - s.wall - r + 0.8, s.x + s.width + s.wall + r - 0.8].flatMap((x) =>
          [s.y + offset, s.y + s.depth - offset].map((y): Point => [x, y]),
        ),
      );
  if (s.width >= diameter * 2 + 4)
    for (const offset of offsets(s.width))
      candidates.push(
        [s.y - s.wall - r + 0.8, s.y + s.depth + s.wall + r - 0.8].flatMap((y) =>
          [s.x + offset, s.x + s.width - offset].map((x): Point => [x, y]),
        ),
      );
  return candidates;
}

export function lidScrewFootprint(d: MechanicalDesign, points: readonly Point[]) {
  const r = (d.closure?.bossDiameter ?? 0) / 2;
  return enclosureFootprint(
    d,
    points.map(([x, y]) => ({
      min: { x: x - r, y: y - r },
      max: { x: x + r, y: y + r },
    })),
  );
}

export function enclosureFitsSizeLimit(d: MechanicalDesign) {
  if (d.closure?.kind !== "screws") return fitsEnclosureSizeLimit(d, enclosureFootprint(d));
  return lidScrewCandidates(d).some((points) =>
    fitsEnclosureSizeLimit(d, lidScrewFootprint(d, points)),
  );
}

/** Try each permitted lug orientation at the exact outside limit, including fractional sizes. */
export function enclosureInteriorLimits(d: MechanicalDesign): Array<[number, number]> {
  if (!d.layoutLimit) return [];
  const w = d.layoutLimit.width - 2 * d.space.wall;
  const h = d.layoutLimit.depth - 2 * d.space.wall;
  const extension = d.closure?.kind === "screws" ? 2 * (d.closure.bossDiameter - 0.8) : 0;
  return (
    extension
      ? [
          [w - extension, h],
          [w, h - extension],
        ]
      : [[w, h]]
  ).filter(([x, y]) => x! > 0 && y! > 0) as Array<[number, number]>;
}

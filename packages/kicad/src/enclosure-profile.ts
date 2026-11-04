import earcut, { flatten } from "earcut";
import polygonClipping from "polygon-clipping";
import { openingContour, type ProfilePoint } from "@fabdesk/protocol";
import type { BoardEdge } from "./board-features";
import type { EnclosureSolid, EnclosureCutout } from "./enclosure";

export type Profile = { axis: "x" | "y"; rings: ProfilePoint[][] };
export type Vertex = { x: number; y: number; z: number };
export type Triangle = [Vertex, Vertex, Vertex];
type Box = { min: Vertex; max: Vertex };

export function profileWall(
  name: string,
  edge: BoardEdge,
  wall: Box,
  rectangles: Box[],
  rounded: EnclosureCutout[],
): EnclosureSolid[] {
  const axis = edge.endsWith("X") ? "x" : "y";
  const along = axis === "x" ? "y" : "x";
  const rect = (b: Box): ProfilePoint[] => [
    [b.min[along], b.min.z],
    [b.max[along], b.min.z],
    [b.max[along], b.max.z],
    [b.min[along], b.max.z],
  ];
  const holes = [
    ...rectangles.map(rect),
    ...rounded.map((c) =>
      openingContour(c.widthMm, c.heightMm, c.shape).map(
        ([u, v]): ProfilePoint => [u + c.center[along], v + c.center.z],
      ),
    ),
  ];
  const polygons = polygonClipping.difference([rect(wall)], ...holes.map((h) => [h]));
  return polygons.map((poly, i) => {
    const rings = poly.map((r) => r.slice(0, -1) as ProfilePoint[]);
    const points = rings.flat();
    return {
      name: `${name}_${i + 1}`,
      kind: "profile",
      role: "wall",
      min: {
        ...wall.min,
        [along]: Math.min(...points.map((p) => p[0])),
        z: Math.min(...points.map((p) => p[1])),
      },
      max: {
        ...wall.max,
        [along]: Math.max(...points.map((p) => p[0])),
        z: Math.max(...points.map((p) => p[1])),
      },
      profile: { axis, rings },
    };
  });
}

/** Watertight extrusion of a polygon with holes. Shared cap/boundary vertices avoid T junctions. */
export function profileTriangles(s: EnclosureSolid): Triangle[] {
  if (!s.profile) return [];
  const { axis, rings } = s.profile;
  const data = flatten(rings),
    indices = earcut(data.vertices, data.holes, data.dimensions);
  const points = rings.flat(),
    triangles: Triangle[] = [];
  const point = (p: ProfilePoint, w: number): Vertex =>
    axis === "x" ? { x: w, y: p[0], z: p[1] } : { x: p[0], y: w, z: p[1] };
  const add = (a: Vertex, b: Vertex, c: Vertex) =>
    triangles.push(axis === "x" ? [a, b, c] : [a, c, b]);
  const z0 = s.min[axis],
    z1 = s.max[axis];
  const emit = (a: ProfilePoint, b: ProfilePoint, c: ProfilePoint): void => {
    // Earcut may omit collinear boundary vertices. Split any skipped vertex on a cap edge.
    for (const [p, q, other] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as [ProfilePoint, ProfilePoint, ProfilePoint][]) {
      const dx = q[0] - p[0],
        dy = q[1] - p[1],
        length = dx * dx + dy * dy;
      const between = points.find((v) => {
        if (
          v[0] < Math.min(p[0], q[0]) - 1e-9 ||
          v[0] > Math.max(p[0], q[0]) + 1e-9 ||
          v[1] < Math.min(p[1], q[1]) - 1e-9 ||
          v[1] > Math.max(p[1], q[1]) + 1e-9
        )
          return false;
        const t = ((v[0] - p[0]) * dx + (v[1] - p[1]) * dy) / length;
        return t > 1e-8 && t < 1 - 1e-8 && Math.abs(dx * (v[1] - p[1]) - dy * (v[0] - p[0])) < 1e-9;
      });
      if (between) {
        emit(p, between, other);
        emit(between, q, other);
        return;
      }
    }
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12) return;
    add(point(a, z1), point(b, z1), point(c, z1));
    add(point(a, z0), point(c, z0), point(b, z0));
  };
  for (let i = 0; i < indices.length; i += 3)
    emit(points[indices[i]!]!, points[indices[i + 1]!]!, points[indices[i + 2]!]!);
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      add(point(a, z0), point(b, z0), point(b, z1));
      add(point(a, z0), point(b, z1), point(a, z1));
    }
  return triangles;
}

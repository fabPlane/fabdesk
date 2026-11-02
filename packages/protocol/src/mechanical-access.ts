import {
  defaultConnectorAccess,
  type MechanicalBox,
  type MechanicalDesign,
} from "./mechanical-design";
import type { ConnectorFace } from "./connector-opening";
import { routeCable } from "./cable-route";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
export type MechanicalAccessBoard = {
  placement: MechanicalDesign["boards"][number];
  features: {
    thicknessMm: number;
    connectors?: Array<{
      ref: string;
      x: number;
      y: number;
      edge: "minX" | "maxX" | "minY" | "maxY";
      footprint?: string;
      bounds?: Rect;
      heightMm: number;
      face?: ConnectorFace;
    }>;
    outline?: Rect;
    components?: Array<{ ref: string; bottom?: boolean; bounds?: Rect; heightMm?: number }>;
  };
};
export function accessPoint(b: MechanicalAccessBoard, ref: string) {
  const c = b.features.connectors?.find((c) => c.ref === ref);
  if (!c) return null;
  const a = (b.placement.rotation * Math.PI) / 180;
  return {
    x: b.placement.x + c.x * Math.cos(a) - c.y * Math.sin(a),
    y: b.placement.y + c.x * Math.sin(a) + c.y * Math.cos(a),
    z:
      b.placement.z +
      (b.features.components?.some((p) => p.ref === ref && p.bottom)
        ? -c.heightMm / 2
        : b.features.thicknessMm + c.heightMm / 2),
  };
}
export function cableAssessments(
  d: MechanicalDesign,
  boards: MechanicalAccessBoard[],
  route = false,
) {
  const reserved: MechanicalBox[] = [];
  return (d.connections ?? []).map((c) => {
    const from = boards.find((b) => b.placement.path === c.from.boardPath),
      to = boards.find((b) => b.placement.path === c.to.boardPath);
    const a = from && accessPoint(from, c.from.ref),
      b = to && accessPoint(to, c.to.ref);
    const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null;
    const obstacles = route && c.routing ? [...cableObstacles(d, boards, c), ...reserved] : [];
    const routing =
      route && c.routing && a && b
        ? routeCable(
            a,
            b,
            {
              name: "Interior",
              x: d.space.x,
              y: d.space.y,
              z: d.space.floor,
              width: d.space.width,
              depth: d.space.depth,
              height: d.space.height,
            },
            obstacles,
            c.routing.diameter,
            c.routing.bendRadius,
            d.space.clearance + 2 * (d.fitAllowance ?? 0),
          )
        : null;
    const length = routing ? (routing.route?.length ?? null) : distance;
    if (routing?.route && c.routing) {
      const points = routing.route.points,
        radius = c.routing.diameter / 2;
      for (let i = 1; i < points.length; i++) {
        const start = points[i - 1]!,
          end = points[i]!;
        reserved.push({
          name: `Cable ${c.id}`,
          x: Math.min(start.x, end.x) - radius,
          y: Math.min(start.y, end.y) - radius,
          z: Math.min(start.z, end.z) - radius,
          width: Math.abs(end.x - start.x) + 2 * radius,
          depth: Math.abs(end.y - start.y) + 2 * radius,
          height: Math.abs(end.z - start.z) + 2 * radius,
        });
      }
      for (const point of points.slice(1, -1)) {
        const extent = c.routing.bendRadius + radius;
        reserved.push({
          name: `Cable ${c.id} bend`,
          x: point.x - extent,
          y: point.y - extent,
          z: point.z - extent,
          width: 2 * extent,
          depth: 2 * extent,
          height: 2 * extent,
        });
      }
    }
    return {
      ...c,
      a: a ?? null,
      b: b ?? null,
      distance,
      route: routing,
      required: length === null ? null : length + c.slack,
      reachable: length !== null && length + c.slack <= c.length + 1e-5,
    };
  });
}

function cableObstacles(
  d: MechanicalDesign,
  boards: MechanicalAccessBoard[],
  cable: NonNullable<MechanicalDesign["connections"]>[number],
) {
  const boxes = [...d.obstacles];
  for (const board of boards) {
    const p = board.placement,
      f = board.features,
      angle = (p.rotation * Math.PI) / 180;
    const add = (r: Rect, z: number, height: number, name: string) => {
      const points = [r.minX, r.maxX].flatMap((x) =>
        [r.minY, r.maxY].map((y) => ({
          x: p.x + x * Math.cos(angle) - y * Math.sin(angle),
          y: p.y + x * Math.sin(angle) + y * Math.cos(angle),
        })),
      );
      const x = Math.min(...points.map((p) => p.x)),
        y = Math.min(...points.map((p) => p.y));
      boxes.push({
        name,
        x,
        y,
        z,
        width: Math.max(...points.map((p) => p.x)) - x,
        depth: Math.max(...points.map((p) => p.y)) - y,
        height,
      });
    };
    if (f.outline) add(f.outline, p.z, f.thicknessMm, `${p.path} substrate`);
    for (const part of f.components ?? []) {
      // The mating connector necessarily contains the endpoint. Its exit direction
      // remains a review item; all other component and substrate bounds stay blocked.
      if ([cable.from, cable.to].some((e) => e.boardPath === p.path && e.ref === part.ref))
        continue;
      if (part.bounds && part.heightMm)
        add(
          part.bounds,
          part.bottom ? p.z - part.heightMm : p.z + f.thicknessMm,
          part.heightMm,
          `${p.path} ${part.ref}`,
        );
    }
  }
  for (const m of d.mounts)
    boxes.push({
      name: "Mount",
      x: m.x - m.outer / 2,
      y: m.y - m.outer / 2,
      z: d.space.floor,
      width: m.outer,
      depth: m.outer,
      height: m.height,
    });
  return boxes;
}
export function portEnvelopes(d: MechanicalDesign, boards: MechanicalAccessBoard[]) {
  const result: Array<{
    boardPath: string;
    ref: string;
    face: "minX" | "maxX" | "minY" | "maxY";
    gap: number;
    plug: MechanicalBox | null;
    reach: number | null;
  }> = [];
  for (const b of boards)
    for (const c of b.features.connectors ?? []) {
      const p = d.portAccess?.find((p) => p.boardPath === b.placement.path && p.ref === c.ref);
      if ((p?.access ?? defaultConnectorAccess(c.footprint ?? "")) !== "external" || !c.bounds)
        continue;
      const order = ["maxX", "maxY", "minX", "minY"] as const;
      const turns = (((b.placement.rotation % 360) + 360) % 360) / 90;
      if (!Number.isInteger(turns)) continue;
      const face = order[(order.indexOf(p?.face ?? c.edge) + turns) % 4]!;
      const a = (b.placement.rotation * Math.PI) / 180;
      const body = c.face?.bounds ?? c.bounds;
      const points = [body.minX, body.maxX].flatMap((x) =>
        [body.minY, body.maxY].map((y) => ({
          x: b.placement.x + x * Math.cos(a) - y * Math.sin(a),
          y: b.placement.y + x * Math.sin(a) + y * Math.cos(a),
        })),
      );
      const r = {
        minX: Math.min(...points.map((p) => p.x)),
        maxX: Math.max(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)),
        maxY: Math.max(...points.map((p) => p.y)),
      };
      const s = d.space,
        vertical = face.endsWith("X"),
        negative = face.startsWith("min");
      const wall =
        face === "minX"
          ? s.x
          : face === "maxX"
            ? s.x + s.width
            : face === "minY"
              ? s.y
              : s.y + s.depth;
      const front =
        face === "minX" ? r.minX : face === "maxX" ? r.maxX : face === "minY" ? r.minY : r.maxY;
      const gap = Math.abs(front - wall);
      const along = vertical ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2;
      const centerZ = c.face?.centerZ ?? c.heightMm / 2;
      const z =
        b.placement.z +
        (b.features.components?.some((part) => part.ref === c.ref && part.bottom)
          ? -centerZ
          : b.features.thicknessMm + centerZ);
      const plug = p?.plug;
      const accessDepth = plug ? plug.depth + (plug.travel ?? 0) : 0;
      const start = negative ? wall - s.wall - accessDepth : wall + s.wall;
      result.push({
        boardPath: b.placement.path,
        ref: c.ref,
        face,
        gap,
        reach: plug?.reach ?? null,
        plug: plug
          ? {
              name: `${c.ref} plug access`,
              x: vertical ? start : along - plug.width / 2,
              y: vertical ? along - plug.width / 2 : start,
              z: z - plug.height / 2,
              width: vertical ? accessDepth : plug.width,
              depth: vertical ? plug.width : accessDepth,
              height: plug.height,
            }
          : null,
      });
    }
  return result;
}

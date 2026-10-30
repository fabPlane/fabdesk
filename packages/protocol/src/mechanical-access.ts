import {
  defaultConnectorAccess,
  type MechanicalBox,
  type MechanicalDesign,
} from "./mechanical-design";

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
    }>;
    components?: Array<{ ref: string; bottom?: boolean }>;
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
export function cableAssessments(d: MechanicalDesign, boards: MechanicalAccessBoard[]) {
  return (d.connections ?? []).map((c) => {
    const from = boards.find((b) => b.placement.path === c.from.boardPath),
      to = boards.find((b) => b.placement.path === c.to.boardPath);
    const a = from && accessPoint(from, c.from.ref),
      b = to && accessPoint(to, c.to.ref);
    const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null;
    return {
      ...c,
      a: a ?? null,
      b: b ?? null,
      distance,
      required: distance === null ? null : distance + c.slack,
      reachable: distance !== null && distance + c.slack <= c.length + 1e-5,
    };
  });
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
      const points = [c.bounds.minX, c.bounds.maxX].flatMap((x) =>
        [c.bounds!.minY, c.bounds!.maxY].map((y) => ({
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
      const z = accessPoint(b, c.ref)!.z;
      const plug = p?.plug;
      const start = negative ? wall - s.wall - (plug?.depth ?? 0) : wall + s.wall;
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
              width: vertical ? plug.depth : plug.width,
              depth: vertical ? plug.width : plug.depth,
              height: plug.height,
            }
          : null,
      });
    }
  return result;
}

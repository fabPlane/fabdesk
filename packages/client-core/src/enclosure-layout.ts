import { defaultConnectorAccess, type MechanicalDesign } from "@fabdesk/protocol";
import { alignEnclosureMounts, linkEnclosureMounts, type MountBoard } from "./enclosure-mounts";
import type { EnclosureBoardSummary } from "./enclosure-design";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Edge = "minX" | "maxX" | "minY" | "maxY";
export type LayoutBoard = MountBoard & { modelBounds?: Rect & { minZ: number; maxZ: number } };
type Connector = NonNullable<EnclosureBoardSummary["connectors"]>[number];
type Port = { ref: string; bounds: Rect; edge: Edge; height: number; bottom: boolean };
type Option = {
  board: LayoutBoard;
  rotation: number;
  rect: Rect;
  ports: Port[];
  z: number;
  top: number;
};
type Placed = Option & { x: number; y: number; world: Rect };
const turn = (x: number, y: number, r: number) => {
  const a = (r * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};
function rotateRect(b: Rect, r: number): Rect {
  const points = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ].map(([x, y]) => turn(x!, y!, r));
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
const shift = (b: Rect, x: number, y: number): Rect => ({
  minX: b.minX + x,
  minY: b.minY + y,
  maxX: b.maxX + x,
  maxY: b.maxY + y,
});
const overlap = (a: Rect, b: Rect, g: number) =>
  a.minX < b.maxX + g - 1e-5 &&
  a.maxX > b.minX - g + 1e-5 &&
  a.minY < b.maxY + g - 1e-5 &&
  a.maxY > b.minY - g + 1e-5;
function rotatedEdge(edge: Edge, r: number): Edge {
  const order: Edge[] = ["maxX", "maxY", "minX", "minY"];
  return order[(order.indexOf(edge) + r / 90) % 4]!;
}
export function connectorAccess(d: MechanicalDesign, path: string, c: Connector) {
  return (
    d.portAccess?.find((p) => p.boardPath === path && p.ref === c.ref)?.access ??
    defaultConnectorAccess(c.footprint ?? "")
  );
}
function options(d: MechanicalDesign, b: LayoutBoard): Option[] {
  const f = b.features,
    parts = f.components ?? [],
    m = b.modelBounds;
  const mounts = d.mounts.filter((p) => p.boardPath === b.placement.path);
  const holes = f.holes.filter((h) => mounts.some((p) => p.holeId === h.id));
  const rect = {
    minX: Math.min(
      f.outline.minX,
      ...parts.map((p) => p.bounds.minX),
      m?.minX ?? Infinity,
      ...holes.map((h) => h.x - mounts.find((p) => p.holeId === h.id)!.outer / 2),
    ),
    minY: Math.min(
      f.outline.minY,
      ...parts.map((p) => p.bounds.minY),
      m?.minY ?? Infinity,
      ...holes.map((h) => h.y - mounts.find((p) => p.holeId === h.id)!.outer / 2),
    ),
    maxX: Math.max(
      f.outline.maxX,
      ...parts.map((p) => p.bounds.maxX),
      m?.maxX ?? -Infinity,
      ...holes.map((h) => h.x + mounts.find((p) => p.holeId === h.id)!.outer / 2),
    ),
    maxY: Math.max(
      f.outline.maxY,
      ...parts.map((p) => p.bounds.maxY),
      m?.maxY ?? -Infinity,
      ...holes.map((h) => h.y + mounts.find((p) => p.holeId === h.id)!.outer / 2),
    ),
  };
  const z = Math.max(
    b.placement.z,
    d.space.floor +
      Math.max(
        3,
        ...parts.filter((p) => p.bottom).map((p) => p.heightMm + d.space.clearance),
        -(m?.minZ ?? 0) + d.space.clearance,
      ),
  );
  const top =
    z +
    Math.max(
      f.thicknessMm,
      ...parts.filter((p) => !p.bottom).map((p) => f.thicknessMm + p.heightMm),
      m?.maxZ ?? 0,
    );
  return [0, 90, 180, 270].map((rotation) => ({
    board: b,
    rotation,
    rect: rotateRect(rect, rotation),
    z,
    top,
    ports: (f.connectors ?? [])
      .filter((c) => connectorAccess(d, b.placement.path, c) === "external" && c.bounds)
      .map((c) => ({
        ref: c.ref,
        bounds: rotateRect(c.bounds!, rotation),
        edge: rotatedEdge(c.edge, rotation),
        height: c.heightMm,
        bottom: parts.some((p) => p.ref === c.ref && p.bottom),
      })),
  }));
}
function wallGap(p: Port, b: Placed, w: number, h: number) {
  const r = shift(p.bounds, b.x, b.y);
  return p.edge === "minX"
    ? r.minX
    : p.edge === "maxX"
      ? w - r.maxX
      : p.edge === "minY"
        ? r.minY
        : h - r.maxY;
}
/** Bounded deterministic search, prioritizing reachable external ports, then case footprint.
 * Does not modify PCB files or claim a global optimum/cable-route solution. */
export function proposeEnclosureLayout(design: MechanicalDesign, inputs: LayoutBoard[]) {
  if (!inputs.length || inputs.length !== design.boards.length)
    throw Error("Load every board before arranging the enclosure.");
  let d = linkEnclosureMounts(design, inputs);
  if (d.mounts.some((m) => !m.boardPath || !m.holeId))
    throw Error("Link manual posts to PCB holes before arranging boards automatically.");
  const all = inputs.map((b) => options(d, b));
  const gap = Math.max(3, d.space.clearance * 2),
    margin = Math.max(1, d.space.clearance);
  const fixed =
    d.mode === "imported" || d.obstacles.length > 0 || d.openings.some((o) => !o.boardPath);
  const area = all.reduce((sum, opts) => {
    const r = opts[0]!.rect;
    return sum + (r.maxX - r.minX + gap) * (r.maxY - r.minY + gap);
  }, 0);
  const longest =
    Math.max(...all.map((opts) => Math.min(...opts.map((o) => o.rect.maxX - o.rect.minX)))) +
    margin * 2;
  const dims: Array<[number, number]> = [];
  if (fixed) dims.push([d.space.width, d.space.depth]);
  else
    for (let k = 0; k < 15; k++) {
      const w = Math.ceil(Math.max(longest, Math.sqrt(area) * (0.65 + k * 0.09)) / 5) * 5;
      for (const factor of [1.05, 1.2, 1.4, 1.65, 2])
        dims.push([w, Math.ceil(Math.max((area / w) * factor, longest) / 5) * 5]);
    }
  let best: { placed: Placed[]; w: number; h: number; matched: number; score: number } | undefined;
  for (const [w, h] of dims)
    for (let order = 0; order < 3; order++) {
      if (w > 2000 || h > 2000) continue;
      const sorted = [...all].sort((a, b) => {
        const ports = b[0]!.ports.length - a[0]!.ports.length;
        const ar = (o: Option) => (o.rect.maxX - o.rect.minX) * (o.rect.maxY - o.rect.minY);
        return (
          ports ||
          (order === 1 ? ar(a[0]!) - ar(b[0]!) : ar(b[0]!) - ar(a[0]!)) ||
          a[0]!.board.placement.path.localeCompare(b[0]!.board.placement.path)
        );
      });
      if (order === 2) sorted.reverse();
      const placed: Placed[] = [];
      for (const opts of sorted) {
        let chosen: Placed | undefined,
          score = Infinity;
        for (const o of opts) {
          const bw = o.rect.maxX - o.rect.minX,
            bh = o.rect.maxY - o.rect.minY;
          const xs = new Set([margin, w - margin - bw]),
            ys = new Set([margin, h - margin - bh]);
          for (const b of placed) {
            xs.add(b.world.maxX + gap);
            xs.add(b.world.minX - bw - gap);
            ys.add(b.world.maxY + gap);
            ys.add(b.world.minY - bh - gap);
          }
          for (const x of xs)
            for (const y of ys) {
              const world = { minX: x, minY: y, maxX: x + bw, maxY: y + bh };
              if (
                x < margin - 1e-5 ||
                y < margin - 1e-5 ||
                world.maxX > w - margin + 1e-5 ||
                world.maxY > h - margin + 1e-5 ||
                placed.some((b) => overlap(world, b.world, gap))
              )
                continue;
              if (
                d.obstacles.some((b) =>
                  overlap(
                    world,
                    {
                      minX: b.x - d.space.x,
                      minY: b.y - d.space.y,
                      maxX: b.x - d.space.x + b.width,
                      maxY: b.y - d.space.y + b.depth,
                    },
                    margin,
                  ),
                )
              )
                continue;
              if (fixed && o.top + margin > d.space.floor + d.space.height) continue;
              const candidate = { ...o, x: x - o.rect.minX, y: y - o.rect.minY, world };
              const distances = o.ports.map((p) => wallGap(p, candidate, w, h));
              const missed = distances.filter((v) => v > margin + 1.5).length;
              const n = missed * 1e7 + distances.reduce((a, b) => a + b, 0) * 1000 + y * w + x;
              if (n < score) {
                score = n;
                chosen = candidate;
              }
            }
        }
        if (!chosen) break;
        placed.push(chosen);
      }
      if (placed.length !== inputs.length) continue;
      const matched = placed.reduce(
        (n, b) => n + b.ports.filter((p) => wallGap(p, b, w, h) <= margin + 1.5).length,
        0,
      );
      const score = -matched * 1e9 + w * h;
      if (!best || score < best.score) best = { placed, w, h, matched, score };
    }
  if (!best)
    throw Error(
      "No collision-free layout found within these constraints. Increase the usable space or adjust obstacles.",
    );
  const sx = d.space.x,
    sy = d.space.y;
  const boards = best.placed.map((b) => ({
    ...b.board.placement,
    x: b.x + sx,
    y: b.y + sy,
    z: b.z,
    rotation: b.rotation,
  }));
  const openings = d.openings.filter((o) => !o.boardPath);
  const unresolved: string[] = [];
  for (const b of best.placed)
    for (const p of b.ports) {
      if (wallGap(p, b, best.w, best.h) > margin + 1.5) {
        unresolved.push(`${b.board.placement.path}: ${p.ref} cannot reach its facing wall`);
        continue;
      }
      const r = shift(p.bounds, b.x + sx, b.y + sy),
        vertical = p.edge === "minX" || p.edge === "maxX";
      const z = p.bottom ? b.z - p.height : b.z + b.board.features.thicknessMm;
      openings.push({
        name: `${b.board.placement.path
          .split("/")
          .at(-1)!
          .replace(/\.kicad_pcb$/i, "")
          .slice(0, 45)} · ${p.ref}`.slice(0, 80),
        boardPath: b.board.placement.path,
        ref: p.ref,
        wall: p.edge,
        offset: vertical ? (r.minY + r.maxY) / 2 : (r.minX + r.maxX) / 2,
        z: Math.max(d.space.floor, z - margin),
        width: (vertical ? r.maxY - r.minY : r.maxX - r.minX) + 2 * margin,
        height: p.height + 2 * margin,
      });
    }
  const next: MechanicalDesign = {
    ...d,
    boards,
    openings,
    space: {
      ...d.space,
      width: best.w,
      depth: best.h,
      height: fixed
        ? d.space.height
        : Math.ceil(Math.max(...best.placed.map((b) => b.top)) + margin - d.space.floor + 1),
    },
  };
  const aligned = alignEnclosureMounts(
    next,
    inputs.map((b) => ({ ...b, placement: boards.find((p) => p.path === b.placement.path)! })),
  );
  return {
    design: aligned,
    externalPorts: best.placed.reduce((n, b) => n + b.ports.length, 0),
    openingsAdded: best.matched,
    unresolved,
    notes: [
      "External ports are inferred from footprint names; confirm their facing edge and plug clearance.",
      "Cable reach, thermal design and exact physical fit still need review.",
      ...inputs
        .filter((b) => !b.modelBounds)
        .map((b) => `${b.placement.path}: dimensions use estimated component bounds.`),
    ],
  };
}

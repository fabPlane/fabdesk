import {
  cableAssessments,
  portEnvelopes,
  defaultConnectorAccess,
  connectorOpening,
  enclosureOpeningClearance,
  type MechanicalDesign,
} from "@fabdesk/protocol";
import { alignEnclosureMounts, linkEnclosureMounts, type MountBoard } from "./enclosure-mounts";
import type { EnclosureBoardSummary } from "./enclosure-design";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Edge = "minX" | "maxX" | "minY" | "maxY";
export type LayoutBoard = MountBoard & { modelBounds?: Rect & { minZ: number; maxZ: number } };
/** Loaded native bounds supplement estimated envelopes; they do not prove solid-to-solid fit. */
export function nativeEnclosureClearanceIssues(
  d: MechanicalDesign,
  boards: LayoutBoard[],
): import("@fabdesk/protocol").MechanicalFitIssue[] {
  return boards.flatMap((b) => {
    if (!b.modelBounds) return [];
    const p = b.placement,
      m = b.modelBounds,
      r = shift(rotateRect(m, p.rotation), p.x, p.y),
      s = d.space,
      c = s.clearance + 2 * (d.fitAllowance ?? 0);
    const minimum = Math.min(
      r.minX - s.x,
      r.minY - s.y,
      s.x + s.width - r.maxX,
      s.y + s.depth - r.maxY,
      p.z + m.minZ - s.floor,
      s.floor + s.height - p.z - m.maxZ,
    );
    if (minimum >= c - 0.001) return [];
    return [
      {
        code: "native-clearance",
        severity: "error" as const,
        message: `${p.path}: loaded native geometry has ${minimum.toFixed(2)} mm minimum cavity clearance; ${c} mm is required. Reposition the board or enlarge the case.`,
        regions: [
          {
            name: "Native PCB bounds",
            x: r.minX,
            y: r.minY,
            z: p.z + m.minZ,
            width: r.maxX - r.minX,
            depth: r.maxY - r.minY,
            height: m.maxZ - m.minZ,
          },
        ],
      },
    ];
  });
}
type Connector = NonNullable<EnclosureBoardSummary["connectors"]>[number];
type Port = {
  ref: string;
  bounds: Rect;
  edge: Edge;
  height: number;
  bottom: boolean;
  aperture: {
    width: number;
    height: number;
    x: number;
    y: number;
    centerZ: number;
    shape: import("@fabdesk/protocol").OpeningShape;
  };
  wall?: Edge;
};
export type EnclosureLayoutGoal = "compact" | "assembly" | "ports";
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
  return order[(order.indexOf(edge) + (((r % 360) + 360) % 360) / 90) % 4]!;
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
  const z = b.placement.locked
    ? b.placement.z
    : Math.max(
        b.placement.z,
        d.space.floor +
          Math.max(
            3,
            ...parts
              .filter((p) => p.bottom)
              .map((p) => p.heightMm + d.space.clearance + 2 * (d.fitAllowance ?? 0)),
            -(m?.minZ ?? 0) + d.space.clearance + 2 * (d.fitAllowance ?? 0),
          ),
      );
  const top =
    z +
    Math.max(
      f.thicknessMm,
      ...parts.filter((p) => !p.bottom).map((p) => f.thicknessMm + p.heightMm),
      m?.maxZ ?? 0,
    );
  if (b.placement.locked && b.placement.rotation % 90 !== 0)
    throw Error(
      `Set ${b.placement.path} to a quarter-turn rotation before locking it for automatic layout.`,
    );
  return (b.placement.locked ? [b.placement.rotation] : [0, 90, 180, 270]).map((rotation) => ({
    board: b,
    rotation,
    rect: rotateRect(rect, rotation),
    z,
    top,
    ports: (f.connectors ?? [])
      .filter((c) => connectorAccess(d, b.placement.path, c) === "external" && c.bounds)
      .map((c) => {
        const profile = d.portAccess?.find(
          (p) => p.boardPath === b.placement.path && p.ref === c.ref,
        );
        const face = connectorOpening(c, profile?.face ?? c.edge, profile?.aperture);
        const center = turn(face.x, face.y, rotation);
        return {
          ref: c.ref,
          bounds: rotateRect(c.bounds!, rotation),
          edge: rotatedEdge(profile?.face ?? c.edge, rotation),
          aperture: { ...face, ...center },
          ...(profile?.wall ? { wall: profile.wall } : {}),
          height: c.heightMm,
          bottom: parts.some((p) => p.ref === c.ref && p.bottom),
        };
      }),
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
export function proposeEnclosureLayout(
  design: MechanicalDesign,
  inputs: LayoutBoard[],
  goal: EnclosureLayoutGoal = "compact",
) {
  if (!inputs.length || inputs.length !== design.boards.length)
    throw Error("Load every board before arranging the enclosure.");
  inputs = design.boards.map((placement) => {
    const b = inputs.find((b) => b.placement.path === placement.path);
    if (!b) throw Error("Load every board before arranging the enclosure.");
    return { ...b, placement };
  });
  let d = linkEnclosureMounts(design, inputs);
  if (cableAssessments(d, inputs).some((c) => c.distance === null))
    throw Error("A cable endpoint is missing. Choose both connector references before arranging.");
  if (d.mounts.some((m) => !m.boardPath || !m.holeId))
    throw Error("Link manual posts to PCB holes before arranging boards automatically.");
  const all = inputs.map((b) => options(d, b));
  // Corner holders extend 1.75 mm beyond each PCB edge. Reserve their room
  // during placement, including between two retained boards.
  const allowance = 2 * (d.fitAllowance ?? 0);
  const holderMargin = d.holders?.length ? 1.75 + allowance : 0;
  const gap = Math.max(
      goal === "assembly" ? 8 : 3,
      (d.space.clearance + allowance + holderMargin) * 2,
    ),
    margin = Math.max(1, d.space.clearance + allowance + holderMargin);
  const fixed =
    d.mode === "imported" ||
    d.boards.some((b) => b.locked) ||
    d.obstacles.length > 0 ||
    d.openings.some((o) => !o.boardPath);
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
          Number(!!b[0]!.board.placement.locked) - Number(!!a[0]!.board.placement.locked) ||
          ports ||
          (order === 1 ? ar(a[0]!) - ar(b[0]!) : ar(b[0]!) - ar(a[0]!)) ||
          a[0]!.board.placement.path.localeCompare(b[0]!.board.placement.path)
        );
      });
      if (order === 2) {
        const unlocked = sorted.filter((opts) => !opts[0]!.board.placement.locked).reverse();
        sorted.splice(
          0,
          sorted.length,
          ...sorted.filter((opts) => opts[0]!.board.placement.locked),
          ...unlocked,
        );
      }
      const placed: Placed[] = [];
      for (const opts of sorted) {
        let chosen: Placed | undefined,
          score = Infinity;
        for (const o of opts) {
          const underside = Math.max(
            0,
            ...(o.board.features.components ?? []).filter((p) => p.bottom).map((p) => p.heightMm),
            -(o.board.modelBounds?.minZ ?? 0),
          );
          if (o.z - underside < d.space.floor + d.space.clearance + allowance - 1e-5) continue;
          if (o.ports.some((p) => p.wall && p.wall !== p.edge)) continue;
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
          if (o.board.placement.locked) {
            xs.clear();
            ys.clear();
            xs.add(o.board.placement.x - d.space.x + o.rect.minX);
            ys.add(o.board.placement.y - d.space.y + o.rect.minY);
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
              const cableBoards = [...placed, candidate].map((p) => ({
                ...p.board,
                placement: {
                  ...p.board.placement,
                  x: p.x + d.space.x,
                  y: p.y + d.space.y,
                  z: p.z,
                  rotation: p.rotation,
                },
              }));
              const cables = cableAssessments(d, cableBoards).filter((c) => c.distance !== null);
              if (cables.some((c) => !c.reachable)) continue;
              const distances = o.ports.map((p) => wallGap(p, candidate, w, h));
              const missed = distances.filter((v) => v > margin + 1.5).length;
              const n =
                missed * 1e7 +
                distances.reduce((a, b) => a + b, 0) * 1000 +
                cables.reduce((n, c) => n + c.distance!, 0) * 100 +
                y * w +
                x;
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
      const access = portEnvelopes(
        { ...d, space: { ...d.space, width: w, depth: h } },
        placed.map((p) => ({
          ...p.board,
          placement: {
            ...p.board.placement,
            x: p.x + d.space.x,
            y: p.y + d.space.y,
            z: p.z,
            rotation: p.rotation,
          },
        })),
      );
      if (access.some((p) => p.reach !== null && p.reach + 1e-5 < p.gap + d.space.wall + allowance))
        continue;
      const plugs = access.flatMap((p) => (p.plug ? [p.plug] : []));
      if (
        plugs.some((a, i) =>
          [...plugs.slice(i + 1), ...d.obstacles].some(
            (b) =>
              overlap(
                { minX: a.x, minY: a.y, maxX: a.x + a.width, maxY: a.y + a.depth },
                { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.depth },
                d.space.clearance + allowance,
              ) &&
              a.z < b.z + b.height + d.space.clearance + allowance &&
              a.z + a.height + d.space.clearance + allowance > b.z,
          ),
        )
      )
        continue;
      const matched = placed.reduce(
        (n, b) => n + b.ports.filter((p) => wallGap(p, b, w, h) <= margin + 1.5).length,
        0,
      );
      const walls = new Set(placed.flatMap((b) => b.ports.map((p) => p.edge))).size;
      const cableLength = cableAssessments(
        d,
        placed.map((p) => ({
          ...p.board,
          placement: {
            ...p.board.placement,
            x: p.x + d.space.x,
            y: p.y + d.space.y,
            z: p.z,
            rotation: p.rotation,
          },
        })),
      ).reduce((n, c) => n + (c.distance ?? 0), 0);
      const score =
        -matched * 1e9 +
        (goal === "ports" ? walls * 1e7 : 0) +
        w * h +
        cableLength * (goal === "assembly" ? 50 : 5);
      if (!best || score < best.score) best = { placed, w, h, matched, score };
    }
  if (!best)
    throw Error(
      "No collision-free layout found with these locks, wall choices, plug dimensions and cable lengths. Increase the usable space or review a constraint.",
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
      const vertical = p.edge === "minX" || p.edge === "maxX";
      const z = p.bottom ? b.z - p.height : b.z + b.board.features.thicknessMm;
      const padding = enclosureOpeningClearance(d);
      const height = p.aperture.height;
      const centerZ = p.bottom ? b.z - p.aperture.centerZ : z + p.aperture.centerZ;
      openings.push({
        name: `${b.board.placement.path
          .split("/")
          .at(-1)!
          .replace(/\.kicad_pcb$/i, "")
          .slice(0, 45)} · ${p.ref}`.slice(0, 80),
        boardPath: b.board.placement.path,
        ref: p.ref,
        wall: p.edge,
        offset: vertical ? p.aperture.y + b.y + sy : p.aperture.x + b.x + sx,
        z: centerZ - height / 2 - padding,
        width: p.aperture.width + 2 * padding,
        height: height + 2 * padding,
        shape: p.aperture.shape,
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
    goal,
    boardGap: gap,
    wallCount: new Set(openings.filter((o) => o.boardPath).map((o) => o.wall)).size,
    cables: cableAssessments(
      aligned,
      inputs.map((b) => ({ ...b, placement: boards.find((p) => p.path === b.placement.path)! })),
    ),
    design: aligned,
    externalPorts: best.placed.reduce((n, b) => n + b.ports.length, 0),
    openingsAdded: best.matched,
    unresolved,
    notes: [
      "External ports are inferred from footprint names; confirm their facing edge and plug clearance.",
      "Cable checks use straight-line distance plus your slack allowance, not routed bend geometry. Physical assembly and cooling still need review.",
      ...inputs
        .filter((b) => !b.modelBounds)
        .map((b) => `${b.placement.path}: dimensions use estimated component bounds.`),
    ],
  };
}

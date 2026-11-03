import {
  cableAssessments,
  portEnvelopes,
  defaultConnectorAccess,
  connectorOpening,
  enclosureOpeningClearance,
  enclosureFitsSizeLimit,
  enclosureInteriorLimits,
  enclosureHardwareDimensions,
  enclosureOpeningBounds,
  chooseLidScrews,
  type MechanicalDesign,
} from "@fabdesk/protocol";
import { alignEnclosureMounts, linkEnclosureMounts, type MountBoard } from "./enclosure-mounts";
import { enclosureComponents, type EnclosureBoardSummary } from "./enclosure-design";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Volume = Rect & { minZ: number; maxZ: number };
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
  reach?: number;
};
export type EnclosureLayoutGoal = "compact" | "assembly" | "ports";
type Option = {
  fixed: boolean;
  board: LayoutBoard;
  rotation: number;
  rect: Rect;
  wallRect: Rect;
  ports: Port[];
  z: number;
  top: number;
  obstacleRegions: Volume[];
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
function options(
  d: MechanicalDesign,
  b: LayoutBoard,
  margin: number,
  fixedCase: boolean,
): Option[] {
  // A manually positioned cutout anchors its board until the user matches it to the port again.
  const fixed =
    !!b.placement.locked ||
    d.openings.some((o) => o.boardPath === b.placement.path && o.followBoard === false);
  const f = b.features,
    parts = enclosureComponents(f),
    m = b.modelBounds;
  const ports: Port[] = (f.connectors ?? [])
    .filter(
      (c) => connectorAccess(d, b.placement.path, c) === "external" && (c.face?.bounds || c.bounds),
    )
    .map((c) => {
      const profile = d.portAccess?.find(
        (p) => p.boardPath === b.placement.path && p.ref === c.ref,
      );
      return {
        ref: c.ref,
        bounds: c.face?.bounds ?? c.bounds!,
        edge: profile?.face ?? c.edge,
        aperture: connectorOpening(c, profile?.face ?? c.edge, profile?.aperture),
        ...(profile?.wall ? { wall: profile.wall } : {}),
        ...(profile?.plug?.reach !== undefined ? { reach: profile.plug.reach } : {}),
        height: c.heightMm,
        bottom: parts.some((p) => p.ref === c.ref && p.bottom),
      };
    });
  const web = fixedCase ? 0 : d.space.wall + 2 * (d.fitAllowance ?? 0);
  const mounts = d.mounts.filter((p) => p.boardPath === b.placement.path);
  const supports = mounts.flatMap((mount) => {
    const hole = f.holes.find((h) => h.id === mount.holeId);
    return hole
      ? [{ hole, mount, radius: Math.max(mount.outer, mount.headDiameter ?? 0) / 2 }]
      : [];
  });
  for (const { mount } of supports) {
    if (mount.screwLength && mount.screwLength <= f.thicknessMm)
      throw Error(
        `Choose a longer board screw for ${b.placement.path}; it must reach below the PCB into its post.`,
      );
    if (
      fixed &&
      mount.screwLength &&
      mount.screwLength > f.thicknessMm + b.placement.z - d.space.floor
    )
      throw Error(
        `The board screw for ${b.placement.path} extends below its post. Unlock and raise the board, or choose a shorter screw.`,
      );
  }
  const rect = {
    minX: Math.min(
      f.outline.minX,
      ...parts.map((p) => p.bounds.minX),
      m?.minX ?? Infinity,
      ...supports.map(({ hole, radius }) => hole.x - radius),
    ),
    minY: Math.min(
      f.outline.minY,
      ...parts.map((p) => p.bounds.minY),
      m?.minY ?? Infinity,
      ...supports.map(({ hole, radius }) => hole.y - radius),
    ),
    maxX: Math.max(
      f.outline.maxX,
      ...parts.map((p) => p.bounds.maxX),
      m?.maxX ?? -Infinity,
      ...supports.map(({ hole, radius }) => hole.x + radius),
    ),
    maxY: Math.max(
      f.outline.maxY,
      ...parts.map((p) => p.bounds.maxY),
      m?.maxY ?? -Infinity,
      ...supports.map(({ hole, radius }) => hole.y + radius),
    ),
  };
  // A wide/off-center opening needs wall length, but is not an interior body
  // that should push other boards away during collision-free packing.
  const wallRect = { ...rect };
  for (const p of ports) {
    if (
      d.openings.some(
        (o) => o.boardPath === b.placement.path && o.ref === p.ref && o.followBoard === false,
      )
    )
      continue;
    const half = Math.max(0, p.aperture.width / 2 + enclosureOpeningClearance(d) + web - margin);
    if (p.edge.endsWith("X")) {
      wallRect.minY = Math.min(wallRect.minY, p.aperture.y - half);
      wallRect.maxY = Math.max(wallRect.maxY, p.aperture.y + half);
    } else {
      wallRect.minX = Math.min(wallRect.minX, p.aperture.x - half);
      wallRect.maxX = Math.max(wallRect.maxX, p.aperture.x + half);
    }
  }
  const z = fixed
    ? b.placement.z
    : d.space.floor +
      Math.max(
        3,
        ...parts
          .filter((p) => p.bottom)
          .map((p) => p.heightMm + d.space.clearance + 2 * (d.fitAllowance ?? 0)),
        -(m?.minZ ?? 0) + d.space.clearance + 2 * (d.fitAllowance ?? 0),
        ...ports.map((p) => web - portVerticalBounds(d, p, 0, f.thicknessMm).min),
        ...supports.map(
          ({ mount }) => (mount.screwLength ?? 0) - f.thicknessMm + 2 * (d.fitAllowance ?? 0),
        ),
      );
  const top =
    z +
    Math.max(
      f.thicknessMm,
      ...parts.filter((p) => !p.bottom).map((p) => f.thicknessMm + p.heightMm),
      ...supports.map(({ mount }) => f.thicknessMm + (mount.headHeight ?? 0)),
      m?.maxZ ?? 0,
    );
  const obstacleRegions: Volume[] = [
    { ...f.outline, minZ: z, maxZ: z + f.thicknessMm },
    ...parts.map((p) => ({
      ...p.bounds,
      minZ: p.bottom ? z - p.heightMm : z + f.thicknessMm,
      maxZ: p.bottom ? z : z + f.thicknessMm + p.heightMm,
    })),
    ...(m ? [{ ...m, minZ: z + m.minZ, maxZ: z + m.maxZ }] : []),
    ...supports.flatMap(({ hole, mount }) => [
      {
        minX: hole.x - mount.outer / 2,
        minY: hole.y - mount.outer / 2,
        maxX: hole.x + mount.outer / 2,
        maxY: hole.y + mount.outer / 2,
        minZ: d.space.floor,
        maxZ: z,
      },
      ...(mount.headDiameter && mount.headHeight
        ? [
            {
              minX: hole.x - mount.headDiameter / 2,
              minY: hole.y - mount.headDiameter / 2,
              maxX: hole.x + mount.headDiameter / 2,
              maxY: hole.y + mount.headDiameter / 2,
              minZ: z + f.thicknessMm,
              maxZ: z + f.thicknessMm + mount.headHeight,
            },
          ]
        : []),
    ]),
  ];
  if (d.holders?.some((holder) => holder.boardPath === b.placement.path)) {
    // Holder feet and lid captures span the cavity. Keep their envelope conservative
    // until the preview chooses and checks the individual support positions.
    const inset = 1.75 + 2 * (d.fitAllowance ?? 0);
    obstacleRegions.push({
      minX: f.outline.minX - inset,
      minY: f.outline.minY - inset,
      maxX: f.outline.maxX + inset,
      maxY: f.outline.maxY + inset,
      minZ: d.space.floor,
      maxZ: d.space.floor + d.space.height + d.space.lid,
    });
  }
  if (fixed && b.placement.rotation % 90 !== 0)
    throw Error(
      `Set ${b.placement.path} to a quarter-turn rotation before locking it for automatic layout.`,
    );
  return (fixed ? [b.placement.rotation] : [0, 90, 180, 270]).map((rotation) => ({
    fixed,
    board: b,
    rotation,
    rect: rotateRect(rect, rotation),
    wallRect: rotateRect(wallRect, rotation),
    z,
    top,
    obstacleRegions: obstacleRegions.map((v) => ({ ...v, ...rotateRect(v, rotation) })),
    ports: ports.map((p) => ({
      ...p,
      bounds: rotateRect(p.bounds, rotation),
      edge: rotatedEdge(p.edge, rotation),
      aperture: { ...p.aperture, ...turn(p.aperture.x, p.aperture.y, rotation) },
    })),
  }));
}

function portVerticalBounds(d: MechanicalDesign, p: Port, z: number, thickness: number) {
  const center = z + (p.bottom ? -p.aperture.centerZ : thickness + p.aperture.centerZ);
  const half = p.aperture.height / 2 + enclosureOpeningClearance(d);
  return { min: center - half, max: center + half };
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
function reachesWall(
  p: Port,
  b: Placed,
  w: number,
  h: number,
  margin: number,
  d: MechanicalDesign,
) {
  const gap = wallGap(p, b, w, h);
  return p.reach !== undefined
    ? p.reach + 1e-5 >= gap + d.space.wall + 2 * (d.fitAllowance ?? 0)
    : gap <= margin + 1.5;
}
function caseHeight(d: MechanicalDesign, placed: Placed[], fixed: boolean, margin: number) {
  if (fixed) return d.space.height;
  const boardHeight = Math.max(...placed.map((b) => b.top)) + margin - d.space.floor + 1;
  const openingHeight = Math.max(
    0,
    ...placed.flatMap((b) =>
      b.ports.map(
        (p) =>
          portVerticalBounds(d, p, b.z, b.board.features.thicknessMm).max +
          d.space.wall +
          2 * (d.fitAllowance ?? 0) -
          d.space.floor,
      ),
    ),
  );
  const screwHeight =
    d.closure?.kind === "screws"
      ? d.closure.screwLength - d.space.lid + 2 * (d.fitAllowance ?? 0) + 1
      : 0;
  return Math.ceil(Math.max(boardHeight, screwHeight, openingHeight));
}

function placementOpenings(
  d: MechanicalDesign,
  placed: Placed[],
  width: number,
  depth: number,
  margin: number,
) {
  const openings = d.openings.filter((o) => !o.boardPath || o.followBoard === false);
  const unresolved: string[] = [];
  for (const b of placed)
    for (const p of b.ports) {
      if (openings.some((o) => o.boardPath === b.board.placement.path && o.ref === p.ref)) continue;
      if (!reachesWall(p, b, width, depth, margin, d)) {
        unresolved.push(`${b.board.placement.path}: ${p.ref} cannot reach its facing wall`);
        continue;
      }
      const padding = enclosureOpeningClearance(d);
      const vertical = portVerticalBounds(d, p, b.z, b.board.features.thicknessMm);
      openings.push({
        name: `${b.board.placement.path
          .split("/")
          .at(-1)!
          .replace(/\.kicad_pcb$/i, "")
          .slice(0, 45)} · ${p.ref}`.slice(0, 80),
        boardPath: b.board.placement.path,
        ref: p.ref,
        followBoard: true,
        wall: p.edge,
        offset: p.edge.endsWith("X")
          ? p.aperture.y + b.y + d.space.y
          : p.aperture.x + b.x + d.space.x,
        z: vertical.min,
        width: p.aperture.width + 2 * padding,
        height: p.aperture.height + 2 * padding,
        shape: p.aperture.shape,
      });
    }
  return { openings, unresolved };
}
/** Bounded deterministic search, prioritizing reachable external ports, then case footprint.
 * Does not modify PCB files or claim a global optimum. */
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
    d.openings.some((o) => !o.boardPath || o.followBoard === false);
  const all = inputs.map((b) => options(d, b, margin, fixed));
  const area = all.reduce((sum, opts) => {
    const r = opts[0]!.wallRect;
    return sum + (r.maxX - r.minX + gap) * (r.maxY - r.minY + gap);
  }, 0);
  const longest =
    Math.max(
      ...all.map((opts) => Math.min(...opts.map((o) => o.wallRect.maxX - o.wallRect.minX))),
    ) +
    margin * 2;
  const dims: Array<[number, number]> = [];
  if (fixed) dims.push([d.space.width, d.space.depth]);
  else {
    // Retest the current case too: changing search estimates must not discard an
    // already usable size just because it falls between generated candidates.
    dims.push([d.space.width, d.space.depth]);
    // Include tight rows/columns: small dongles should not inherit a near-square case.
    for (const rotation of [0, 90]) {
      const sizes = all.map((opts) => opts.find((o) => o.rotation === rotation)!.wallRect);
      const widths = sizes.map((r) => r.maxX - r.minX);
      const heights = sizes.map((r) => r.maxY - r.minY);
      // Other boards may fit beside the space reserved only for a wide port.
      dims.push([
        Math.ceil(Math.max(...widths) + 2 * margin),
        Math.ceil(Math.max(...heights) + 2 * margin),
      ]);
      dims.push([
        Math.ceil(widths.reduce((n, v) => n + v, 0) + gap * (sizes.length - 1) + 2 * margin),
        Math.ceil(Math.max(...heights) + 2 * margin),
      ]);
      dims.push([
        Math.ceil(Math.max(...widths) + 2 * margin),
        Math.ceil(heights.reduce((n, v) => n + v, 0) + gap * (sizes.length - 1) + 2 * margin),
      ]);
    }
    dims.push(...enclosureInteriorLimits(d));
    for (let k = 0; k < 15; k++) {
      const w = Math.ceil(Math.max(longest, Math.sqrt(area) * (0.65 + k * 0.09)));
      for (const factor of [1.05, 1.2, 1.4, 1.65, 2])
        dims.push([w, Math.ceil(Math.max((area / w) * factor, longest))]);
    }
  }
  let best: { placed: Placed[]; w: number; h: number; matched: number; score: number } | undefined;
  let attempts = 0,
    feasible = 0;
  const orderCount = Math.min(12, 3 + inputs.length);
  const connected = (path: string) =>
    (d.connections ?? []).filter((c) => c.from.boardPath === path || c.to.boardPath === path)
      .length;
  const rank = new Map(
    [...inputs]
      .sort((a, b) => a.placement.path.localeCompare(b.placement.path))
      .map((b, i) => [b.placement.path, i]),
  );
  const openingWidth = Math.max(
    0,
    ...all.flatMap((opts) =>
      opts[0]!.ports.map((p) =>
        Math.max(
          p.aperture.width + 2 * enclosureOpeningClearance(d),
          d.portAccess?.find(
            (access) => access.boardPath === opts[0]!.board.placement.path && access.ref === p.ref,
          )?.plug?.width ?? 0,
        ),
      ),
    ),
  );
  const hardwareDims = fixed
    ? dims
    : dims.flatMap(([w, h]) => enclosureHardwareDimensions(d, w, h, openingWidth));
  const uniqueDims = [...new Map(hardwareDims.map((v) => [v.join(","), v])).values()];
  for (const [w, h] of uniqueDims)
    for (let order = 0; order < orderCount; order++) {
      attempts++;
      if (w > 2000 || h > 2000) continue;
      if (!enclosureFitsSizeLimit({ ...d, space: { ...d.space, width: w, depth: h } })) continue;
      const sorted = [...all].sort((a, b) => {
        const ports = b[0]!.ports.length - a[0]!.ports.length;
        const ar = (o: Option) => (o.rect.maxX - o.rect.minX) * (o.rect.maxY - o.rect.minY);
        return (
          Number(b[0]!.fixed) - Number(a[0]!.fixed) ||
          (order >= 3
            ? order === 3
              ? connected(b[0]!.board.placement.path) - connected(a[0]!.board.placement.path)
              : ((rank.get(a[0]!.board.placement.path)! + order - 4) % inputs.length) -
                ((rank.get(b[0]!.board.placement.path)! + order - 4) % inputs.length)
            : 0) ||
          ports ||
          (order === 1 ? ar(a[0]!) - ar(b[0]!) : ar(b[0]!) - ar(a[0]!)) ||
          a[0]!.board.placement.path.localeCompare(b[0]!.board.placement.path)
        );
      });
      if (order === 2) {
        const unlocked = sorted.filter((opts) => !opts[0]!.fixed).reverse();
        sorted.splice(0, sorted.length, ...sorted.filter((opts) => opts[0]!.fixed), ...unlocked);
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
          const left = o.rect.minX - o.wallRect.minX,
            right = o.wallRect.maxX - o.rect.maxX;
          const front = o.rect.minY - o.wallRect.minY,
            back = o.wallRect.maxY - o.rect.maxY;
          const xs = new Set([margin + left, w - margin - bw - right]),
            ys = new Set([margin + front, h - margin - bh - back]);
          if (d.closure?.kind === "screws") {
            xs.add((w - bw) / 2);
            ys.add((h - bh) / 2);
          }
          for (const b of placed) {
            xs.add(b.world.maxX + gap);
            xs.add(b.world.minX - bw - gap);
            ys.add(b.world.maxY + gap);
            ys.add(b.world.minY - bh - gap);
          }
          for (const obstacle of d.obstacles) {
            xs.add(obstacle.x - d.space.x - bw - margin - 0.001);
            xs.add(obstacle.x - d.space.x + obstacle.width + margin + 0.001);
            ys.add(obstacle.y - d.space.y - bh - margin - 0.001);
            ys.add(obstacle.y - d.space.y + obstacle.depth + margin + 0.001);
          }
          if (o.fixed) {
            xs.clear();
            ys.clear();
            xs.add(o.board.placement.x - d.space.x + o.rect.minX);
            ys.add(o.board.placement.y - d.space.y + o.rect.minY);
          }
          for (const x of xs)
            for (const y of ys) {
              const world = { minX: x, minY: y, maxX: x + bw, maxY: y + bh };
              if (
                x - left < margin - 1e-5 ||
                y - front < margin - 1e-5 ||
                world.maxX + right > w - margin + 1e-5 ||
                world.maxY + back > h - margin + 1e-5 ||
                placed.some((b) => overlap(world, b.world, gap))
              )
                continue;
              if (
                d.obstacles.some((b) =>
                  o.obstacleRegions.some((v) => {
                    const clearance = d.space.clearance + allowance;
                    return (
                      v.minZ < b.z + b.height + clearance - 1e-5 &&
                      v.maxZ > b.z - clearance + 1e-5 &&
                      overlap(
                        shift(v, x - o.rect.minX, y - o.rect.minY),
                        {
                          minX: b.x - d.space.x,
                          minY: b.y - d.space.y,
                          maxX: b.x - d.space.x + b.width,
                          maxY: b.y - d.space.y + b.depth,
                        },
                        clearance,
                      )
                    );
                  }),
                )
              )
                continue;
              if (fixed && o.top + margin > d.space.floor + d.space.height) continue;
              const candidate = { ...o, x: x - o.rect.minX, y: y - o.rect.minY, world };
              if (
                fixed &&
                placementOpenings(d, [...placed, candidate], w, h, margin).openings.some(
                  (opening) =>
                    opening.z < d.space.floor - 1e-5 ||
                    opening.z + opening.height > d.space.floor + d.space.height + 1e-5,
                )
              )
                continue;
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
              const missed = o.ports.filter(
                (p) => !reachesWall(p, candidate, w, h, margin, d),
              ).length;
              const n =
                missed * 1e7 +
                distances.reduce((a, b) => a + b, 0) * 1000 +
                cables.reduce((n, c) => n + c.distance!, 0) * 100 +
                y * w +
                x;
              if (n < score) {
                if (d.closure?.kind === "screws") {
                  const prospective = [...placed, candidate];
                  const caseDesign = {
                    ...d,
                    space: {
                      ...d.space,
                      width: w,
                      depth: h,
                      height: caseHeight(d, prospective, fixed, margin),
                    },
                    openings: placementOpenings(d, prospective, w, h, margin).openings,
                  };
                  const plugs = portEnvelopes(caseDesign, cableBoards).flatMap((p) =>
                    p.plug ? [p.plug] : [],
                  );
                  if (
                    chooseLidScrews(caseDesign, [
                      ...enclosureOpeningBounds(caseDesign),
                      ...plugs,
                      ...d.obstacles,
                    ]).conflicts > 0
                  )
                    continue;
                }
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
        (n, b) => n + b.ports.filter((p) => reachesWall(p, b, w, h, margin, d)).length,
        0,
      );
      const walls = new Set(placed.flatMap((b) => b.ports.map((p) => p.edge))).size;
      const finalDesign = {
        ...d,
        space: {
          ...d.space,
          width: w,
          depth: h,
          height: caseHeight(d, placed, fixed, margin),
        },
      };
      const cableBoards = placed.map((p) => ({
        ...p.board,
        placement: {
          ...p.board.placement,
          x: p.x + d.space.x,
          y: p.y + d.space.y,
          z: p.z,
          rotation: p.rotation,
        },
      }));
      const mountedDesign = alignEnclosureMounts(
        { ...finalDesign, boards: cableBoards.map((b) => b.placement) },
        cableBoards,
      );
      const cables = cableAssessments(mountedDesign, cableBoards, true);
      if (cables.some((c) => !c.reachable)) continue;
      feasible++;
      const cableLength = cables.reduce((n, c) => n + (c.required ?? 0), 0);
      const score =
        -matched * 1e9 +
        (goal === "ports" ? walls * 1e7 : 0) +
        w * h +
        cableLength * (goal === "assembly" ? 50 : 5);
      if (!best || score < best.score) best = { placed, w, h, matched, score };
    }
  if (!best)
    throw Error(
      "No collision-free layout found for these boards, ports and lid screws. Try a larger case or print area, or review locked boards, port walls and cable lengths.",
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
  const { openings, unresolved } = placementOpenings(d, best.placed, best.w, best.h, margin);
  const next: MechanicalDesign = {
    ...d,
    boards,
    openings,
    space: {
      ...d.space,
      width: best.w,
      depth: best.h,
      height: caseHeight(d, best.placed, fixed, margin),
    },
  };
  const aligned = alignEnclosureMounts(
    next,
    inputs.map((b) => ({ ...b, placement: boards.find((p) => p.path === b.placement.path)! })),
  );
  return {
    goal,
    search: { attempts, feasible, orders: orderCount, dimensions: uniqueDims.length },
    boardGap: gap,
    wallCount: new Set(openings.filter((o) => o.boardPath).map((o) => o.wall)).size,
    cables: cableAssessments(
      aligned,
      inputs.map((b) => ({ ...b, placement: boards.find((p) => p.path === b.placement.path)! })),
      true,
    ),
    design: aligned,
    externalPorts: best.placed.reduce((n, b) => n + b.ports.length, 0),
    openingsAdded: best.matched,
    unresolved,
    notes: [
      "External ports are inferred from footprint names; confirm their facing edge and plug clearance.",
      "Optional cable routes reserve obstacle clearance and bend space. Connector exits, cable crossings, ribbon twist, cooling and physical strength still need review.",
      `Compared ${attempts} deterministic layout attempts; ${feasible} passed placement and configured cable checks. This is a bounded search, not a guaranteed global optimum.`,
      ...inputs
        .filter((b) => !b.modelBounds)
        .map((b) => `${b.placement.path}: dimensions use estimated component bounds.`),
    ],
  };
}

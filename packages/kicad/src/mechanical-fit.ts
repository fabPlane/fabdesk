import type {
  MechanicalDesign,
  MechanicalBox,
  MechanicalFitReport,
  MechanicalFitIssue,
} from "@fabdesk/protocol";
import {
  cableAssessments,
  portEnvelopes,
  defaultConnectorAccess,
  connectorOpening,
  enclosureOpeningClearance,
  openingContains,
} from "@fabdesk/protocol";
import type { BoardFeatures, Rect } from "./board-features";
import { generateEnclosure, type EnclosureCutout } from "./enclosure";
import { enclosureHardware } from "./enclosure-hardware";

export type FitBoard = { placement: MechanicalDesign["boards"][number]; features: BoardFeatures };
const eps = 1e-5;
export function boardPoint(b: FitBoard, x: number, y: number) {
  const a = (b.placement.rotation * Math.PI) / 180;
  return {
    x: b.placement.x + x * Math.cos(a) - y * Math.sin(a),
    y: b.placement.y + x * Math.sin(a) + y * Math.cos(a),
  };
}
function bounds(b: FitBoard, r: Rect): Rect {
  const points = [
    [r.minX, r.minY],
    [r.maxX, r.minY],
    [r.maxX, r.maxY],
    [r.minX, r.maxY],
  ].map(([x, y]) => boardPoint(b, x!, y!));
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
function box(r: Rect, z: number, height: number, name: string): MechanicalBox {
  return { name, x: r.minX, y: r.minY, z, width: r.maxX - r.minX, depth: r.maxY - r.minY, height };
}
export function boxesOverlap(a: MechanicalBox, b: MechanicalBox, gap = 0) {
  return (
    a.x < b.x + b.width + gap - eps &&
    a.x + a.width + gap > b.x + eps &&
    a.y < b.y + b.depth + gap - eps &&
    a.y + a.depth + gap > b.y + eps &&
    a.z < b.z + b.height + gap - eps &&
    a.z + a.height + gap > b.z + eps
  );
}
export function boardVolumes(b: FitBoard): MechanicalBox[] {
  return [
    box(bounds(b, b.features.outline), b.placement.z, b.features.thicknessMm, "PCB"),
    ...(
      b.features.components ??
      [...b.features.tallParts, ...b.features.connectors].map((p) => ({ ...p, bottom: false }))
    ).map((p) =>
      box(
        bounds(b, p.bounds),
        p.bottom ? b.placement.z - p.heightMm : b.placement.z + b.features.thicknessMm,
        p.heightMm,
        p.ref,
      ),
    ),
  ];
}
export function checkMechanicalFit(d: MechanicalDesign, boards: FitBoard[]): MechanicalFitReport {
  const s = d.space,
    allowance = 2 * (d.fitAllowance ?? 0),
    c = s.clearance + allowance;
  const issues: MechanicalFitIssue[] = [...enclosureHardware(d, boards).issues];
  const add = (
    code: string,
    message: string,
    severity: MechanicalFitIssue["severity"] = "error",
    regions: MechanicalBox[] = [],
  ) => issues.push({ code, message, severity, ...(regions.length ? { regions } : {}) });
  const mountRegion = (m: MechanicalDesign["mounts"][number]): MechanicalBox => ({
    name: "Mounting post",
    x: m.x - m.outer / 2,
    y: m.y - m.outer / 2,
    z: s.floor,
    width: m.outer,
    depth: m.outer,
    height: m.height,
  });
  if (!d.confirmed)
    add("dimensions", "Confirm enclosure dimensions and units before building or exporting.");
  if (!boards.length)
    add(
      "no-board",
      "No PCB included yet. This is an enclosure-only preview; add a board to check fit.",
      "review",
    );
  const all = boards.map((b) => ({ b, volumes: boardVolumes(b) }));
  for (const { b, volumes } of all) {
    const label = b.placement.path;
    const hasAlignedPost = d.mounts.some(
      (m) =>
        (!m.boardPath || m.boardPath === label) &&
        b.features.holes.some((h) => {
          const p = boardPoint(b, h.x, h.y);
          return (
            h.shape !== "slot" &&
            h.purpose !== "component" &&
            (!m.holeId || m.holeId === h.id) &&
            Math.hypot(p.x - m.x, p.y - m.y) < 0.05 &&
            Math.abs(s.floor + m.height - b.placement.z) < 0.05 &&
            m.diameter <= h.diameterMm
          );
        }),
    );
    if (!hasAlignedPost && !d.holders?.some((h) => h.boardPath === label))
      add(
        "mount-none",
        `${label}: no aligned supporting screw posts. Choose a retention method; boards without mounting holes need a holder or another reviewed restraint.`,
        "review",
        [volumes[0]!],
      );
    for (const v of volumes) {
      if (
        v.x < s.x + c - eps ||
        v.x + v.width > s.x + s.width - c + eps ||
        v.y < s.y + c - eps ||
        v.y + v.depth > s.y + s.depth - c + eps ||
        v.z < s.floor + c - eps ||
        v.z + v.height > s.floor + s.height - c + eps
      )
        add(
          "outside-space",
          `${label}: ${v.name} exceeds the usable space or required clearance.`,
          "error",
          [v],
        );
      for (const o of d.obstacles)
        if (boxesOverlap(v, o, c))
          add("obstacle", `${label}: ${v.name} overlaps or is too close to ${o.name}.`, "error", [
            v,
            o,
          ]);
    }
    for (const warning of b.features.warnings)
      add("board-geometry", `${label}: ${warning}`, "review");
    for (const m of d.mounts) {
      const post = mountRegion(m);
      // A post outside the board's center bounds can still reach an overhanging part or edge.
      for (const v of volumes.filter((v) => v.name !== "PCB"))
        if (boxesOverlap(post, v, c))
          add(
            "mount-collision",
            `${label}: mounting post overlaps or is too close to ${v.name}.`,
            "error",
            [post, v],
          );
      if (boxesOverlap(post, volumes[0]!))
        add("mount-height", `${label}: mounting point intersects the PCB.`, "error", [post]);
      // A linked post only needs a matching hole in its own PCB. Physical collisions
      // with every other board/part above are still checked independently.
      if (m.boardPath && m.boardPath !== label) continue;
      const outline = bounds(b, b.features.outline);
      if (m.x < outline.minX || m.x > outline.maxX || m.y < outline.minY || m.y > outline.maxY)
        continue;
      const hole = b.features.holes.find((h) => {
        const p = boardPoint(b, h.x, h.y);
        return (
          h.shape !== "slot" &&
          h.purpose !== "component" &&
          (!m.boardPath || m.boardPath === label) &&
          (!m.holeId || h.id === m.holeId) &&
          Math.hypot(p.x - m.x, p.y - m.y) < 0.05 &&
          h.diameterMm + eps >= m.diameter
        );
      });
      if (!hole)
        add(
          "mount-hole",
          `${label}: mounting point at ${m.x}, ${m.y} has no matching PCB hole.`,
          "error",
          [mountRegion(m)],
        );
      if (hole) {
        if (m.screwDiameter && m.screwDiameter > hole.diameterMm)
          add("screw-shaft", `${label}: the screw shaft is wider than the PCB hole.`, "error", [
            post,
          ]);
        if (
          m.screwLength &&
          (m.screwLength <= b.features.thicknessMm ||
            m.screwLength > b.features.thicknessMm + m.height)
        )
          add(
            "screw-length",
            `${label}: the screw must reach below the PCB without extending past the blind post bore into the floor. Length is measured below the head.`,
            "error",
            [post],
          );
        if (Math.abs(s.floor + m.height - b.placement.z) > 0.05)
          add(
            "mount-support",
            `${label}: post does not meet the PCB underside. Align its height to support the board.`,
            "error",
            [post],
          );
        if (m.outer <= hole.diameterMm + 1)
          add(
            "mount-bearing",
            `${label}: the post needs more supporting material around the PCB hole.`,
            "error",
            [post],
          );
        if (!m.headDiameter || !m.headHeight || !m.screwDiameter || !m.screwLength) {
          if (
            !issues.some(
              (i) => i.code === "screw-head-unknown" && i.message.startsWith(`${label}:`),
            )
          )
            add(
              "screw-head-unknown",
              `${label}: enter the actual screw shaft, length and head dimensions for its mounting posts.`,
              "review",
              [post],
            );
        }
        if (m.headDiameter && m.headHeight) {
          const head: MechanicalBox = {
            name: "Screw head",
            x: m.x - m.headDiameter / 2,
            y: m.y - m.headDiameter / 2,
            z: b.placement.z + b.features.thicknessMm,
            width: m.headDiameter,
            depth: m.headDiameter,
            height: m.headHeight,
          };
          if (m.headDiameter <= hole.diameterMm)
            add(
              "screw-head-size",
              `${label}: the screw head could pass through the PCB hole. Use the actual head/washer diameter.`,
              "error",
              [head],
            );
          if (
            head.z + head.height + c > s.floor + s.height ||
            head.x < s.x + c ||
            head.y < s.y + c ||
            head.x + head.width > s.x + s.width - c ||
            head.y + head.depth > s.y + s.depth - c
          )
            add(
              "screw-head-clearance",
              `${label}: screw head is too close to the lid or walls.`,
              "error",
              [head],
            );
          for (const other of [
            ...all.flatMap((entry) =>
              entry.volumes.filter((v) => entry.b !== b || v.name !== "PCB"),
            ),
            ...d.obstacles,
          ])
            if (boxesOverlap(head, other, c))
              add(
                "screw-head-clearance",
                `${label}: screw head overlaps or is too close to ${other.name}.`,
                "error",
                [head, other],
              );
        }
      }
    }
    for (const connector of b.features.connectors) {
      const profile = d.portAccess?.find((p) => p.boardPath === label && p.ref === connector.ref);
      const access =
        d.portAccess?.find((p) => p.boardPath === label && p.ref === connector.ref)?.access ??
        defaultConnectorAccess(connector.footprint);
      if (access === "internal") continue;
      const envelope = bounds(b, connector.bounds);
      const p = { x: (envelope.minX + envelope.maxX) / 2, y: (envelope.minY + envelope.maxY) / 2 };
      const bottom = b.features.components?.find((part) => part.ref === connector.ref)?.bottom;
      const z0 = bottom
        ? b.placement.z - connector.heightMm
        : b.placement.z + b.features.thicknessMm;
      const aperture = connectorOpening(
        connector,
        profile?.face ?? connector.edge,
        profile?.aperture,
      );
      const apertureCenter = boardPoint(b, aperture.x, aperture.y);
      const apertureHeight = aperture.height;
      const padding = enclosureOpeningClearance(d);
      const apertureZ =
        (bottom ? b.placement.z - aperture.centerZ : z0 + aperture.centerZ) - apertureHeight / 2;
      const openings = d.openings.filter((o) => {
        if (o.boardPath && (o.boardPath !== label || o.ref !== connector.ref)) return false;
        if (o.boardPath) {
          const edges = ["maxX", "maxY", "minX", "minY"] as const;
          const turn = ((b.placement.rotation % 360) + 360) % 360;
          const facing = edges[(edges.indexOf(profile?.face ?? connector.edge) + turn / 90) % 4];
          if (o.wall !== facing) return false;
          // A linked opening can be correctly aligned with a recessed socket.
          // Check the actual plug's mating reach below; a distance heuristic
          // must not report a correctly cut opening as missing.
        }
        const vertical = o.wall === "minX" || o.wall === "maxX";
        const along = vertical ? apertureCenter.y : apertureCenter.x;
        const at = vertical ? p.x : p.y;
        const alongWidth = aperture.width;
        const acrossDepth = vertical
          ? envelope.maxX - envelope.minX
          : envelope.maxY - envelope.minY;
        const wall =
          o.wall === "minX"
            ? s.x
            : o.wall === "maxX"
              ? s.x + s.width
              : o.wall === "minY"
                ? s.y
                : s.y + s.depth;
        return (
          (o.boardPath || Math.abs(at - wall) <= acrossDepth + s.wall + c) &&
          Math.abs(along - o.offset) + alongWidth / 2 + padding <= o.width / 2 + eps &&
          o.z <= apertureZ - padding + eps &&
          o.z + o.height >= apertureZ + apertureHeight + padding - eps &&
          openingContains(
            o,
            {
              width: alongWidth + 2 * padding,
              height: apertureHeight + 2 * padding,
              shape: aperture.shape,
            },
            along - o.offset,
            apertureZ + apertureHeight / 2 - (o.z + o.height / 2),
          )
        );
      });
      if (!openings.length)
        add("connector-opening", `${label}: review an opening for ${connector.ref}.`, "review");
      if (!profile?.aperture || !profile.plug)
        add(
          "port-measurements",
          `${label}: ${connector.ref} needs measured opening and plug dimensions. Footprint bounds do not establish mating access.`,
          "review",
        );
    }
  }
  for (const cable of cableAssessments(d, boards)) {
    if (cable.distance === null)
      add(
        "cable-endpoint",
        `Cable ${cable.id}: a connector is missing. Choose both endpoints again.`,
      );
    else if (!cable.reachable)
      add(
        "cable-length",
        `Cable ${cable.id}: needs at least ${cable.required!.toFixed(1)} mm including slack; only ${cable.length} mm is available.`,
      );
    else
      add(
        "cable-routing",
        `Cable ${cable.id}: ${cable.distance.toFixed(1)} mm direct distance + ${cable.slack} mm slack fits ${cable.length} mm. Confirm the actual bend path and assembly access.`,
        "review",
      );
  }
  const ports = portEnvelopes(d, boards);
  for (let i = 0; i < ports.length; i++) {
    const p = ports[i]!,
      profile = d.portAccess?.find((c) => c.boardPath === p.boardPath && c.ref === p.ref);
    if (profile?.wall && p.face !== profile.wall)
      add("port-wall", `${p.boardPath}: ${p.ref} does not face its chosen wall.`);
    if (p.reach !== null && p.reach + eps < p.gap + s.wall + allowance)
      add(
        "plug-reach",
        `${p.boardPath}: ${p.ref} needs ${(p.gap + s.wall + allowance).toFixed(2)} mm mating reach through the wall including fit allowance; the specified plug allows ${p.reach} mm.`,
        "error",
        p.plug ? [p.plug] : [],
      );
    if (p.plug) {
      if (
        [...boards.flatMap(boardVolumes), ...d.obstacles].some((v) => boxesOverlap(p.plug!, v, c))
      )
        add(
          "plug-collision",
          `${p.boardPath}: ${p.ref} plug access overlaps a board or reserved space.`,
          "error",
          [p.plug],
        );
      for (const other of ports.slice(i + 1))
        if (other.plug && boxesOverlap(p.plug, other.plug, c))
          add(
            "plug-collision",
            `${p.ref} and ${other.ref}: plug bodies need more separation.`,
            "error",
            [p.plug, other.plug],
          );
    }
  }
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const left = all[i]!.volumes.filter((a) =>
        all[j]!.volumes.some((b) => boxesOverlap(a, b, c)),
      );
      if (left.length)
        add(
          "board-collision",
          `${all[i]!.b.placement.path} and ${all[j]!.b.placement.path} have overlapping clearance envelopes.`,
          "error",
          [...left, ...all[j]!.volumes.filter((b) => left.some((a) => boxesOverlap(a, b, c)))],
        );
    }
  for (const o of d.openings) {
    const vertical = o.wall === "minX" || o.wall === "maxX";
    const lo = vertical ? s.y : s.x,
      hi = lo + (vertical ? s.depth : s.width);
    if (
      o.offset - o.width / 2 < lo ||
      o.offset + o.width / 2 > hi ||
      o.z < s.floor ||
      o.z + o.height > s.floor + s.height
    )
      add(
        "opening-bounds",
        `${o.name} extends beyond its wall. Resize or reposition it.`,
        "error",
        [
          {
            name: o.name,
            x: vertical
              ? o.wall === "minX"
                ? s.x - s.wall
                : s.x + s.width
              : o.offset - o.width / 2,
            y: vertical ? o.offset - o.width / 2 : o.wall === "minY" ? s.y - s.wall : s.y + s.depth,
            z: o.z,
            width: vertical ? s.wall : o.width,
            depth: vertical ? o.width : s.wall,
            height: o.height,
          },
        ],
      );
  }
  for (const [i, m] of d.mounts.entries()) {
    if (
      m.boardPath &&
      !boards.some(
        (b) => b.placement.path === m.boardPath && b.features.holes.some((h) => h.id === m.holeId),
      )
    )
      add(
        "mount-hole",
        "A linked PCB hole is missing. Review or remove its mounting post.",
        "error",
        [mountRegion(m)],
      );
    if (m.boardPath) {
      const linkedBoard = boards.find((b) => b.placement.path === m.boardPath);
      const linkedHole = linkedBoard?.features.holes.find((h) => h.id === m.holeId);
      if (linkedBoard && linkedHole) {
        const p = boardPoint(linkedBoard, linkedHole.x, linkedHole.y);
        if (
          linkedHole.shape === "slot" ||
          linkedHole.purpose === "component" ||
          Math.hypot(p.x - m.x, p.y - m.y) >= 0.05
        )
          add(
            "mount-hole",
            `${m.boardPath}: linked post is not aligned to a round mounting hole. Align or remove it.`,
            "error",
            [mountRegion(m)],
          );
      }
    }
    if (m.outer - m.diameter < 2 - eps)
      add(
        "mount-wall",
        "A mounting post has less than 1 mm of material around its bore.",
        "error",
        [mountRegion(m)],
      );
    for (const other of d.mounts.slice(i + 1))
      if (Math.hypot(m.x - other.x, m.y - other.y) < (m.outer + other.outer) / 2 + c)
        add("mount-overlap", "Mounting posts overlap or are too close together.", "error", [
          mountRegion(m),
          mountRegion(other),
        ]);
    if (
      m.x - m.outer / 2 < s.x ||
      m.x + m.outer / 2 > s.x + s.width ||
      m.y - m.outer / 2 < s.y ||
      m.y + m.outer / 2 > s.y + s.depth
    )
      add("mount-bounds", "A mounting point extends outside the interior.", "error", [
        mountRegion(m),
      ]);
  }
  add(
    "coverage",
    "Checks use PCB outlines, component bounding boxes and estimated heights. Review actual component heights, cables, fasteners and manufacturing tolerances.",
    "review",
  );
  if (d.mode === "imported")
    add(
      "import-coverage",
      "Imported shell geometry is not included in the bounding-box fit check. Verify the edited shell in CAD before manufacture.",
      "review",
    );
  return {
    status: issues.some((i) => i.severity === "error") ? "blocked" : "review",
    issues,
    boardRevisions: Object.fromEntries(
      boards.map((b) => [b.placement.path, b.features.pcbRevision]),
    ),
    checkedBoards: boards.length,
    coverage:
      "Conservative board/component envelopes against confirmed rectangular interior and obstacles; not a manufacturing certification.",
  };
}

/** Build real case solids from the same coordinates used by the fit checks. */
export function enclosureFromDesign(d: MechanicalDesign, boards: FitBoard[]) {
  const s = d.space;
  const outline = {
    minX: s.x,
    minY: s.y,
    maxX: s.x + s.width,
    maxY: s.y + s.depth,
    widthMm: s.width,
    heightMm: s.depth,
    closed: true,
    source: "gr_rect" as const,
  };
  const features: BoardFeatures = {
    pcbRevision: boards.map((b) => b.features.pcbRevision).join(":"),
    outline,
    thicknessMm: 1.6,
    holes: [],
    connectors: [],
    tallParts: [],
    footprints: 0,
    warnings: [],
  };
  const cutouts: EnclosureCutout[] = d.openings.map((o) => ({
    ref: o.name,
    edge: o.wall,
    center: {
      x: o.wall === "minX" ? s.x : o.wall === "maxX" ? s.x + s.width : o.offset,
      y: o.wall === "minY" ? s.y : o.wall === "maxY" ? s.y + s.depth : o.offset,
      z: o.z + o.height / 2,
    },
    widthMm: o.width,
    heightMm: o.height,
    ...(o.shape ? { shape: o.shape } : {}),
    connector: { x: 0, y: 0, widthMm: o.width, heightMm: o.height },
  }));
  const spec = generateEnclosure(
    features,
    {
      wallMm: s.wall,
      floorMm: s.floor,
      lidMm: s.lid,
      clearanceMm: s.clearance,
      standoffMm: 0,
      lipMm: 0.6,
      lipClearanceMm: 0.25 + 2 * (d.fitAllowance ?? 0),
    },
    new Date(),
    {
      inner: { ...outline, z0: s.floor, z1: s.floor + s.height },
      cutouts,
      standoffs: d.mounts.map((m, i) => ({
        id: `Mount${i + 1}`,
        x: m.x,
        y: m.y,
        innerDiameterMm: m.diameter,
        outerDiameterMm: m.outer,
        heightMm: m.height,
      })),
    },
  );
  spec.solids.push(...enclosureHardware(d, boards).solids);
  return spec;
}

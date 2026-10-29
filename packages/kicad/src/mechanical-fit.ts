import type {
  MechanicalDesign,
  MechanicalBox,
  MechanicalFitReport,
  MechanicalFitIssue,
} from "@fabdesk/protocol";
import type { BoardFeatures, Rect } from "./board-features";
import { generateEnclosure, type EnclosureCutout } from "./enclosure";

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
    c = s.clearance;
  const issues: MechanicalFitIssue[] = [];
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
      const outline = bounds(b, b.features.outline);
      if (m.x < outline.minX || m.x > outline.maxX || m.y < outline.minY || m.y > outline.maxY)
        continue;
      const hole = b.features.holes.find((h) => {
        const p = boardPoint(b, h.x, h.y);
        return Math.hypot(p.x - m.x, p.y - m.y) < 0.15 && h.diameterMm + eps >= m.diameter;
      });
      if (!hole)
        add(
          "mount-hole",
          `${label}: mounting point at ${m.x}, ${m.y} has no matching PCB hole.`,
          "error",
          [mountRegion(m)],
        );
    }
    for (const connector of b.features.connectors) {
      const envelope = bounds(b, connector.bounds);
      const p = { x: (envelope.minX + envelope.maxX) / 2, y: (envelope.minY + envelope.maxY) / 2 };
      const bottom = b.features.components?.find((part) => part.ref === connector.ref)?.bottom;
      const z0 = bottom
        ? b.placement.z - connector.heightMm
        : b.placement.z + b.features.thicknessMm;
      const z1 = bottom ? b.placement.z : z0 + connector.heightMm;
      const openings = d.openings.filter((o) => {
        const vertical = o.wall === "minX" || o.wall === "maxX";
        const along = vertical ? p.y : p.x;
        const at = vertical ? p.x : p.y;
        const alongWidth = vertical ? envelope.maxY - envelope.minY : envelope.maxX - envelope.minX;
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
          Math.abs(at - wall) <= acrossDepth + s.wall + c &&
          Math.abs(along - o.offset) + alongWidth / 2 + c <= o.width / 2 + eps &&
          o.z <= z0 + eps &&
          o.z + o.height >= z1 - eps
        );
      });
      if (!openings.length)
        add("connector-opening", `${label}: review an opening for ${connector.ref}.`, "review");
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
  for (const m of d.mounts)
    if (
      m.x - m.outer / 2 < s.x ||
      m.x + m.outer / 2 > s.x + s.width ||
      m.y - m.outer / 2 < s.y ||
      m.y + m.outer / 2 > s.y + s.depth
    )
      add("mount-bounds", "A mounting point extends outside the interior.", "error", [
        mountRegion(m),
      ]);
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
    connector: { x: 0, y: 0, widthMm: o.width, heightMm: o.height },
  }));
  return generateEnclosure(
    features,
    {
      wallMm: s.wall,
      floorMm: s.floor,
      lidMm: s.lid,
      clearanceMm: s.clearance,
      standoffMm: 0,
      lipMm: 0.6,
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
}

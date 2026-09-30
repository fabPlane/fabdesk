/** Compact, bounded geographic inspection of the saved native PCB. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES } from "../fs";
import { ToolError, defineTool } from "../registry";
import type { DesignRow, DesignSelect } from "../services";
import { ok, p, table } from "./common";

const Kind = z.enum([
  "components",
  "nets",
  "pads",
  "vias",
  "tracks",
  "zones",
  "keepouts",
  "board_geometry",
  "footprint_geometry",
  "texts",
  "unrouted",
]);
const Region = z.object({
  minX: z.number().finite(),
  minY: z.number().finite(),
  maxX: z.number().finite(),
  maxY: z.number().finite(),
});
const Near = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  radius: z.number().positive().max(1000),
});

type Point = { x: number; y: number };

export const pcb_inspect = defineTool({
  name: "pcb_inspect",
  toolset: "circuit",
  title: "Inspect a PCB region",
  description:
    "Inspect a bounded part of the saved native PCB by item kind, reference, net, layer, rectangle, or point/radius. Layers accept F.Cu, BL_F_Cu, or the KiCad enum number (3); vias occupy every copper layer they span. board_geometry returns board-owned outline and graphic shapes; request footprint_geometry explicitly for footprint-owned courtyard and fabrication primitives, and include zones to see pour occupancy. islandsOfNet returns the copper islands of those nets (pad/via/track/zone connectivity). Returns compact exact millimetre coordinates, AABB, source revision, bounds, and a truncation indicator.",
  inputSchema: {
    kinds: z
      .array(Kind)
      .min(1)
      .max(11)
      .default(["components", "pads", "tracks", "vias", "unrouted"]),
    references: z.array(z.string().min(1)).max(100).optional(),
    nets: z.array(z.string().min(1)).max(100).optional(),
    layers: z
      .array(z.union([z.string(), z.number().int()]))
      .max(64)
      .optional(),
    region: Region.optional().describe(
      "Inclusive PCB rectangle in millimetres. Items are matched by their body, not their centre: a pad or via whose copper reaches into the rectangle is reported, and a zone covering it is reported. Pad rows carry no rotation, so a pad is matched by its largest dimension in both axes — occupancy is never under-reported and a long thin pad may be reported conservatively.",
    ),
    near: Near.optional().describe("Items touching this point/radius in millimetres"),
    limitPerKind: z.number().int().min(1).max(200).default(50),
    islandsOfNet: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Return connected copper islands for these nets (pad/via/track/zone graph)"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (
    { kinds, references, nets, layers, region, near, limitPerKind, islandsOfNet },
    ctx,
  ) => {
    const project = ctx.requireProject();
    const boardPath = p(project, PROJECT_FILES.boardPcb);
    let revision: string | null;
    try {
      revision = createHash("sha256")
        .update(await readFile(boardPath))
        .digest("hex");
    } catch {
      revision = null;
    }
    if (region && (region.maxX < region.minX || region.maxY < region.minY))
      throw new ToolError(
        "region max coordinates must be greater than or equal to min coordinates",
        "invalid_args",
      );
    const refSet = references ? new Set(references.map((value) => value.toLowerCase())) : null;
    const netSet = nets ? new Set(nets.map((value) => value.toLowerCase())) : null;
    const layerSet = layers ? new Set(layers.map(String)) : null;
    const results: Record<
      string,
      { total: number; returned: number; truncated: boolean; rows: DesignRow[] }
    > = {};
    if (revision === null) {
      for (const kind of kinds)
        results[kind] = { total: 0, returned: 0, truncated: false, rows: [] };
      return ok("PCB not created yet; inspection is empty.", {
        contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" },
        revision: null,
        coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" },
        query: {
          kinds,
          references: references ?? [],
          nets: nets ?? [],
          layers: layers ?? [],
          region: region ?? null,
          near: near ?? null,
        },
        bounds: null,
        results,
      });
    }
    const allPoints: Point[] = [];
    for (const kind of kinds as DesignSelect[]) {
      const rows = await ctx.services.design.query(project.dir, kind);
      const filtered = rows.filter((row) => {
        if (
          refSet &&
          !values(row, [
            "ref",
            "reference",
            "component",
            ...(kind === "footprint_geometry" ? ["owner"] : []),
          ]).some((value) => refSet.has(value.toLowerCase()))
        )
          return false;
        if (
          netSet &&
          !values(row, ["net", "name"]).some((value) => netSet.has(value.toLowerCase()))
        )
          return false;
        if (layerSet && !rowMatchesLayers(row, layerSet)) return false;
        const points = rowPoints(row);
        if (region && !rowTouchesRegion(row, points, region)) return false;
        if (
          near &&
          (points.length === 0 || distanceToRow({ x: near.x, y: near.y }, points) > near.radius)
        )
          return false;
        return true;
      });
      const shown = filtered.slice(0, limitPerKind);
      allPoints.push(...shown.flatMap(rowPoints));
      results[kind] = {
        total: filtered.length,
        returned: shown.length,
        truncated: filtered.length > shown.length,
        rows: shown.map((row) => {
          if (!region && !near) return row;
          const aabb = rowAabb(row, rowPoints(row));
          return aabb ? { ...row, aabb } : row;
        }),
      };
    }
    const bounds = pointBounds(allPoints);
    const sections = Object.entries(results).map(
      ([kind, result]) =>
        `${kind}: ${result.total}${result.truncated ? ` (showing ${result.returned})` : ""}${result.rows.length ? `\n${table(result.rows)}` : ""}`,
    );
    let islands: CopperIsland[] | undefined;
    if (islandsOfNet?.length) {
      const copper = {
        pads: await ctx.services.design.query(project.dir, "pads"),
        vias: await ctx.services.design.query(project.dir, "vias"),
        tracks: await ctx.services.design.query(project.dir, "tracks"),
        zones: await ctx.services.design.query(project.dir, "zones"),
      };
      islands = islandsOfNet.flatMap((net) => connectedComponentsForNet(net, copper));
      if (islands.length)
        sections.push(
          `islands: ${islands
            .map(
              (island) =>
                `${island.net}#${island.id} ${island.pads.length} pad(s) ${island.vias.length} via(s) ${island.tracks} track(s)`,
            )
            .join("; ")}`,
        );
    }
    return ok(sections.join("\n\n"), {
      contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" },
      revision,
      coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" },
      query: {
        kinds,
        references: references ?? [],
        nets: nets ?? [],
        layers: layers ?? [],
        region: region ?? null,
        near: near ?? null,
        islandsOfNet: islandsOfNet ?? [],
      },
      bounds,
      results,
      ...(islands ? { islands } : {}),
    });
  },
});

/**
 * Does this item actually occupy any of the region?
 *
 * Testing `rowPoints` alone asks whether a zero-area representative point falls inside, which
 * under-reports occupancy in the two cases that matter most for finding a free lane: a pad or via
 * whose body overlaps the region while its centre sits outside, and a pour that covers the region
 * without any outline vertex or edge inside it. Both report "empty" over real copper. Widen the
 * item to its true extent, and test containment as well as crossing.
 */
export function rowTouchesRegion(
  row: DesignRow,
  points: Point[],
  region: z.infer<typeof Region>,
): boolean {
  const pad = rowExtent(row);
  if (pad) {
    for (const point of points)
      if (
        point.x + pad >= region.minX &&
        point.x - pad <= region.maxX &&
        point.y + pad >= region.minY &&
        point.y - pad <= region.maxY
      )
        return true;
  }
  if (points.length && touchesRegion(points, region)) return true;
  // A pour or polygon large enough to contain the whole region has no vertex inside it and no
  // edge crossing it, so the segment test above cannot see it.
  if (points.length >= 3 && polygonCoversRegion(points, region)) return true;
  return false;
}

/**
 * Half-extent in millimetres by which an item's body exceeds its representative point.
 *
 * Deliberately the **circumscribing** half-extent, not a per-axis one. A pad row carries
 * `width`/`height` in the pad's own frame and no rotation (`fp-pcb-design.ts` builds it from
 * `pad.size.x/y`), so an axis-aligned box cannot be derived: a rotated 4 x 1 mm pad would be
 * reported 1 mm tall while occupying 4 mm. Taking the largest dimension in both axes can only
 * over-report, never under-report.
 *
 * The cost is that a long thin pad is treated as a square, so a region query can call a lane
 * occupied when a rotation would have left it clear — conservative, and the tool description says
 * so. Do not "tighten" this to per-axis without a rotation on the row: under-reporting occupancy
 * is the defect this exists to prevent, and it puts copper into copper.
 */
function rowExtent(row: DesignRow): number {
  const num = (key: string): number => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? value : 0;
  };
  const span = Math.max(num("width"), num("height"), num("diameter"), num("size"));
  return span > 0 ? span / 2 : 0;
}

function polygonCoversRegion(points: Point[], region: z.infer<typeof Region>): boolean {
  const corners: Point[] = [
    { x: region.minX, y: region.minY },
    { x: region.maxX, y: region.minY },
    { x: region.maxX, y: region.maxY },
    { x: region.minX, y: region.maxY },
  ];
  return corners.some((corner) => pointInPolygon(corner, points));
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

const COPPER_LAYER_INDEX: Map<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (canonical: string, ...aliases: string[]) => {
    for (const alias of aliases) map.set(alias.toLowerCase(), canonical);
  };
  add("F.Cu", "F.Cu", "BL_F_Cu", "3");
  for (let inner = 1; inner <= 30; inner++)
    add(`In${inner}.Cu`, `In${inner}.Cu`, `BL_In${inner}_Cu`, String(3 + inner));
  add("B.Cu", "B.Cu", "BL_B_Cu", "34");
  return map;
})();

export function canonicalCopperLayer(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return null;
  const token = String(value).trim();
  if (!token) return null;
  return COPPER_LAYER_INDEX.get(token.toLowerCase()) ?? token;
}

export function rowMatchesLayers(row: DesignRow, layerSet: Set<string>): boolean {
  const wanted = new Set(
    [...layerSet]
      .map((token) => canonicalCopperLayer(token))
      .filter((token): token is string => Boolean(token)),
  );
  if (!wanted.size) return true;
  const have = values(row, ["layer", "layers", "layerNames"])
    .map((token) => canonicalCopperLayer(token))
    .filter((token): token is string => Boolean(token));
  // Through vias with no layer field occupy every copper layer.
  if (!have.length)
    return [...wanted].some((layer) => COPPER_LAYER_INDEX.get(layer.toLowerCase()) === layer);
  return have.some((layer) => wanted.has(layer));
}

export type CopperIsland = {
  net: string;
  id: number;
  pads: Array<{ id: string; component: string; number: string; x: number; y: number }>;
  vias: Array<{ id: string; x: number; y: number }>;
  tracks: number;
};

export function connectedComponentsForNet(
  net: string,
  copper: { pads: DesignRow[]; vias: DesignRow[]; tracks: DesignRow[]; zones: DesignRow[] },
): CopperIsland[] {
  const netOf = (row: DesignRow) => String(row["net"] ?? "");
  const pads = copper.pads.filter((row) => netOf(row) === net);
  const vias = copper.vias.filter((row) => netOf(row) === net);
  const tracks = copper.tracks.filter((row) => netOf(row) === net && row["start"] && row["end"]);
  const zones = copper.zones.filter((row) => netOf(row) === net);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const now = parent.get(key) ?? key;
    if (now !== key) parent.set(key, find(now));
    return parent.get(key) ?? key;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const padKey = (row: DesignRow, index: number) => `pad:${String(row["id"] ?? index)}`;
  const viaKey = (row: DesignRow, index: number) => `via:${String(row["id"] ?? index)}`;
  const trackKey = (row: DesignRow, index: number) => `track:${String(row["id"] ?? index)}`;
  for (const [index, row] of pads.entries()) parent.set(padKey(row, index), padKey(row, index));
  for (const [index, row] of vias.entries()) parent.set(viaKey(row, index), viaKey(row, index));
  for (const [index, row] of tracks.entries())
    parent.set(trackKey(row, index), trackKey(row, index));
  const xy = (row: DesignRow): Point | null => {
    const x = Number(row["x"]);
    const y = Number(row["y"]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
  const touches = (point: Point, row: DesignRow): boolean => {
    const at = xy(row);
    if (!at) return false;
    const radius = Math.max(rowExtent(row), 0.05);
    return Math.hypot(point.x - at.x, point.y - at.y) <= radius;
  };
  for (const [tIndex, track] of tracks.entries()) {
    const points = rowPoints(track);
    for (const point of points) {
      for (const [index, pad] of pads.entries())
        if (touches(point, pad)) union(trackKey(track, tIndex), padKey(pad, index));
      for (const [index, via] of vias.entries())
        if (touches(point, via)) union(trackKey(track, tIndex), viaKey(via, index));
    }
  }
  for (const [pIndex, pad] of pads.entries()) {
    const at = xy(pad);
    if (!at) continue;
    for (const [index, via] of vias.entries())
      if (touches(at, via)) union(padKey(pad, pIndex), viaKey(via, index));
  }
  for (const zone of zones) {
    const polygon = rowPoints(zone);
    if (polygon.length < 3) continue;
    const inside: string[] = [];
    for (const [index, pad] of pads.entries()) {
      const at = xy(pad);
      if (at && pointInPolygon(at, polygon)) inside.push(padKey(pad, index));
    }
    for (const [index, via] of vias.entries()) {
      const at = xy(via);
      if (at && pointInPolygon(at, polygon)) inside.push(viaKey(via, index));
    }
    for (let i = 1; i < inside.length; i++) union(inside[0]!, inside[i]!);
  }
  const groups = new Map<
    string,
    { pads: CopperIsland["pads"]; vias: CopperIsland["vias"]; tracks: number }
  >();
  for (const [index, row] of pads.entries()) {
    const root = find(padKey(row, index));
    const group = groups.get(root) ?? { pads: [], vias: [], tracks: 0 };
    const at = xy(row);
    group.pads.push({
      id: String(row["id"] ?? ""),
      component: String(row["component"] ?? ""),
      number: String(row["number"] ?? ""),
      x: at?.x ?? 0,
      y: at?.y ?? 0,
    });
    groups.set(root, group);
  }
  for (const [index, row] of vias.entries()) {
    const root = find(viaKey(row, index));
    const group = groups.get(root) ?? { pads: [], vias: [], tracks: 0 };
    const at = xy(row);
    group.vias.push({ id: String(row["id"] ?? ""), x: at?.x ?? 0, y: at?.y ?? 0 });
    groups.set(root, group);
  }
  for (const [index, row] of tracks.entries()) {
    const root = find(trackKey(row, index));
    const group = groups.get(root) ?? { pads: [], vias: [], tracks: 0 };
    group.tracks += 1;
    groups.set(root, group);
  }
  return [...groups.values()]
    .filter((group) => group.pads.length || group.vias.length)
    .sort((a, b) => b.pads.length + b.vias.length - (a.pads.length + a.vias.length))
    .map((group, id) => ({ net, id, ...group }));
}

function rowAabb(
  row: DesignRow,
  points: Point[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pad = rowExtent(row);
  const expanded: Point[] = [];
  for (const point of points) {
    expanded.push(point);
    if (pad)
      expanded.push({ x: point.x - pad, y: point.y - pad }, { x: point.x + pad, y: point.y + pad });
  }
  return pointBounds(expanded);
}

function values(row: DesignRow, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) out.push(...value.map(String));
    else if (value !== undefined && value !== null) out.push(String(value));
  }
  return out;
}

export function rowPoints(row: DesignRow): Point[] {
  const out: Point[] = [];
  addPoint(out, row["x"], row["y"]);
  for (const key of ["start", "end", "from", "to", "position", "center", "mid"])
    addUnknownPoint(out, row[key]);
  const points = row["points"];
  if (Array.isArray(points)) {
    if (points.every((value) => typeof value === "number")) {
      for (let index = 0; index + 1 < points.length; index += 2)
        addPoint(out, points[index], points[index + 1]);
    } else for (const point of points) addUnknownPoint(out, point);
  }
  return out;
}

function addUnknownPoint(out: Point[], value: unknown): void {
  if (typeof value === "string") {
    const [x, y] = value.split(",").map(Number);
    addPoint(out, x, y);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const point = value as Record<string, unknown>;
    addPoint(out, point["x"], point["y"]);
  }
}

function addPoint(out: Point[], x: unknown, y: unknown): void {
  const px = Number(x),
    py = Number(y);
  if (Number.isFinite(px) && Number.isFinite(py)) out.push({ x: px, y: py });
}

function inside(point: Point, region: z.infer<typeof Region>): boolean {
  return (
    point.x >= region.minX &&
    point.x <= region.maxX &&
    point.y >= region.minY &&
    point.y <= region.maxY
  );
}

function touchesRegion(points: Point[], region: z.infer<typeof Region>): boolean {
  if (points.some((point) => inside(point, region))) return true;
  for (let index = 1; index < points.length; index++) {
    if (segmentIntersectsRegion(points[index - 1]!, points[index]!, region)) return true;
  }
  return false;
}

/** Liang-Barsky clipping: true when any part of the segment lies in the rectangle. */
function segmentIntersectsRegion(
  start: Point,
  end: Point,
  region: z.infer<typeof Region>,
): boolean {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  let low = 0,
    high = 1;
  for (const [p, q] of [
    [-dx, start.x - region.minX],
    [dx, region.maxX - start.x],
    [-dy, start.y - region.minY],
    [dy, region.maxY - start.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return true;
}

function distanceToRow(point: Point, points: Point[]): number {
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index++)
    best = Math.min(best, distanceToSegment(point, points[index - 1]!, points[index]!));
  return best;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointBounds(
  points: Point[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

export const spatialTools = [pcb_inspect];

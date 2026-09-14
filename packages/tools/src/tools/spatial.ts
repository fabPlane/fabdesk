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
    "Inspect a bounded part of the saved native PCB by item kind, reference, net, layer, rectangle, or point/radius. Returns compact exact millimetre coordinates, source revision, bounds, and a truncation indicator.",
  inputSchema: {
    kinds: z
      .array(Kind)
      .min(1)
      .max(10)
      .default(["components", "pads", "tracks", "vias", "unrouted"]),
    references: z.array(z.string().min(1)).max(100).optional(),
    nets: z.array(z.string().min(1)).max(100).optional(),
    layers: z
      .array(z.union([z.string(), z.number().int()]))
      .max(64)
      .optional(),
    region: Region.optional().describe("Inclusive PCB rectangle in millimetres"),
    near: Near.optional().describe("Items touching this point/radius in millimetres"),
    limitPerKind: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ kinds, references, nets, layers, region, near, limitPerKind }, ctx) => {
    const project = ctx.requireProject();
    const boardPath = p(project, PROJECT_FILES.boardPcb);
    let revision: string;
    try {
      revision = createHash("sha256")
        .update(await readFile(boardPath))
        .digest("hex");
    } catch {
      throw new ToolError("board.kicad_pcb not found", "precondition");
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
    const allPoints: Point[] = [];
    for (const kind of kinds as DesignSelect[]) {
      const rows = await ctx.services.design.query(project.dir, kind);
      const filtered = rows.filter((row) => {
        if (
          refSet &&
          !values(row, ["ref", "reference", "component"]).some((value) =>
            refSet.has(value.toLowerCase()),
          )
        )
          return false;
        if (
          netSet &&
          !values(row, ["net", "name"]).some((value) => netSet.has(value.toLowerCase()))
        )
          return false;
        if (layerSet && !values(row, ["layer", "layers"]).some((value) => layerSet.has(value)))
          return false;
        const points = rowPoints(row);
        if (region && (points.length === 0 || !touchesRegion(points, region))) return false;
        if (
          near &&
          (points.length === 0 || distanceToRow({ x: near.x, y: near.y }, points) > near.radius)
        )
          return false;
        allPoints.push(...points);
        return true;
      });
      const shown = filtered.slice(0, limitPerKind);
      results[kind] = {
        total: filtered.length,
        returned: shown.length,
        truncated: filtered.length > shown.length,
        rows: shown,
      };
    }
    const bounds = pointBounds(allPoints);
    const sections = Object.entries(results).map(
      ([kind, result]) =>
        `${kind}: ${result.total}${result.truncated ? ` (showing ${result.returned})` : ""}${result.rows.length ? `\n${table(result.rows)}` : ""}`,
    );
    return ok(sections.join("\n\n"), {
      revision,
      coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" },
      query: {
        kinds,
        references: references ?? [],
        nets: nets ?? [],
        layers: layers ?? [],
        region: region ?? null,
        near: near ?? null,
      },
      bounds,
      results,
    });
  },
});

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

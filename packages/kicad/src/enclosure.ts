export { previewEnclosureSvg } from "./enclosure-preview";

/**
 * Parametric printable enclosure from {@link extractBoardFeatures}: a two-piece clamshell
 * (base + lid) that follows the board outline, mounting holes and edge-connector cutouts.
 *
 * The fused triangle mesh (STL) is the printable truth. STEP is an assembly of the same
 * axis-aligned boxes so a CAD tool can open the case without FreeCAD. When a FreeCAD session
 * is available, the `cad` toolset also mirrors the primitives into `model.FCStd`.
 */
import type { BoardEdge, BoardFeatures, Point, Rect } from "./board-features";

export const ENCLOSURE_CONTRACT = { name: "fabdesk.enclosure", version: "2.0.0" } as const;

export type VentPattern = "none" | "grid" | "slots" | "honeycomb";
export type VentFace = "lid" | "walls" | "both";

export type EnclosureParams = {
  wallMm: number;
  /** Gap between the board outline and the inner cavity. */
  clearanceMm: number;
  /** Extra outward offset applied after clearance (larger case without changing the board gap). */
  outlineOffsetMm: number;
  floorMm: number;
  lidMm: number;
  standoffMm: number;
  /** Extra air above the tallest part. */
  headroomMm: number;
  cutoutClearanceMm: number;
  lipMm: number;
  ventPattern: VentPattern;
  ventPitchMm: number;
  ventSizeMm: number;
  ventMarginMm: number;
  ventFaces: VentFace;
  snapFit: boolean;
  /** Clips on each long edge. */
  snapCount: number;
  snapWidthMm: number;
  snapDepthMm: number;
  snapHeightMm: number;
  snapOverhangMm: number;
};

export const DEFAULT_ENCLOSURE_PARAMS: EnclosureParams = {
  wallMm: 2,
  clearanceMm: 1,
  outlineOffsetMm: 0,
  floorMm: 2,
  lidMm: 2,
  standoffMm: 3,
  headroomMm: 1.5,
  cutoutClearanceMm: 0.4,
  lipMm: 1,
  ventPattern: "none",
  ventPitchMm: 6,
  ventSizeMm: 2.5,
  ventMarginMm: 6,
  ventFaces: "lid",
  snapFit: false,
  snapCount: 2,
  snapWidthMm: 6,
  snapDepthMm: 1.4,
  snapHeightMm: 4,
  snapOverhangMm: 1.2,
};

export type EnclosureSolid = {
  name: string;
  kind: "box" | "cylinder";
  role: "floor" | "wall" | "lid" | "lip" | "standoff" | "clip";
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  radiusMm?: number;
};

export type EnclosureVent = {
  id: string;
  face: "lid" | "wall";
  edge?: BoardEdge;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

export type EnclosureClip = {
  id: string;
  edge: BoardEdge;
  x: number;
  y: number;
  widthMm: number;
};

export type EnclosureCutout = {
  ref: string;
  edge: BoardEdge;
  /** Opening on the wall, board XY plus Z-up from the case floor. */
  center: { x: number; y: number; z: number };
  widthMm: number;
  heightMm: number;
  /** Board-space connector that produced this opening. */
  connector: { x: number; y: number; widthMm: number; heightMm: number };
};

export type EnclosureStandoff = {
  id: string;
  x: number;
  y: number;
  innerDiameterMm: number;
  outerDiameterMm: number;
  heightMm: number;
};

export type EnclosureSpec = {
  contract: typeof ENCLOSURE_CONTRACT;
  pcbRevision: string;
  generatedAt: string;
  params: EnclosureParams;
  board: {
    outline: Rect & { widthMm: number; heightMm: number };
    thicknessMm: number;
    tallestPartMm: number;
  };
  inner: Rect & { z0: number; z1: number };
  outer: Rect & { z0: number; z1: number };
  solids: EnclosureSolid[];
  cutouts: EnclosureCutout[];
  standoffs: EnclosureStandoff[];
  vents: EnclosureVent[];
  clips: EnclosureClip[];
  warnings: string[];
};

export type AlignmentIssue = {
  code: "stale-board" | "missing-connector" | "moved-cutout" | "small-cutout" | "moved-hole" | "missing-hole";
  severity: "error" | "warning";
  message: string;
  ref?: string;
};

export type AlignmentReport = {
  ok: boolean;
  stale: boolean;
  pcbRevision: string;
  specRevision: string;
  issues: AlignmentIssue[];
  checkedCutouts: number;
  checkedStandoffs: number;
};

const mm = (n: number) => Math.round(n * 1e4) / 1e4;
const CUTOUT_POS_TOL_MM = 0.15;
const CUTOUT_SIZE_TOL_MM = 0.05;
const HOLE_POS_TOL_MM = 0.05;

export function mergeEnclosureParams(input: Partial<EnclosureParams> = {}): EnclosureParams {
  return {
    wallMm: input.wallMm ?? DEFAULT_ENCLOSURE_PARAMS.wallMm,
    clearanceMm: input.clearanceMm ?? DEFAULT_ENCLOSURE_PARAMS.clearanceMm,
    outlineOffsetMm: input.outlineOffsetMm ?? DEFAULT_ENCLOSURE_PARAMS.outlineOffsetMm,
    floorMm: input.floorMm ?? DEFAULT_ENCLOSURE_PARAMS.floorMm,
    lidMm: input.lidMm ?? DEFAULT_ENCLOSURE_PARAMS.lidMm,
    standoffMm: input.standoffMm ?? DEFAULT_ENCLOSURE_PARAMS.standoffMm,
    headroomMm: input.headroomMm ?? DEFAULT_ENCLOSURE_PARAMS.headroomMm,
    cutoutClearanceMm: input.cutoutClearanceMm ?? DEFAULT_ENCLOSURE_PARAMS.cutoutClearanceMm,
    lipMm: input.lipMm ?? DEFAULT_ENCLOSURE_PARAMS.lipMm,
    ventPattern: input.ventPattern ?? DEFAULT_ENCLOSURE_PARAMS.ventPattern,
    ventPitchMm: input.ventPitchMm ?? DEFAULT_ENCLOSURE_PARAMS.ventPitchMm,
    ventSizeMm: input.ventSizeMm ?? DEFAULT_ENCLOSURE_PARAMS.ventSizeMm,
    ventMarginMm: input.ventMarginMm ?? DEFAULT_ENCLOSURE_PARAMS.ventMarginMm,
    ventFaces: input.ventFaces ?? DEFAULT_ENCLOSURE_PARAMS.ventFaces,
    snapFit: input.snapFit ?? DEFAULT_ENCLOSURE_PARAMS.snapFit,
    snapCount: input.snapCount ?? DEFAULT_ENCLOSURE_PARAMS.snapCount,
    snapWidthMm: input.snapWidthMm ?? DEFAULT_ENCLOSURE_PARAMS.snapWidthMm,
    snapDepthMm: input.snapDepthMm ?? DEFAULT_ENCLOSURE_PARAMS.snapDepthMm,
    snapHeightMm: input.snapHeightMm ?? DEFAULT_ENCLOSURE_PARAMS.snapHeightMm,
    snapOverhangMm: input.snapOverhangMm ?? DEFAULT_ENCLOSURE_PARAMS.snapOverhangMm,
  };
}

type XyRect = { minX: number; minY: number; maxX: number; maxY: number };

function intersectXy(a: XyRect, b: XyRect): XyRect | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX - minX < 0.05 || maxY - minY < 0.05) return null;
  return { minX, minY, maxX, maxY };
}

function subtractXy(a: XyRect, hole: XyRect): XyRect[] {
  const hit = intersectXy(a, hole);
  if (!hit) return [a];
  const out: XyRect[] = [];
  if (hit.minX - a.minX > 0.05) out.push({ minX: a.minX, minY: a.minY, maxX: hit.minX, maxY: a.maxY });
  if (a.maxX - hit.maxX > 0.05) out.push({ minX: hit.maxX, minY: a.minY, maxX: a.maxX, maxY: a.maxY });
  if (hit.minY - a.minY > 0.05) out.push({ minX: hit.minX, minY: a.minY, maxX: hit.maxX, maxY: hit.minY });
  if (a.maxY - hit.maxY > 0.05) out.push({ minX: hit.minX, minY: hit.maxY, maxX: hit.maxX, maxY: a.maxY });
  return out;
}

/** Remaining axis-aligned rectangles after punching holes out of a plate. */
export function punchRects(base: XyRect, holes: XyRect[]): XyRect[] {
  let pieces = [base];
  for (const hole of holes) pieces = pieces.flatMap((piece) => subtractXy(piece, hole));
  return pieces;
}

function overlapsStandoff(x: number, y: number, size: number, standoffs: EnclosureStandoff[]): boolean {
  const r = size / 2 + 1.2;
  return standoffs.some((s) => Math.hypot(s.x - x, s.y - y) < s.outerDiameterMm / 2 + r);
}

function lidVentRects(
  inner: XyRect,
  params: EnclosureParams,
  standoffs: EnclosureStandoff[],
): XyRect[] {
  if (params.ventPattern === "none" || params.ventFaces === "walls") return [];
  const size = params.ventSizeMm;
  const pitch = Math.max(params.ventPitchMm, size + 0.8);
  const margin = params.ventMarginMm;
  const minX = inner.minX + margin;
  const minY = inner.minY + margin;
  const maxX = inner.maxX - margin;
  const maxY = inner.maxY - margin;
  if (maxX - minX < size || maxY - minY < size) return [];
  const holes: XyRect[] = [];
  if (params.ventPattern === "slots") {
    for (let y = minY, row = 0; y + size <= maxY + 1e-6; y += pitch, row++) {
      const hole = { minX, minY: y, maxX, maxY: y + size };
      if (!standoffs.some((s) => s.y >= hole.minY - 1 && s.y <= hole.maxY + 1)) holes.push(hole);
      if (row > 40) break;
    }
    return holes;
  }
  const rowPitch = params.ventPattern === "honeycomb" ? pitch * Math.sin(Math.PI / 3) : pitch;
  for (let row = 0, y = minY + size / 2; y + size / 2 <= maxY + 1e-6; row++, y += rowPitch) {
    const xOff = params.ventPattern === "honeycomb" && row % 2 === 1 ? pitch / 2 : 0;
    for (let x = minX + size / 2 + xOff; x + size / 2 <= maxX + 1e-6; x += pitch) {
      if (overlapsStandoff(x, y, size, standoffs)) continue;
      holes.push({ minX: x - size / 2, minY: y - size / 2, maxX: x + size / 2, maxY: y + size / 2 });
    }
    if (row > 40) break;
  }
  return holes;
}

function longEdges(inner: XyRect): BoardEdge[] {
  const wide = inner.maxX - inner.minX >= inner.maxY - inner.minY;
  return wide ? ["minY", "maxY"] : ["minX", "maxX"];
}

function clipStations(
  inner: XyRect,
  edge: BoardEdge,
  count: number,
  cutouts: EnclosureCutout[] = [],
  widthMm = 6,
): number[] {
  const lo = edge === "minX" || edge === "maxX" ? inner.minY : inner.minX;
  const hi = edge === "minX" || edge === "maxX" ? inner.maxY : inner.maxX;
  const inset = Math.min(8, Math.max(4, (hi - lo) * 0.18));
  const span = hi - lo - 2 * inset;
  if (span <= 0 || count <= 0) return [];
  const raw =
    count === 1
      ? [mm(lo + (hi - lo) / 2)]
      : Array.from({ length: count }, (_, i) => mm(lo + inset + (span * i) / (count - 1)));
  return raw.filter((pos) => {
    const half = widthMm / 2 + 0.6;
    return !cutouts.some((c) => {
      if (c.edge !== edge) return false;
      const mid = edge === "minX" || edge === "maxX" ? c.center.y : c.center.x;
      return Math.abs(mid - pos) < c.widthMm / 2 + half;
    });
  });
}

function box(
  name: string,
  role: EnclosureSolid["role"],
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
): EnclosureSolid {
  return {
    name,
    kind: "box",
    role,
    min: { x: mm(min.x), y: mm(min.y), z: mm(min.z) },
    max: { x: mm(max.x), y: mm(max.y), z: mm(max.z) },
  };
}

type Box3 = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

function splitWall(
  name: string,
  wall: Box3,
  axis: "x" | "y",
  openings: Array<{ start: number; end: number }>,
): EnclosureSolid[] {
  const lo = axis === "x" ? wall.min.x : wall.min.y;
  const hi = axis === "x" ? wall.max.x : wall.max.y;
  const sorted = [...openings].sort((a, b) => a.start - b.start);
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = lo;
  for (const o of sorted) {
    const start = Math.max(lo, o.start);
    const end = Math.min(hi, o.end);
    if (end <= start) continue;
    if (start - cursor > 0.05) spans.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (hi - cursor > 0.05) spans.push({ start: cursor, end: hi });
  if (!spans.length) return [];
  return spans.map((span, i) =>
    box(
      spans.length === 1 ? name : `${name}_${i + 1}`,
      "wall",
      axis === "x"
        ? { x: span.start, y: wall.min.y, z: wall.min.z }
        : { x: wall.min.x, y: span.start, z: wall.min.z },
      axis === "x"
        ? { x: span.end, y: wall.max.y, z: wall.max.z }
        : { x: wall.max.x, y: span.end, z: wall.max.z },
    ),
  );
}

function subtractAabb(solid: Box3, hole: Box3): Box3[] {
  const ix0 = Math.max(solid.min.x, hole.min.x);
  const iy0 = Math.max(solid.min.y, hole.min.y);
  const iz0 = Math.max(solid.min.z, hole.min.z);
  const ix1 = Math.min(solid.max.x, hole.max.x);
  const iy1 = Math.min(solid.max.y, hole.max.y);
  const iz1 = Math.min(solid.max.z, hole.max.z);
  if (ix1 - ix0 <= 0.05 || iy1 - iy0 <= 0.05 || iz1 - iz0 <= 0.05) return [solid];
  const out: Box3[] = [];
  if (ix0 - solid.min.x > 0.05)
    out.push({ min: { ...solid.min }, max: { x: ix0, y: solid.max.y, z: solid.max.z } });
  if (solid.max.x - ix1 > 0.05)
    out.push({ min: { x: ix1, y: solid.min.y, z: solid.min.z }, max: { ...solid.max } });
  if (iy0 - solid.min.y > 0.05)
    out.push({
      min: { x: ix0, y: solid.min.y, z: solid.min.z },
      max: { x: ix1, y: iy0, z: solid.max.z },
    });
  if (solid.max.y - iy1 > 0.05)
    out.push({
      min: { x: ix0, y: iy1, z: solid.min.z },
      max: { x: ix1, y: solid.max.y, z: solid.max.z },
    });
  if (iz0 - solid.min.z > 0.05)
    out.push({
      min: { x: ix0, y: iy0, z: solid.min.z },
      max: { x: ix1, y: iy1, z: iz0 },
    });
  if (solid.max.z - iz1 > 0.05)
    out.push({
      min: { x: ix0, y: iy0, z: iz1 },
      max: { x: ix1, y: iy1, z: solid.max.z },
    });
  return out;
}

function punchWall(name: string, wall: Box3, holes: Box3[]): EnclosureSolid[] {
  let remain: Box3[] = [wall];
  for (const hole of holes) remain = remain.flatMap((b) => subtractAabb(b, hole));
  if (!remain.length) return [];
  return remain.map((b, i) => box(remain.length === 1 ? name : `${name}_${i + 1}`, "wall", b.min, b.max));
}

function connectorAlong(c: { edge: BoardEdge; x: number; y: number; bounds: Rect }): number {
  const cx = (c.bounds.minX + c.bounds.maxX) / 2;
  const cy = (c.bounds.minY + c.bounds.maxY) / 2;
  const along = c.edge === "minX" || c.edge === "maxX" ? cy : cx;
  return Number.isFinite(along) ? along : c.edge === "minX" || c.edge === "maxX" ? c.y : c.x;
}

/** Build a two-piece case whose cutouts and standoffs track the current board features. */
export function generateEnclosure(
  features: BoardFeatures,
  paramsInput: Partial<EnclosureParams> = {},
  now = new Date(),
  constraints?: {
    inner: EnclosureSpec["inner"];
    cutouts?: EnclosureCutout[];
    standoffs?: EnclosureStandoff[];
  },
): EnclosureSpec {
  const params = mergeEnclosureParams(paramsInput);
  const { outline } = features;
  const tallest = features.tallParts[0]?.heightMm ?? features.connectors.reduce((m, c) => Math.max(m, c.heightMm), 0);
  const cavityHeight = params.standoffMm + features.thicknessMm + Math.max(tallest, 2) + params.headroomMm;
  const pad = params.clearanceMm + params.outlineOffsetMm;
  const inner: EnclosureSpec["inner"] = constraints?.inner ?? {
    minX: mm(outline.minX - pad),
    minY: mm(outline.minY - pad),
    maxX: mm(outline.maxX + pad),
    maxY: mm(outline.maxY + pad),
    z0: mm(params.floorMm),
    z1: mm(params.floorMm + cavityHeight),
  };
  const outer: EnclosureSpec["outer"] = {
    minX: mm(inner.minX - params.wallMm),
    minY: mm(inner.minY - params.wallMm),
    maxX: mm(inner.maxX + params.wallMm),
    maxY: mm(inner.maxY + params.wallMm),
    z0: 0,
    z1: mm(inner.z1 + params.lidMm),
  };
  const warnings = [...features.warnings];
  if (outline.source !== "gr_rect" && outline.source !== "gr_poly")
    warnings.push("enclosure offsets the Edge.Cuts bounding box; non-rectangular outlines are not polygon-offset");
  if (params.outlineOffsetMm > 0)
    warnings.push(`outline offset ${params.outlineOffsetMm} mm is applied outside the ${params.clearanceMm} mm board clearance`);

  const cutouts: EnclosureCutout[] = constraints?.cutouts ?? features.connectors.map((c) => {
    const widthMm = mm(c.widthMm + 2 * params.cutoutClearanceMm);
    const heightMm = mm(c.heightMm + 2 * params.cutoutClearanceMm);
    const z = mm(params.floorMm + params.standoffMm + features.thicknessMm + c.heightMm / 2);
    const along = connectorAlong(c);
    const wall =
      c.edge === "minX" ? inner.minX : c.edge === "maxX" ? inner.maxX : c.edge === "minY" ? inner.minY : inner.maxY;
    return {
      ref: c.ref,
      edge: c.edge,
      center: {
        x: mm(c.edge === "minX" || c.edge === "maxX" ? wall : along),
        y: mm(c.edge === "minY" || c.edge === "maxY" ? wall : along),
        z,
      },
      widthMm,
      heightMm,
      connector: { x: c.x, y: c.y, widthMm: c.widthMm, heightMm: c.heightMm },
    };
  });

  const standoffs: EnclosureStandoff[] = constraints?.standoffs ?? features.holes.filter((h) =>
    h.shape !== "slot" && (h.purpose ? h.purpose === "mounting" : !h.ref || !features.components?.some((p) => p.ref === h.ref))
  ).map((h) => ({
    id: h.id,
    x: h.x,
    y: h.y,
    innerDiameterMm: mm(h.diameterMm),
    outerDiameterMm: mm(h.diameterMm + 2.4),
    heightMm: params.standoffMm,
  }));

  const solids: EnclosureSolid[] = [
    box(
      "EnclosureFloor",
      "floor",
      { x: outer.minX, y: outer.minY, z: 0 },
      { x: outer.maxX, y: outer.maxY, z: params.floorMm },
    ),
  ];

  const vents: EnclosureVent[] = [];
  const plannedClips: Array<{ edge: BoardEdge; pos: number }> = [];
  if (params.snapFit && params.snapCount > 0) {
    for (const edge of longEdges(inner)) {
      for (const pos of clipStations(inner, edge, params.snapCount, cutouts, params.snapWidthMm)) {
        plannedClips.push({ edge, pos });
      }
    }
  }
  const clipKeepout = (edge: BoardEdge, mid: number, size: number): boolean =>
    plannedClips.some(
      (c) => c.edge === edge && Math.abs(c.pos - mid) < params.snapWidthMm / 2 + size + 0.8,
    );
  const wallVentHoles: Record<BoardEdge, Box3[]> = { minX: [], maxX: [], minY: [], maxY: [] };
  if (params.ventPattern !== "none" && params.ventFaces !== "lid") {
    const size = params.ventSizeMm;
    const pitch = Math.max(params.ventPitchMm, size + 1.5);
    const bandZ0 = mm(inner.z0 + Math.min(2.2, (inner.z1 - inner.z0) * 0.28));
    const rowPitch = params.ventPattern === "honeycomb" ? pitch * Math.sin(Math.PI / 3) : pitch;
    const rows =
      params.ventPattern === "slots"
        ? 1
        : Math.max(1, Math.floor((inner.z1 - bandZ0 - 1.2) / rowPitch));
    for (const edge of longEdges(inner)) {
      const lo = edge === "minX" || edge === "maxX" ? inner.minY : inner.minX;
      const hi = edge === "minX" || edge === "maxX" ? inner.maxY : inner.maxX;
      let slot = 0;
      for (let row = 0; row < rows; row++) {
        const zMid = bandZ0 + size / 2 + row * rowPitch;
        if (zMid + size / 2 > inner.z1 - 0.6) break;
        const xOff = params.ventPattern === "honeycomb" && row % 2 === 1 ? pitch / 2 : 0;
        const alongSize = params.ventPattern === "slots" ? Math.max(size, pitch * 0.7) : size;
        const alongPitch = params.ventPattern === "slots" ? pitch : pitch;
        for (
          let mid = lo + params.ventMarginMm + alongSize / 2 + xOff;
          mid + alongSize / 2 <= hi - params.ventMarginMm + 1e-6;
          mid += alongPitch
        ) {
          const hitConnector = cutouts.some((c) => {
            if (c.edge !== edge) return false;
            const along = edge === "minX" || edge === "maxX" ? c.center.y : c.center.x;
            return Math.abs(along - mid) < c.widthMm / 2 + alongSize;
          });
          if (hitConnector || clipKeepout(edge, mid, alongSize)) continue;
          const along0 = mid - alongSize / 2;
          const along1 = mid + alongSize / 2;
          const z0 = zMid - size / 2;
          const z1 = zMid + size / 2;
          const hole: Box3 =
            edge === "minX" || edge === "maxX"
              ? {
                  min: { x: edge === "minX" ? outer.minX : inner.maxX, y: along0, z: z0 },
                  max: { x: edge === "minX" ? inner.minX : outer.maxX, y: along1, z: z1 },
                }
              : {
                  min: { x: along0, y: edge === "minY" ? outer.minY : inner.maxY, z: z0 },
                  max: { x: along1, y: edge === "minY" ? inner.minY : outer.maxY, z: z1 },
                };
          wallVentHoles[edge].push(hole);
          vents.push({ id: `wall-${edge}-${++slot}`, face: "wall", edge, min: hole.min, max: hole.max });
          if (slot > 40) break;
        }
      }
    }
  }

  const wallBox = (
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
  ): Box3 => ({ min, max });
  const holesFor = (edge: BoardEdge, wall: Box3): Box3[] => [
    ...cutouts
      .filter((c) => c.edge === edge)
      .map((c) => {
        const halfW = c.widthMm / 2;
        const halfH = c.heightMm / 2;
        if (edge === "minY" || edge === "maxY") {
          return {
            min: { x: c.center.x - halfW, y: wall.min.y, z: c.center.z - halfH },
            max: { x: c.center.x + halfW, y: wall.max.y, z: c.center.z + halfH },
          };
        }
        return {
          min: { x: wall.min.x, y: c.center.y - halfW, z: c.center.z - halfH },
          max: { x: wall.max.x, y: c.center.y + halfW, z: c.center.z + halfH },
        };
      }),
    ...wallVentHoles[edge],
    ...plannedClips
      .filter((c) => c.edge === edge)
      .flatMap((c) => {
        const half = params.snapWidthMm / 2;
        const gap = 0.7;
        const z0 = mm(inner.z1 - params.snapHeightMm);
        const z1 = inner.z1;
        const slots = [c.pos - half - gap, c.pos + half];
        return slots.map((start) =>
          edge === "minY" || edge === "maxY"
            ? {
                min: { x: start, y: wall.min.y, z: z0 },
                max: { x: start + gap, y: wall.max.y, z: z1 },
              }
            : {
                min: { x: wall.min.x, y: start, z: z0 },
                max: { x: wall.max.x, y: start + gap, z: z1 },
              },
        );
      }),
  ];

  const minY = wallBox(
    { x: outer.minX, y: outer.minY, z: inner.z0 },
    { x: outer.maxX, y: inner.minY, z: inner.z1 },
  );
  const maxY = wallBox(
    { x: outer.minX, y: inner.maxY, z: inner.z0 },
    { x: outer.maxX, y: outer.maxY, z: inner.z1 },
  );
  const minX = wallBox(
    { x: outer.minX, y: inner.minY, z: inner.z0 },
    { x: inner.minX, y: inner.maxY, z: inner.z1 },
  );
  const maxX = wallBox(
    { x: inner.maxX, y: inner.minY, z: inner.z0 },
    { x: outer.maxX, y: inner.maxY, z: inner.z1 },
  );
  solids.push(
    ...punchWall("EnclosureWallMinY", minY, holesFor("minY", minY)),
    ...punchWall("EnclosureWallMaxY", maxY, holesFor("maxY", maxY)),
    ...punchWall("EnclosureWallMinX", minX, holesFor("minX", minX)),
    ...punchWall("EnclosureWallMaxX", maxX, holesFor("maxX", maxX)),
  );

  for (const s of standoffs) {
    const r = s.outerDiameterMm / 2;
    solids.push({
      name: `EnclosureStandoff_${s.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
      kind: "cylinder",
      role: "standoff",
      min: { x: mm(s.x - r), y: mm(s.y - r), z: inner.z0 },
      max: { x: mm(s.x + r), y: mm(s.y + r), z: mm(inner.z0 + s.heightMm) },
      radiusMm: mm(r),
    });
  }

  const clips: EnclosureClip[] = [];
  const clipSlots: XyRect[] = [];
  const lipOpenings: Record<BoardEdge, Array<{ start: number; end: number }>> = {
    minX: [],
    maxX: [],
    minY: [],
    maxY: [],
  };
  if (plannedClips.length) {
    const boardTop = mm(params.floorMm + params.standoffMm + features.thicknessMm + 0.2);
    const stemInward = mm(Math.min(params.snapDepthMm, Math.max(0.3, params.clearanceMm - 0.4)));
    const lead = mm(Math.min(params.snapOverhangMm * 0.45, 0.5));
    for (const [i, { edge, pos }] of plannedClips.entries()) {
        const half = params.snapWidthMm / 2;
        const stemZ0 = mm(Math.max(boardTop, inner.z1 - params.snapHeightMm));
        const stemZ1 = mm(outer.z1 + params.snapOverhangMm);
        const hookZ0 = mm(outer.z1);
        const hookZ1 = mm(outer.z1 + params.snapOverhangMm);
        const id = `clip-${edge}-${i + 1}`;
        const stem =
          edge === "minY"
            ? {
                min: { x: pos - half, y: inner.minY, z: stemZ0 },
                max: { x: pos + half, y: inner.minY + stemInward, z: stemZ1 },
              }
            : edge === "maxY"
              ? {
                  min: { x: pos - half, y: inner.maxY - stemInward, z: stemZ0 },
                  max: { x: pos + half, y: inner.maxY, z: stemZ1 },
                }
              : edge === "minX"
                ? {
                    min: { x: inner.minX, y: pos - half, z: stemZ0 },
                    max: { x: inner.minX + stemInward, y: pos + half, z: stemZ1 },
                  }
                : {
                    min: { x: inner.maxX - stemInward, y: pos - half, z: stemZ0 },
                    max: { x: inner.maxX, y: pos + half, z: stemZ1 },
                  };
        const hook =
          edge === "minY"
            ? {
                min: { x: pos - half, y: inner.minY + stemInward, z: hookZ0 },
                max: { x: pos + half, y: inner.minY + stemInward + params.snapOverhangMm, z: hookZ1 },
              }
            : edge === "maxY"
              ? {
                  min: { x: pos - half, y: inner.maxY - stemInward - params.snapOverhangMm, z: hookZ0 },
                  max: { x: pos + half, y: inner.maxY - stemInward, z: hookZ1 },
                }
              : edge === "minX"
                ? {
                    min: { x: inner.minX + stemInward, y: pos - half, z: hookZ0 },
                    max: { x: inner.minX + stemInward + params.snapOverhangMm, y: pos + half, z: hookZ1 },
                  }
                : {
                    min: { x: inner.maxX - stemInward - params.snapOverhangMm, y: pos - half, z: hookZ0 },
                    max: { x: inner.maxX - stemInward, y: pos + half, z: hookZ1 },
                  };
        const chamfer =
          edge === "minY"
            ? {
                min: { x: pos - half, y: hook.min.y, z: hookZ1 - lead },
                max: { x: pos + half, y: hook.min.y + lead, z: hookZ1 },
              }
            : edge === "maxY"
              ? {
                  min: { x: pos - half, y: hook.max.y - lead, z: hookZ1 - lead },
                  max: { x: pos + half, y: hook.max.y, z: hookZ1 },
                }
              : edge === "minX"
                ? {
                    min: { x: hook.min.x, y: pos - half, z: hookZ1 - lead },
                    max: { x: hook.min.x + lead, y: pos + half, z: hookZ1 },
                  }
                : {
                    min: { x: hook.max.x - lead, y: pos - half, z: hookZ1 - lead },
                    max: { x: hook.max.x, y: pos + half, z: hookZ1 },
                  };
        solids.push(box(`EnclosureClip_${edge}_${i + 1}`, "clip", stem.min, stem.max));
        solids.push(box(`EnclosureClipHook_${edge}_${i + 1}`, "clip", hook.min, hook.max));
        solids.push(box(`EnclosureClipLead_${edge}_${i + 1}`, "clip", chamfer.min, chamfer.max));
        clips.push({
          id,
          edge,
          x: mm(edge === "minX" || edge === "maxX" ? (stem.min.x + stem.max.x) / 2 : pos),
          y: mm(edge === "minY" || edge === "maxY" ? (stem.min.y + stem.max.y) / 2 : pos),
          widthMm: params.snapWidthMm,
        });
        clipSlots.push({
          minX: mm(stem.min.x - 0.3),
          minY: mm(stem.min.y - 0.3),
          maxX: mm(stem.max.x + 0.3),
          maxY: mm(stem.max.y + 0.3),
        });
        lipOpenings[edge].push({ start: pos - half - 0.4, end: pos + half + 0.4 });
    }
  }

  const lidVentHoles = lidVentRects(inner, params, standoffs);
  const lidHoles = [...lidVentHoles, ...clipSlots];
  for (const [i, hole] of lidVentHoles.entries()) {
    vents.push({
      id: `lid-${i + 1}`,
      face: "lid",
      min: { x: mm(hole.minX), y: mm(hole.minY), z: inner.z1 },
      max: { x: mm(hole.maxX), y: mm(hole.maxY), z: outer.z1 },
    });
  }
  const lidPieces = punchRects(
    { minX: outer.minX, minY: outer.minY, maxX: outer.maxX, maxY: outer.maxY },
    lidHoles,
  );
  for (const [i, piece] of lidPieces.entries()) {
    solids.push(
      box(
        lidPieces.length === 1 ? "EnclosureLid" : `EnclosureLid_${i + 1}`,
        "lid",
        { x: piece.minX, y: piece.minY, z: inner.z1 },
        { x: piece.maxX, y: piece.maxY, z: outer.z1 },
      ),
    );
  }

  const lipOpeningsFor = (edge: BoardEdge) => lipOpenings[edge];
  solids.push(
    ...splitWall(
      "EnclosureLidLipMinY",
      {
        min: { x: inner.minX, y: inner.minY, z: mm(inner.z1 - params.lipMm) },
        max: { x: inner.maxX, y: inner.minY + Math.min(params.lipMm, 1.2), z: inner.z1 },
      },
      "x",
      lipOpeningsFor("minY"),
    ).map((s) => ({ ...s, role: "lip" as const, name: s.name.replace("EnclosureWall", "EnclosureLidLip") })),
    ...splitWall(
      "EnclosureLidLipMaxY",
      {
        min: { x: inner.minX, y: inner.maxY - Math.min(params.lipMm, 1.2), z: mm(inner.z1 - params.lipMm) },
        max: { x: inner.maxX, y: inner.maxY, z: inner.z1 },
      },
      "x",
      lipOpeningsFor("maxY"),
    ).map((s) => ({ ...s, role: "lip" as const, name: s.name.replace("EnclosureWall", "EnclosureLidLip") })),
    ...splitWall(
      "EnclosureLidLipMinX",
      {
        min: { x: inner.minX, y: inner.minY, z: mm(inner.z1 - params.lipMm) },
        max: { x: inner.minX + Math.min(params.lipMm, 1.2), y: inner.maxY, z: inner.z1 },
      },
      "y",
      lipOpeningsFor("minX"),
    ).map((s) => ({ ...s, role: "lip" as const, name: s.name.replace("EnclosureWall", "EnclosureLidLip") })),
    ...splitWall(
      "EnclosureLidLipMaxX",
      {
        min: { x: inner.maxX - Math.min(params.lipMm, 1.2), y: inner.minY, z: mm(inner.z1 - params.lipMm) },
        max: { x: inner.maxX, y: inner.maxY, z: inner.z1 },
      },
      "y",
      lipOpeningsFor("maxX"),
    ).map((s) => ({ ...s, role: "lip" as const, name: s.name.replace("EnclosureWall", "EnclosureLidLip") })),
  );

  return {
    contract: ENCLOSURE_CONTRACT,
    pcbRevision: features.pcbRevision,
    generatedAt: now.toISOString(),
    params,
    board: {
      outline: {
        minX: outline.minX,
        minY: outline.minY,
        maxX: outline.maxX,
        maxY: outline.maxY,
        widthMm: outline.widthMm,
        heightMm: outline.heightMm,
      },
      thicknessMm: features.thicknessMm,
      tallestPartMm: mm(tallest),
    },
    inner,
    outer,
    solids,
    cutouts,
    standoffs,
    vents,
    clips,
    warnings,
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Compare a stored spec to the current board: stale hash, moved connectors, moved holes. */
export function checkEnclosureAlignment(
  spec: EnclosureSpec,
  features: BoardFeatures,
): AlignmentReport {
  const issues: AlignmentIssue[] = [];
  const stale = spec.pcbRevision !== features.pcbRevision;
  if (stale)
    issues.push({
      code: "stale-board",
      severity: "warning",
      message:
        "board.kicad_pcb changed since this enclosure was generated; regenerate so cutouts and standoffs stay aligned",
    });

  const connectors = new Map(features.connectors.map((c) => [c.ref, c]));
  for (const cut of spec.cutouts) {
    const live = connectors.get(cut.ref);
    if (!live) {
      issues.push({
        code: "missing-connector",
        severity: "error",
        ref: cut.ref,
        message: `cutout ${cut.ref} has no matching edge connector on the current board`,
      });
      continue;
    }
    const along = connectorAlong(live);
    const specAlong = cut.edge === "minX" || cut.edge === "maxX" ? cut.center.y : cut.center.x;
    if (Math.abs(along - specAlong) > CUTOUT_POS_TOL_MM)
      issues.push({
        code: "moved-cutout",
        severity: "error",
        ref: cut.ref,
        message: `cutout ${cut.ref} is ${mm(Math.abs(along - specAlong))} mm off the connector (tolerance ${CUTOUT_POS_TOL_MM} mm)`,
      });
    const needW = live.widthMm + 2 * spec.params.cutoutClearanceMm;
    const needH = live.heightMm + 2 * spec.params.cutoutClearanceMm;
    if (cut.widthMm + CUTOUT_SIZE_TOL_MM < needW || cut.heightMm + CUTOUT_SIZE_TOL_MM < needH)
      issues.push({
        code: "small-cutout",
        severity: "error",
        ref: cut.ref,
        message: `cutout ${cut.ref} is smaller than the connector plus clearance`,
      });
  }

  for (const hole of features.holes.filter((h) => h.shape !== "slot" && (h.purpose ? h.purpose === "mounting" : !h.ref || !features.components?.some((p) => p.ref === h.ref)))) {
    const stand = spec.standoffs.find((s) => dist({ x: s.x, y: s.y }, { x: hole.x, y: hole.y }) <= HOLE_POS_TOL_MM);
    if (!stand)
      issues.push({
        code: "missing-hole",
        severity: "error",
        ...(hole.ref ? { ref: hole.ref } : {}),
        message: `mounting hole ${hole.ref ?? hole.id} at (${hole.x}, ${hole.y}) has no aligned standoff`,
      });
  }
  for (const stand of spec.standoffs) {
    const hole = features.holes.find((h) => dist({ x: h.x, y: h.y }, { x: stand.x, y: stand.y }) <= HOLE_POS_TOL_MM);
    if (!hole)
      issues.push({
        code: "moved-hole",
        severity: "error",
        message: `standoff ${stand.id} no longer sits on a mounting hole`,
      });
  }

  return {
    ok: issues.every((i) => i.severity !== "error"),
    stale,
    pcbRevision: features.pcbRevision,
    specRevision: spec.pcbRevision,
    issues,
    checkedCutouts: spec.cutouts.length,
    checkedStandoffs: spec.standoffs.length,
  };
}

type Tri = [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }];

function addBoxMesh(tris: Tri[], min: EnclosureSolid["min"], max: EnclosureSolid["max"]): void {
  const [x0, y0, z0, x1, y1, z1] = [min.x, min.y, min.z, max.x, max.y, max.z];
  const faces: number[][] = [
    [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0],
    [x0, y0, z1, x0, y1, z1, x1, y1, z1, x1, y0, z1],
    [x0, y0, z0, x0, y0, z1, x1, y0, z1, x1, y0, z0],
    [x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1],
    [x0, y0, z0, x0, y1, z0, x0, y1, z1, x0, y0, z1],
    [x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0],
  ];
  for (const f of faces) {
    const a = { x: f[0]!, y: f[1]!, z: f[2]! };
    const b = { x: f[3]!, y: f[4]!, z: f[5]! };
    const c = { x: f[6]!, y: f[7]!, z: f[8]! };
    const d = { x: f[9]!, y: f[10]!, z: f[11]! };
    tris.push([a, b, c], [a, c, d]);
  }
}

function addHollowCylinder(
  tris: Tri[],
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  innerR: number,
  outerR: number,
  segments = 16,
): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const o0 = { x: cx + outerR * Math.cos(a0), y: cy + outerR * Math.sin(a0) };
    const o1 = { x: cx + outerR * Math.cos(a1), y: cy + outerR * Math.sin(a1) };
    const i0 = { x: cx + innerR * Math.cos(a0), y: cy + innerR * Math.sin(a0) };
    const i1 = { x: cx + innerR * Math.cos(a1), y: cy + innerR * Math.sin(a1) };
    tris.push(
      [
        { x: o0.x, y: o0.y, z: z0 },
        { x: o1.x, y: o1.y, z: z0 },
        { x: o1.x, y: o1.y, z: z1 },
      ],
      [
        { x: o0.x, y: o0.y, z: z0 },
        { x: o1.x, y: o1.y, z: z1 },
        { x: o0.x, y: o0.y, z: z1 },
      ],
      [
        { x: i1.x, y: i1.y, z: z0 },
        { x: i0.x, y: i0.y, z: z0 },
        { x: i0.x, y: i0.y, z: z1 },
      ],
      [
        { x: i1.x, y: i1.y, z: z0 },
        { x: i0.x, y: i0.y, z: z1 },
        { x: i1.x, y: i1.y, z: z1 },
      ],
    );
    tris.push(
      [
        { x: o0.x, y: o0.y, z: z1 },
        { x: o1.x, y: o1.y, z: z1 },
        { x: i1.x, y: i1.y, z: z1 },
      ],
      [
        { x: o0.x, y: o0.y, z: z1 },
        { x: i1.x, y: i1.y, z: z1 },
        { x: i0.x, y: i0.y, z: z1 },
      ],
      [
        { x: o1.x, y: o1.y, z: z0 },
        { x: o0.x, y: o0.y, z: z0 },
        { x: i0.x, y: i0.y, z: z0 },
      ],
      [
        { x: o1.x, y: o1.y, z: z0 },
        { x: i0.x, y: i0.y, z: z0 },
        { x: i1.x, y: i1.y, z: z0 },
      ],
    );
  }
}

function normal(t: Tri): { x: number; y: number; z: number } {
  const ux = t[1].x - t[0].x;
  const uy = t[1].y - t[0].y;
  const uz = t[1].z - t[0].z;
  const vx = t[2].x - t[0].x;
  const vy = t[2].y - t[0].y;
  const vz = t[2].z - t[0].z;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function asciiStl(name: string, tris: Tri[]): string {
  const lines = [`solid ${name}`];
  for (const t of tris) {
    const n = normal(t);
    lines.push(`  facet normal ${n.x} ${n.y} ${n.z}`);
    lines.push("    outer loop");
    for (const p of t) lines.push(`      vertex ${p.x} ${p.y} ${p.z}`);
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join("\n")}\n`;
}

export type EnclosureMeshes = { baseStl: string; lidStl: string; step: string };

/** Fused ASCII STL for the base (walls, floor, standoffs) and lid, plus a box-assembly STEP. */
export function meshEnclosure(spec: EnclosureSpec): EnclosureMeshes {
  const base: Tri[] = [];
  const lid: Tri[] = [];
  for (const s of spec.solids) {
    if (s.role === "lid" || s.role === "lip") addBoxMesh(lid, s.min, s.max);
    else if (s.kind === "cylinder" && s.radiusMm) {
      const stand = spec.standoffs.find(
        (h) => Math.abs(h.x - (s.min.x + s.max.x) / 2) < 1e-6 && Math.abs(h.y - (s.min.y + s.max.y) / 2) < 1e-6,
      );
      addHollowCylinder(
        base,
        (s.min.x + s.max.x) / 2,
        (s.min.y + s.max.y) / 2,
        s.min.z,
        s.max.z,
        (stand?.innerDiameterMm ?? s.radiusMm * 0.5) / 2,
        s.radiusMm,
      );
    } else addBoxMesh(base, s.min, s.max);
  }
  return {
    baseStl: asciiStl("fabplane_enclosure_base", base),
    lidStl: asciiStl("fabplane_enclosure_lid", lid),
    step: writeBoxesStep(
      spec.solids.filter((s) => s.kind === "box").map((s) => ({ name: s.name, min: s.min, max: s.max })),
      spec.solids.flatMap((s): StepTube[] => {
        if (s.kind !== "cylinder" || !s.radiusMm) return [];
        const cx = (s.min.x + s.max.x) / 2;
        const cy = (s.min.y + s.max.y) / 2;
        const stand = spec.standoffs.find((h) => Math.abs(h.x - cx) < 1e-6 && Math.abs(h.y - cy) < 1e-6);
        return [
          {
            name: s.name,
            cx,
            cy,
            z0: s.min.z,
            z1: s.max.z,
            innerRadiusMm: (stand?.innerDiameterMm ?? s.radiusMm * 0.5) / 2,
            outerRadiusMm: s.radiusMm,
          },
        ];
      }),
    ),
  };
}

/** Vertical hollow cylinder (standoff with a screw bore) on the z axis through (cx, cy). */
export type StepTube = {
  name: string;
  cx: number;
  cy: number;
  z0: number;
  z1: number;
  innerRadiusMm: number;
  outerRadiusMm: number;
};

/** Minimal AP214 assembly of axis-aligned boxes and vertical tubes (one closed shell each). */
export function writeBoxesStep(
  boxes: Array<{ name: string; min: EnclosureSolid["min"]; max: EnclosureSolid["max"] }>,
  tubes: StepTube[] = [],
): string {
  const ents: string[] = [];
  const next = (): number => {
    ents.push("");
    return ents.length;
  };
  const set = (n: number, body: string) => {
    ents[n - 1] = `#${n}=${body};`;
  };

  const nApp = next();
  set(nApp, "APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  const nProt = next();
  set(nProt, `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${nApp})`);
  const nPctx = next();
  set(nPctx, `PRODUCT_CONTEXT('',#${nApp},'mechanical')`);
  const nProd = next();
  set(nProd, `PRODUCT('enclosure','fabPlane enclosure','parametric PCB case',(#${nPctx}))`);
  const nPdf = next();
  set(nPdf, `PRODUCT_DEFINITION_FORMATION('1','',#${nProd})`);
  const nPdctx = next();
  set(nPdctx, `PRODUCT_DEFINITION_CONTEXT('part definition',#${nApp},'design')`);
  const nPdef = next();
  set(nPdef, `PRODUCT_DEFINITION('design','',#${nPdf},#${nPdctx})`);
  const nPds = next();
  set(nPds, `PRODUCT_DEFINITION_SHAPE('','',#${nPdef})`);
  const nLen = next();
  set(nLen, "(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const nUnc = next();
  set(nUnc, `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-6),#${nLen},'distance_accuracy_value','')`);
  const nGeom = next();
  set(
    nGeom,
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${nUnc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${nLen}))REPRESENTATION_CONTEXT('enclosure','3D'))`,
  );

  const point = (x: number, y: number, z: number) => {
    const n = next();
    set(n, `CARTESIAN_POINT('',(${x},${y},${z}))`);
    return n;
  };
  const axis = (dx: number, dy: number, dz: number) => {
    const d = next();
    set(d, `DIRECTION('',(${dx},${dy},${dz}))`);
    return d;
  };
  const placement = (x: number, y: number, z: number, nz: number) => {
    const ax2 = next();
    set(ax2, `AXIS2_PLACEMENT_3D('',#${point(x, y, z)},#${axis(0, 0, nz)},#${axis(1, 0, 0)})`);
    return ax2;
  };
  const oriented = (e: number, sense: boolean) => {
    const oe = next();
    set(oe, `ORIENTED_EDGE('',*,*,#${e},${sense ? ".T." : ".F."})`);
    return oe;
  };
  const bound = (edges: number[], outer: boolean) => {
    const loop = next();
    set(loop, `EDGE_LOOP('',(${edges.map((e) => `#${e}`).join(",")}))`);
    const fb = next();
    set(fb, `${outer ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${loop},.T.)`);
    return fb;
  };
  const advancedFace = (bounds: number[], surface: number, sameSense: boolean) => {
    const af = next();
    set(af, `ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(",")}),#${surface},${sameSense ? ".T." : ".F."})`);
    return af;
  };

  const shapeIds: number[] = [];
  for (const box of boxes) {
    const [x0, y0, z0, x1, y1, z1] = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
    const pts = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ].map(([x, y, z]) => point(x!, y!, z!));
    const verts = pts.map((p) => {
      const n = next();
      set(n, `VERTEX_POINT('',#${p})`);
      return n;
    });
    const edge = (a: number, b: number, dx: number, dy: number, dz: number) => {
      const p = pts[a]!;
      const dir = axis(dx, dy, dz);
      const vec = next();
      set(vec, `VECTOR('',#${dir},1.)`);
      const line = next();
      set(line, `LINE('',#${p},#${vec})`);
      const e = next();
      set(e, `EDGE_CURVE('',#${verts[a]},#${verts[b]},#${line},.T.)`);
      const oe = next();
      set(oe, `ORIENTED_EDGE('',*,*,#${e},.T.)`);
      return oe;
    };
    // 12 edges of the box, then 6 faces. Edge endpoints: 0-1-2-3 bottom, 4-5-6-7 top.
    const e01 = edge(0, 1, 1, 0, 0);
    const e12 = edge(1, 2, 0, 1, 0);
    const e23 = edge(2, 3, -1, 0, 0);
    const e30 = edge(3, 0, 0, -1, 0);
    const e45 = edge(4, 5, 1, 0, 0);
    const e56 = edge(5, 6, 0, 1, 0);
    const e67 = edge(6, 7, -1, 0, 0);
    const e74 = edge(7, 4, 0, -1, 0);
    const e04 = edge(0, 4, 0, 0, 1);
    const e15 = edge(1, 5, 0, 0, 1);
    const e26 = edge(2, 6, 0, 0, 1);
    const e37 = edge(3, 7, 0, 0, 1);
    const face = (edges: number[], nx: number, ny: number, nz: number, px: number, py: number, pz: number) => {
      const loop = next();
      set(loop, `EDGE_LOOP('',(${edges.map((e) => `#${e}`).join(",")}))`);
      const fb = next();
      set(fb, `FACE_BOUND('',#${loop},.T.)`);
      const origin = next();
      set(origin, `CARTESIAN_POINT('',(${px},${py},${pz}))`);
      const n = axis(nx, ny, nz);
      const ref = axis(Math.abs(nx) < 0.9 ? 1 : 0, Math.abs(nx) < 0.9 ? 0 : 1, 0);
      const ax2 = next();
      set(ax2, `AXIS2_PLACEMENT_3D('',#${origin},#${n},#${ref})`);
      const pl = next();
      set(pl, `PLANE('',#${ax2})`);
      const af = next();
      set(af, `ADVANCED_FACE('',(#${fb}),#${pl},.T.)`);
      return af;
    };
    const faces = [
      face([e01, e12, e23, e30], 0, 0, -1, x0, y0, z0),
      face([e45, e56, e67, e74], 0, 0, 1, x0, y0, z1),
      face([e01, e15, e45, e04], 0, -1, 0, x0, y0, z0),
      face([e23, e37, e67, e26], 0, 1, 0, x0, y1, z0),
      face([e30, e04, e74, e37], -1, 0, 0, x0, y0, z0),
      face([e12, e26, e56, e15], 1, 0, 0, x1, y0, z0),
    ];
    const shell = next();
    set(shell, `CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(",")}))`);
    const solid = next();
    set(solid, `MANIFOLD_SOLID_BREP('${box.name}',#${shell})`);
    shapeIds.push(solid);
  }

  // Each tube: outer and inner cylindrical faces plus annular top and bottom caps. Closed circles
  // start and end on a seam vertex on the +x side; a vertical seam line joins the z0 and z1 circles.
  for (const t of tubes) {
    const vertex = (r: number, z: number) => {
      const v = next();
      set(v, `VERTEX_POINT('',#${point(t.cx + r, t.cy, z)})`);
      return v;
    };
    const circle = (v: number, r: number, z: number) => {
      const c = next();
      set(c, `CIRCLE('',#${placement(t.cx, t.cy, z, 1)},${r})`);
      const e = next();
      set(e, `EDGE_CURVE('',#${v},#${v},#${c},.T.)`);
      return e;
    };
    const seam = (a: number, b: number, r: number) => {
      const vec = next();
      set(vec, `VECTOR('',#${axis(0, 0, 1)},1.)`);
      const line = next();
      set(line, `LINE('',#${point(t.cx + r, t.cy, t.z0)},#${vec})`);
      const e = next();
      set(e, `EDGE_CURVE('',#${a},#${b},#${line},.T.)`);
      return e;
    };
    const cylinder = (r: number) => {
      const s = next();
      set(s, `CYLINDRICAL_SURFACE('',#${placement(t.cx, t.cy, t.z0, 1)},${r})`);
      return s;
    };
    const plane = (z: number, nz: number) => {
      const s = next();
      set(s, `PLANE('',#${placement(t.cx, t.cy, z, nz)})`);
      return s;
    };
    const [ro, ri] = [t.outerRadiusMm, t.innerRadiusMm];
    const vo0 = vertex(ro, t.z0);
    const vo1 = vertex(ro, t.z1);
    const vi0 = vertex(ri, t.z0);
    const vi1 = vertex(ri, t.z1);
    const co0 = circle(vo0, ro, t.z0);
    const co1 = circle(vo1, ro, t.z1);
    const ci0 = circle(vi0, ri, t.z0);
    const ci1 = circle(vi1, ri, t.z1);
    const so = seam(vo0, vo1, ro);
    const si = seam(vi0, vi1, ri);
    const faces = [
      advancedFace(
        [bound([oriented(co0, true), oriented(so, true), oriented(co1, false), oriented(so, false)], true)],
        cylinder(ro),
        true,
      ),
      advancedFace(
        [bound([oriented(ci0, false), oriented(si, true), oriented(ci1, true), oriented(si, false)], true)],
        cylinder(ri),
        false,
      ),
      advancedFace([bound([oriented(co0, false)], true), bound([oriented(ci0, true)], false)], plane(t.z0, -1), true),
      advancedFace([bound([oriented(co1, true)], true), bound([oriented(ci1, false)], false)], plane(t.z1, 1), true),
    ];
    const shell = next();
    set(shell, `CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(",")}))`);
    const solid = next();
    set(solid, `MANIFOLD_SOLID_BREP('${t.name}',#${shell})`);
    shapeIds.push(solid);
  }
  const nRep = next();
  set(
    nRep,
    `ADVANCED_BREP_SHAPE_REPRESENTATION('enclosure',(${shapeIds.map((s) => `#${s}`).join(",")}),#${nGeom})`,
  );
  const nSrr = next();
  set(nSrr, `SHAPE_DEFINITION_REPRESENTATION(#${nPds},#${nRep})`);

  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('fabPlane parametric enclosure'),'2;1');",
    "FILE_NAME('enclosure.step','',('fabPlane'),('fabPlane'),'fabdesk','fabdesk','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    "ENDSEC;",
    "DATA;",
    ...ents,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

export function isEnclosureSpec(value: unknown): value is EnclosureSpec {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  const contract = rec["contract"];
  return (
    !!contract &&
    typeof contract === "object" &&
    (contract as { name?: unknown }).name === ENCLOSURE_CONTRACT.name &&
    typeof rec["pcbRevision"] === "string" &&
    Array.isArray(rec["cutouts"]) &&
    Array.isArray(rec["standoffs"]) &&
    Array.isArray(rec["solids"])
  );
}

/** Accept a 1.x spec and fill v2 fields so status/check do not print `undefined`. */
export function normalizeEnclosureSpec(value: unknown): EnclosureSpec | null {
  if (!isEnclosureSpec(value)) return null;
  const rec = value as EnclosureSpec & { params?: Partial<EnclosureParams>; vents?: EnclosureVent[]; clips?: EnclosureClip[] };
  return {
    ...rec,
    contract: ENCLOSURE_CONTRACT,
    params: mergeEnclosureParams(rec.params ?? {}),
    vents: rec.vents ?? [],
    clips: rec.clips ?? [],
  };
}

export function enclosureSummary(spec: EnclosureSpec, alignment: AlignmentReport): string {
  const normalized = normalizeEnclosureSpec(spec) ?? spec;
  const size = `${mm(normalized.outer.maxX - normalized.outer.minX)} × ${mm(normalized.outer.maxY - normalized.outer.minY)} × ${mm(normalized.outer.z1)} mm`;
  const sync = alignment.stale ? "stale (board changed)" : alignment.ok ? "in sync" : "misaligned";
  const cut = normalized.cutouts.length
    ? normalized.cutouts.map((c) => `${c.ref} ${c.edge} ${c.widthMm}×${c.heightMm}`).join(", ")
    : "none";
  const vents = normalized.vents ?? [];
  const clips = normalized.clips ?? [];
  const ventLabel =
    normalized.params.ventPattern && normalized.params.ventPattern !== "none"
      ? `${vents.length} ${normalized.params.ventPattern} vent(s) on ${normalized.params.ventFaces}`
      : "no vents";
  const snapLabel = normalized.params.snapFit ? `${clips.length} snap-fit clip(s)` : "no snap-fits";
  return [
    `Enclosure ${size}, ${normalized.standoffs.length} standoff(s), ${normalized.cutouts.length} cutout(s); ${sync}.`,
    `Offset ${normalized.params.outlineOffsetMm} mm + clearance ${normalized.params.clearanceMm} mm · ${ventLabel} · ${snapLabel}.`,
    `Cutouts: ${cut}.`,
    alignment.issues.length ? `Checks:\n${alignment.issues.map((i) => `- ${i.message}`).join("\n")}` : "Cutouts and holes align with the current board.",
  ].join("\n");
}

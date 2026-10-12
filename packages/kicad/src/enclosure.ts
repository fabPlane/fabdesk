/**
 * Parametric printable enclosure from {@link extractBoardFeatures}: a two-piece clamshell
 * (base + lid) that follows the board outline, mounting holes and edge-connector cutouts.
 *
 * The fused triangle mesh (STL) is the printable truth. STEP is an assembly of the same
 * axis-aligned boxes so a CAD tool can open the case without FreeCAD. When a FreeCAD session
 * is available, the `cad` toolset also mirrors the primitives into `model.FCStd`.
 */
import type { BoardEdge, BoardFeatures, Point, Rect } from "./board-features";

export const ENCLOSURE_CONTRACT = { name: "fabdesk.enclosure", version: "1.0.0" } as const;

export type EnclosureParams = {
  wallMm: number;
  clearanceMm: number;
  floorMm: number;
  lidMm: number;
  standoffMm: number;
  /** Extra air above the tallest part. */
  headroomMm: number;
  cutoutClearanceMm: number;
  lipMm: number;
};

export const DEFAULT_ENCLOSURE_PARAMS: EnclosureParams = {
  wallMm: 2,
  clearanceMm: 1,
  floorMm: 2,
  lidMm: 2,
  standoffMm: 3,
  headroomMm: 1.5,
  cutoutClearanceMm: 0.4,
  lipMm: 1,
};

export type EnclosureSolid = {
  name: string;
  kind: "box" | "cylinder";
  role: "floor" | "wall" | "lid" | "lip" | "standoff";
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  radiusMm?: number;
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
    floorMm: input.floorMm ?? DEFAULT_ENCLOSURE_PARAMS.floorMm,
    lidMm: input.lidMm ?? DEFAULT_ENCLOSURE_PARAMS.lidMm,
    standoffMm: input.standoffMm ?? DEFAULT_ENCLOSURE_PARAMS.standoffMm,
    headroomMm: input.headroomMm ?? DEFAULT_ENCLOSURE_PARAMS.headroomMm,
    cutoutClearanceMm: input.cutoutClearanceMm ?? DEFAULT_ENCLOSURE_PARAMS.cutoutClearanceMm,
    lipMm: input.lipMm ?? DEFAULT_ENCLOSURE_PARAMS.lipMm,
  };
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

function splitWall(
  name: string,
  wall: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
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

/** Build a two-piece case whose cutouts and standoffs track the current board features. */
export function generateEnclosure(
  features: BoardFeatures,
  paramsInput: Partial<EnclosureParams> = {},
  now = new Date(),
): EnclosureSpec {
  const params = mergeEnclosureParams(paramsInput);
  const { outline } = features;
  const tallest = features.tallParts[0]?.heightMm ?? features.connectors.reduce((m, c) => Math.max(m, c.heightMm), 0);
  const cavityHeight = params.standoffMm + features.thicknessMm + Math.max(tallest, 2) + params.headroomMm;
  const inner: EnclosureSpec["inner"] = {
    minX: mm(outline.minX - params.clearanceMm),
    minY: mm(outline.minY - params.clearanceMm),
    maxX: mm(outline.maxX + params.clearanceMm),
    maxY: mm(outline.maxY + params.clearanceMm),
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
    warnings.push("enclosure uses the Edge.Cuts bounding box; non-rectangular outlines are not offset");

  const cutouts: EnclosureCutout[] = features.connectors.map((c) => {
    const widthMm = mm(c.widthMm + 2 * params.cutoutClearanceMm);
    const heightMm = mm(c.heightMm + 2 * params.cutoutClearanceMm);
    const z = mm(params.floorMm + params.standoffMm + features.thicknessMm + c.heightMm / 2);
    const along = c.edge === "minX" || c.edge === "maxX" ? c.y : c.x;
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

  const standoffs: EnclosureStandoff[] = features.holes.map((h) => ({
    id: h.id,
    x: h.x,
    y: h.y,
    innerDiameterMm: mm(h.diameterMm + 0.2),
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

  const openingsFor = (edge: BoardEdge): Array<{ start: number; end: number }> =>
    cutouts
      .filter((c) => c.edge === edge)
      .map((c) => {
        const mid = edge === "minX" || edge === "maxX" ? c.center.y : c.center.x;
        return { start: mid - c.widthMm / 2, end: mid + c.widthMm / 2 };
      });

  solids.push(
    ...splitWall(
      "EnclosureWallMinY",
      {
        min: { x: outer.minX, y: outer.minY, z: inner.z0 },
        max: { x: outer.maxX, y: inner.minY, z: inner.z1 },
      },
      "x",
      openingsFor("minY"),
    ),
    ...splitWall(
      "EnclosureWallMaxY",
      {
        min: { x: outer.minX, y: inner.maxY, z: inner.z0 },
        max: { x: outer.maxX, y: outer.maxY, z: inner.z1 },
      },
      "x",
      openingsFor("maxY"),
    ),
    ...splitWall(
      "EnclosureWallMinX",
      {
        min: { x: outer.minX, y: inner.minY, z: inner.z0 },
        max: { x: inner.minX, y: inner.maxY, z: inner.z1 },
      },
      "y",
      openingsFor("minX"),
    ),
    ...splitWall(
      "EnclosureWallMaxX",
      {
        min: { x: inner.maxX, y: inner.minY, z: inner.z0 },
        max: { x: outer.maxX, y: inner.maxY, z: inner.z1 },
      },
      "y",
      openingsFor("maxX"),
    ),
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

  solids.push(
    box(
      "EnclosureLid",
      "lid",
      { x: outer.minX, y: outer.minY, z: inner.z1 },
      { x: outer.maxX, y: outer.maxY, z: outer.z1 },
    ),
    box(
      "EnclosureLidLip",
      "lip",
      { x: inner.minX, y: inner.minY, z: mm(inner.z1 - params.lipMm) },
      { x: inner.maxX, y: inner.maxY, z: inner.z1 },
    ),
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
    const along = live.edge === "minX" || live.edge === "maxX" ? live.y : live.x;
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

  for (const hole of features.holes) {
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

export function enclosureSummary(spec: EnclosureSpec, alignment: AlignmentReport): string {
  const size = `${mm(spec.outer.maxX - spec.outer.minX)} × ${mm(spec.outer.maxY - spec.outer.minY)} × ${mm(spec.outer.z1)} mm`;
  const sync = alignment.stale ? "stale (board changed)" : alignment.ok ? "in sync" : "misaligned";
  const cut = spec.cutouts.length
    ? spec.cutouts.map((c) => `${c.ref} ${c.edge} ${c.widthMm}×${c.heightMm}`).join(", ")
    : "none";
  return [
    `Enclosure ${size}, ${spec.standoffs.length} standoff(s), ${spec.cutouts.length} cutout(s); ${sync}.`,
    `Cutouts: ${cut}.`,
    alignment.issues.length ? `Checks:\n${alignment.issues.map((i) => `- ${i.message}`).join("\n")}` : "Cutouts and holes align with the current board.",
  ].join("\n");
}

/**
 * Board-space mechanical features for enclosure generation: Edge.Cuts outline, NPTH / mounting
 * holes, edge connectors and tall parts. Parsed from saved `board.kicad_pcb` bytes — no kicad-cli.
 *
 * Coordinates are KiCad board millimetres (Y grows downwards). Heights are estimates from the
 * footprint name when no 3D measurement is available.
 */
import { createHash } from "node:crypto";
import type { ConnectorFace } from "@fabdesk/protocol";

type Sexpr = string | Sexpr[];

function parseSexpr(text: string): Sexpr[] {
  const stack: Sexpr[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "(") {
      const list: Sexpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (ch === ")") {
      if (stack.length === 1) throw new Error("unbalanced parentheses in board file");
      stack.pop();
      i++;
    } else if (ch === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          i++;
          value += text[i];
        } else value += text[i];
        i++;
      }
      i++;
      stack[stack.length - 1]!.push(value);
    } else if (/\s/.test(ch)) i++;
    else {
      let end = i;
      while (end < text.length && !/[\s()"]/.test(text[end]!)) end++;
      stack[stack.length - 1]!.push(text.slice(i, end));
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error("unbalanced parentheses in board file");
  return stack[0]!;
}

const head = (node: Sexpr): string | null =>
  Array.isArray(node) && typeof node[0] === "string" ? node[0] : null;
const child = (node: Sexpr[], name: string): Sexpr[] | undefined =>
  node.find((n): n is Sexpr[] => head(n) === name);
const children = (node: Sexpr[], name: string): Sexpr[][] =>
  node.filter((n): n is Sexpr[] => head(n) === name);
const numberAt = (node: Sexpr[] | undefined, index: number): number | null => {
  const value = node?.[index];
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const layerOf = (node: Sexpr[]): string | null => {
  const layer = child(node, "layer");
  return typeof layer?.[1] === "string" ? layer[1] : null;
};
const isEdgeCuts = (layer: string | null): boolean =>
  layer === "Edge.Cuts" || layer === "Edge_Cuts";
const isCourtyard = (layer: string | null): boolean =>
  layer === "F.CrtYd" || layer === "B.CrtYd" || layer === "F.Courtyard" || layer === "B.Courtyard";

export type Point = { x: number; y: number };
export type Rect = { minX: number; minY: number; maxX: number; maxY: number };
export type BoardEdge = "minX" | "maxX" | "minY" | "maxY";

export type BoardOutline = Rect & {
  widthMm: number;
  heightMm: number;
  closed: boolean;
  source: "gr_rect" | "gr_poly" | "gr_arc" | "segments" | "mixed";
};

export type MountingHole = {
  id: string;
  x: number;
  y: number;
  diameterMm: number;
  source: "npth-pad" | "pth-pad" | "edge-cuts-circle" | "footprint";
  purpose?: "mounting" | "component" | "unclassified";
  shape?: "round" | "slot";
  drillWidthMm?: number;
  drillHeightMm?: number;
  ref?: string;
};

export type EdgeConnector = {
  face?: ConnectorFace;
  ref: string;
  footprint: string;
  x: number;
  y: number;
  rotationDeg: number;
  edge: BoardEdge;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  bounds: Rect;
};

export type TallPart = {
  ref: string;
  footprint: string;
  x: number;
  y: number;
  heightMm: number;
  bounds: Rect;
};

export type BoardFeatures = {
  pcbRevision: string;
  thicknessMm: number;
  outline: BoardOutline;
  holes: MountingHole[];
  connectors: EdgeConnector[];
  tallParts: TallPart[];
  /** All populated footprints, including short parts, for conservative fit checks. */
  components?: Array<TallPart & { bottom: boolean }>;
  footprints: number;
  warnings: string[];
};

const mm = (n: number) => Math.round(n * 1e4) / 1e4;
const emptyRect = (): Rect => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});
const expand = (r: Rect, x: number, y: number): void => {
  if (x < r.minX) r.minX = x;
  if (y < r.minY) r.minY = y;
  if (x > r.maxX) r.maxX = x;
  if (y > r.maxY) r.maxY = y;
};
const validRect = (r: Rect): boolean =>
  Number.isFinite(r.minX) && Number.isFinite(r.minY) && r.maxX > r.minX && r.maxY > r.minY;
const widthOf = (r: Rect) => r.maxX - r.minX;
const heightOf = (r: Rect) => r.maxY - r.minY;
/** KiCad RotatePoint: clockwise about the footprint origin (Y down). */
const rotateLocal = (x: number, y: number, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: x * c + y * s, y: y * c - x * s };
};

const CONNECTOR_RE =
  /usb|hdmi|displayport|dp_?conn|rj45|ethernet|sma|u\.?fl|jack|barrel|jst|type-?c|usb_c|conn_|connector|header|pinheader|pin_header|audio|trrs|trs|sd.?card|micro.?sd|dc.?in|molex|picoblade|pico.?lock|swd|tag-?connect|qwiic|stemma/i;
const MOUNT_RE = /mounting.?hole|^mh[_:]|hole_pad/i;
const FIDUCIAL_RE = /fiducial/i;
const EDGE_TOLERANCE_MM = 2.5;

/** Heights above the mounting face for exact part numbers, never connector-wide guesses. */
function connectorBodyProfile(footprint: string) {
  // Molex 9876505191, p16: 105017-0001 height 2.45 nominal / 2.94 maximum.
  // https://cevikltd.com.tr/filestore/pdfs/MolexTabletPCConnectorSystems9876505191.pdf
  // Use the documented maximum envelope, not a generic USB-A height or a claim of measured fit.
  if (/(?:^|:)USB_Micro-B_Molex-105017-0001$/.test(footprint))
    return { heightMm: 2.94, source: "Molex 105017-0001 catalog maximum" as const };
  // GCT USB4105, sheet 1, B4: https://gct.co/files/drawings/usb4105.pdf
  if (/(?:^|:)USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal$/.test(footprint))
    return { heightMm: 3.31, source: "GCT USB4105 drawing" as const };
  // Hirose EDC3-156814, sheet 1: 1.55 +/- 0.13 mm above PCB.
  // https://static.chipdip.ru/lib/930/DOC036930988.pdf (manufacturer drawing)
  // Retain the saved footprint's XY outline; do not confuse the inserted card with body height.
  if (/(?:^|:)microSD_HC_Hirose_DM3D-SF$/.test(footprint))
    return { heightMm: 1.55, source: "Hirose DM3D-SF drawing" as const };
  return undefined;
}

export function estimatePartHeightMm(footprint: string, value = ""): number {
  const known = connectorBodyProfile(footprint);
  if (known) return known.heightMm;
  const text = `${footprint} ${value}`;
  if (/usb.?c|type-?c|usb_c/i.test(text)) return 3.6;
  if (/hdmi/i.test(text)) return 6.5;
  if (/rj45|ethernet/i.test(text)) return 13;
  if (/sma|u\.?fl/i.test(text)) return 8;
  if (/jack|audio|trrs|trs/i.test(text)) return 12;
  if (/barrel|dc.?in/i.test(text)) return 10;
  if (/usb/i.test(text)) return 7;
  if (/header|pinheader|pin_header/i.test(text)) return 6;
  if (/jst|molex|picoblade/i.test(text)) return 4.2;
  if (CONNECTOR_RE.test(text)) return 5;
  if (/electrolytic|elec_|cp_elec|cannon|inductor|transformer|crystal|xtal/i.test(text)) return 5;
  if (/qfn|bga|0402|0603|0805|sot-?23/i.test(text)) return 1.2;
  return 1.6;
}

function xy(node: Sexpr[] | undefined): Point | null {
  if (!node) return null;
  const x = numberAt(node, 1);
  const y = numberAt(node, 2);
  return x === null || y === null ? null : { x, y };
}

function collectPts(node: Sexpr[]): Point[] {
  const pts = child(node, "pts");
  if (!pts) return [];
  return children(pts, "xy")
    .map((p) => xy(p))
    .filter((p): p is Point => p !== null);
}

const TAU = Math.PI * 2;
const normAngle = (a: number): number => {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
};

function circleFrom3(a: Point, b: Point, c: Point): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

/** Sweep from start to end that passes through mid, in radians (signed: +CCW / −CW). */
function directedSweep(start: Point, mid: Point, end: Point, cx: number, cy: number): number {
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const aM = Math.atan2(mid.y - cy, mid.x - cx);
  const a1 = Math.atan2(end.y - cy, end.x - cx);
  let ccw = normAngle(a1 - a0);
  if (ccw < 1e-12) ccw = TAU;
  const midFrom0 = normAngle(aM - a0);
  if (midFrom0 <= ccw + 1e-9) return ccw;
  let cw = normAngle(a0 - a1);
  if (cw < 1e-12) cw = TAU;
  return -cw;
}

function expandArc(box: Rect, start: Point, mid: Point, end: Point): void {
  expand(box, start.x, start.y);
  expand(box, mid.x, mid.y);
  expand(box, end.x, end.y);
  const circ = circleFrom3(start, mid, end);
  if (!circ) return;
  const sweep = directedSweep(start, mid, end, circ.cx, circ.cy);
  const a0 = Math.atan2(start.y - circ.cy, start.x - circ.cx);
  expandCircularSweep(box, circ.cx, circ.cy, circ.r, a0, sweep);
}

/** Include exact cardinal extrema; sampling an arc can underestimate its physical envelope. */
function expandCircularSweep(
  box: Rect,
  cx: number,
  cy: number,
  radius: number,
  start: number,
  sweep: number,
) {
  const include = (a: number) => expand(box, cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  include(start);
  include(start + sweep);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const distance = normAngle(sweep >= 0 ? angle - start : start - angle);
    if (distance <= Math.abs(sweep) + 1e-9) include(angle);
  }
}

function expandLegacyArc(box: Rect, center: Point, end: Point, angleDeg: number): void {
  const r = Math.hypot(end.x - center.x, end.y - center.y);
  if (r <= 0) {
    expand(box, center.x, center.y);
    return;
  }
  const a0 = Math.atan2(end.y - center.y, end.x - center.x);
  // KiCad 5 `angle` is a clockwise sweep from `end` about `start` (the center).
  const sweep = (-angleDeg * Math.PI) / 180;
  expandCircularSweep(box, center.x, center.y, r, a0, sweep);
}

function footprintPlacement(fp: Sexpr[]): { x: number; y: number; rotationDeg: number } | null {
  const transform = child(fp, "transform");
  const at = child(fp, "at");
  if (transform) {
    const translate = child(transform, "translate");
    const x = numberAt(translate, 1);
    const y = numberAt(translate, 2);
    if (x !== null && y !== null)
      return { x, y, rotationDeg: numberAt(child(transform, "rotate"), 1) ?? 0 };
  }
  if (at) {
    const x = numberAt(at, 1);
    const y = numberAt(at, 2);
    if (x !== null && y !== null) return { x, y, rotationDeg: numberAt(at, 3) ?? 0 };
  }
  return null;
}

function footprintRef(fp: Sexpr[]): string | null {
  const reference =
    children(fp, "property").find((p) => p[1] === "Reference")?.[2] ??
    children(fp, "fp_text").find((t) => t[1] === "reference")?.[2];
  return typeof reference === "string" ? reference : null;
}

function footprintValue(fp: Sexpr[]): string {
  const value =
    children(fp, "property").find((p) => p[1] === "Value")?.[2] ??
    children(fp, "fp_text").find((t) => t[1] === "value")?.[2];
  return typeof value === "string" ? value : "";
}

function courtyardBounds(
  fp: Sexpr[],
  origin: Point,
  rotationDeg: number,
  fabrication = false,
): Rect {
  const r = emptyRect();
  const addLocal = (x: number, y: number) => {
    const p = rotateLocal(x, y, rotationDeg);
    expand(r, origin.x + p.x, origin.y + p.y);
  };
  for (const name of ["fp_line", "fp_rect", "fp_poly", "fp_circle"] as const) {
    for (const g of children(fp, name)) {
      if (fabrication ? !["F.Fab", "B.Fab"].includes(layerOf(g) ?? "") : !isCourtyard(layerOf(g)))
        continue;
      if (name === "fp_line") {
        const a = xy(child(g, "start"));
        const b = xy(child(g, "end"));
        if (a) addLocal(a.x, a.y);
        if (b) addLocal(b.x, b.y);
      } else if (name === "fp_rect") {
        const a = xy(child(g, "start"));
        const b = xy(child(g, "end"));
        if (a && b) {
          addLocal(a.x, a.y);
          addLocal(a.x, b.y);
          addLocal(b.x, a.y);
          addLocal(b.x, b.y);
        }
      } else if (name === "fp_poly") {
        for (const p of collectPts(g)) addLocal(p.x, p.y);
      } else {
        const c = xy(child(g, "center"));
        const e = xy(child(g, "end"));
        if (c && e) {
          const rad = Math.hypot(e.x - c.x, e.y - c.y);
          const center = rotateLocal(c.x, c.y, rotationDeg);
          expand(r, origin.x + center.x - rad, origin.y + center.y - rad);
          expand(r, origin.x + center.x + rad, origin.y + center.y + rad);
        }
      }
    }
  }
  return r;
}

function padBounds(fp: Sexpr[], origin: Point, rotationDeg: number): Rect {
  const r = emptyRect();
  for (const pad of children(fp, "pad")) {
    const at = xy(child(pad, "at"));
    const size = child(pad, "size");
    const sx = numberAt(size, 1) ?? 0;
    const sy = numberAt(size, 2) ?? sx;
    if (!at) continue;
    const p = rotateLocal(at.x, at.y, rotationDeg);
    expand(r, origin.x + p.x - sx / 2, origin.y + p.y - sy / 2);
    expand(r, origin.x + p.x + sx / 2, origin.y + p.y + sy / 2);
  }
  return r;
}

function nearestEdge(outline: Rect, point: Point, bounds: Rect): { edge: BoardEdge; gap: number } {
  const gaps: Array<{ edge: BoardEdge; gap: number }> = [
    { edge: "minX", gap: Math.min(point.x, bounds.minX) - outline.minX },
    { edge: "maxX", gap: outline.maxX - Math.max(point.x, bounds.maxX) },
    { edge: "minY", gap: Math.min(point.y, bounds.minY) - outline.minY },
    { edge: "maxY", gap: outline.maxY - Math.max(point.y, bounds.maxY) },
  ];
  return gaps.reduce((best, cur) => (cur.gap < best.gap ? cur : best));
}

function outlineFromGraphics(root: Sexpr[]): {
  outline: BoardOutline | null;
  circles: MountingHole[];
  rectangular: boolean;
} {
  const box = emptyRect();
  const circles: MountingHole[] = [];
  let source: BoardOutline["source"] = "segments";
  const edges: Array<[Point, Point]> = [];
  let invalid = false,
    curved = false,
    closedCurves = 0;
  const addEdge = (a: Point | null, b: Point | null) => {
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 1e-7) invalid = true;
    else edges.push([a, b]);
  };
  let shapes = 0;
  const consider = (layer: string | null, kind: BoardOutline["source"], add: () => void) => {
    if (!isEdgeCuts(layer)) return;
    shapes++;
    if (shapes === 1) source = kind;
    else if (source !== kind) source = "mixed";
    add();
  };
  for (const g of children(root, "gr_line"))
    consider(layerOf(g), "segments", () => {
      const a = xy(child(g, "start"));
      const b = xy(child(g, "end"));
      if (a) expand(box, a.x, a.y);
      if (b) expand(box, b.x, b.y);
      addEdge(a, b);
    });
  for (const g of children(root, "gr_rect"))
    consider(layerOf(g), "gr_rect", () => {
      const a = xy(child(g, "start"));
      const b = xy(child(g, "end"));
      if (a && b) {
        expand(box, a.x, a.y);
        expand(box, b.x, b.y);
        const c = { x: b.x, y: a.y },
          d = { x: a.x, y: b.y };
        addEdge(a, c);
        addEdge(c, b);
        addEdge(b, d);
        addEdge(d, a);
      } else invalid = true;
    });
  for (const g of children(root, "gr_poly"))
    consider(layerOf(g), "gr_poly", () => {
      const points = collectPts(g);
      if (
        points.length > 1 &&
        points[0]!.x === points.at(-1)!.x &&
        points[0]!.y === points.at(-1)!.y
      )
        points.pop();
      for (const p of points) expand(box, p.x, p.y);
      if (points.length < 3) invalid = true;
      else points.forEach((p, i) => addEdge(p, points[(i + 1) % points.length]!));
    });
  for (const g of children(root, "gr_arc"))
    consider(layerOf(g), "gr_arc", () => {
      const start = xy(child(g, "start"));
      const mid = xy(child(g, "mid"));
      const end = xy(child(g, "end"));
      const angle = numberAt(child(g, "angle"), 1);
      curved = true;
      if (start && mid && end) {
        expandArc(box, start, mid, end);
        addEdge(start, end);
      } else if (start && end && angle !== null) {
        expandLegacyArc(box, start, end, angle);
        if (Math.abs(angle) >= 359.999 && Math.abs(angle) <= 360.001) closedCurves++;
        else {
          const a = (-angle * Math.PI) / 180,
            x = end.x - start.x,
            y = end.y - start.y;
          addEdge(end, {
            x: start.x + x * Math.cos(a) - y * Math.sin(a),
            y: start.y + x * Math.sin(a) + y * Math.cos(a),
          });
        }
      } else invalid = true;
    });
  for (const g of children(root, "gr_circle")) {
    if (!isEdgeCuts(layerOf(g))) continue;
    const c = xy(child(g, "center"));
    const e = xy(child(g, "end"));
    if (!c || !e) continue;
    const diameter = Math.hypot(e.x - c.x, e.y - c.y) * 2;
    if (diameter > 0 && diameter <= 8) {
      circles.push({
        id: `circle-${circles.length + 1}`,
        x: mm(c.x),
        y: mm(c.y),
        diameterMm: mm(diameter),
        source: "edge-cuts-circle",
        purpose: "unclassified",
        shape: "round",
      });
    } else {
      expand(box, c.x - diameter / 2, c.y - diameter / 2);
      expand(box, c.x + diameter / 2, c.y + diameter / 2);
      curved = true;
      closedCurves++;
    }
  }
  if (!validRect(box)) return { outline: null, circles, rectangular: false };
  // Endpoint degree detects open chains independently of file order or segment direction.
  // This is a closure check, not polygon validity or a fabrication certification.
  const degree = new Map<string, number>();
  for (const edge of edges)
    for (const p of edge) {
      const key = `${Math.round(p.x * 100000)},${Math.round(p.y * 100000)}`;
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  const closed =
    !invalid &&
    (edges.length > 0 || closedCurves > 0) &&
    [...degree.values()].every((n) => n === 2);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;
  const rectangular =
    closed &&
    !curved &&
    edges.every(
      ([a, b]) =>
        (near(a.x, b.x) && (near(a.x, box.minX) || near(a.x, box.maxX))) ||
        (near(a.y, b.y) && (near(a.y, box.minY) || near(a.y, box.maxY))),
    );
  return {
    outline: {
      minX: mm(box.minX),
      minY: mm(box.minY),
      maxX: mm(box.maxX),
      maxY: mm(box.maxY),
      widthMm: mm(widthOf(box)),
      heightMm: mm(heightOf(box)),
      closed,
      source,
    },
    circles,
    rectangular,
  };
}

/** Parse a KiCad board into the features an enclosure needs. */
export function extractBoardFeatures(boardText: string): BoardFeatures {
  const pcbRevision = createHash("sha256").update(boardText).digest("hex");
  const root = parseSexpr(boardText).find((n): n is Sexpr[] => head(n) === "kicad_pcb");
  if (!root) throw new Error("not a kicad_pcb file");
  const warnings: string[] = [];
  const thickness = numberAt(
    child(root, "general") && child(child(root, "general")!, "thickness"),
    1,
  );
  const thicknessMm = thickness ?? 1.6;
  if (thickness === null) warnings.push("board thickness missing; assuming 1.6 mm");
  const { outline, circles, rectangular } = outlineFromGraphics(root);
  if (!outline) throw new Error("board has no Edge.Cuts outline");
  if (!outline.closed)
    warnings.push(
      "Edge.Cuts segments may not form a closed contour; the enclosure uses the bounding box",
    );
  else if (!rectangular)
    warnings.push(
      "Non-rectangular Edge.Cuts contour; enclosure fit uses a rectangular bounding estimate.",
    );

  const holes: MountingHole[] = [...circles];
  const connectors: EdgeConnector[] = [];
  const tallParts: TallPart[] = [];
  const components: NonNullable<BoardFeatures["components"]> = [];
  const footprints = children(root, "footprint");
  for (const fp of footprints) {
    const placement = footprintPlacement(fp);
    const ref = footprintRef(fp) ?? "";
    const libId = typeof fp[1] === "string" ? fp[1] : "";
    const value = footprintValue(fp);
    if (!placement) {
      warnings.push(`${ref || libId} has no readable placement`);
      continue;
    }
    const origin = { x: placement.x, y: placement.y };
    const attr = child(fp, "attr");
    const dnp = (attr?.includes("dnp") ?? false) || child(fp, "dnp")?.[1] === "yes";
    const mounting = MOUNT_RE.test(`${libId} ${ref}`) && !FIDUCIAL_RE.test(`${libId} ${ref}`);
    for (const [index, pad] of children(fp, "pad").entries()) {
      const tokens = pad.filter((n): n is string => typeof n === "string");
      const npth = tokens.includes("npth") || tokens.includes("np_thru_hole");
      if (!npth && !tokens.includes("thru_hole")) continue;
      const at = xy(child(pad, "at")) ?? { x: 0, y: 0 };
      const drill = child(pad, "drill");
      const slot = drill?.[1] === "oval";
      const dx = numberAt(drill, slot ? 2 : 1) ?? 0;
      const dy = slot ? (numberAt(drill, 3) ?? 0) : dx;
      if (dx <= 0 || dy <= 0) {
        warnings.push(`${ref || libId}: drill dimensions are missing; no screw mount inferred.`);
        continue;
      }
      // KiCad's drill export uses the pad anchor. Its "offset shape from hole"
      // setting moves copper, not the drill centre (verified against native Excellon).
      const p = rotateLocal(at.x, at.y, placement.rotationDeg);
      holes.push({
        id: `${ref || libId}-${npth ? "npth" : "pth"}-${index}`,
        x: mm(origin.x + p.x),
        y: mm(origin.y + p.y),
        diameterMm: mm(Math.min(dx, dy)),
        source: npth ? "npth-pad" : "pth-pad",
        purpose: mounting ? "mounting" : "component",
        shape: slot ? "slot" : "round",
        drillWidthMm: mm(dx),
        drillHeightMm: mm(dy),
        ...(ref ? { ref } : {}),
      });
    }
    // DNP omits the component body, not the physical holes in the manufactured PCB.
    if (dnp) continue;

    const court = courtyardBounds(fp, origin, placement.rotationDeg);
    const pads = padBounds(fp, origin, placement.rotationDeg);
    const bounds = validRect(court) ? court : pads;
    const body = validRect(bounds)
      ? bounds
      : { minX: origin.x - 1, minY: origin.y - 1, maxX: origin.x + 1, maxY: origin.y + 1 };
    const property = children(fp, "property").find(
      (p) => p[1] === "Height" || p[1] === "Height (mm)",
    );
    const heightText = typeof property?.[2] === "string" ? property[2].trim() : "";
    const heightMatch = heightText.match(/^(\d+(?:\.\d+)?)\s*(mm)?$/i);
    const suppliedHeight = heightMatch ? Number(heightMatch[1]) : null;
    const validHeight = suppliedHeight !== null && suppliedHeight > 0 && suppliedHeight <= 200;
    if (heightText && !validHeight)
      warnings.push(
        `${ref || libId}: Height property must be a positive number in mm; using an estimated height.`,
      );
    const measured = validHeight
      ? { heightMm: suppliedHeight, source: "PCB Height property" as const }
      : connectorBodyProfile(libId);
    const heightMm = measured?.heightMm ?? estimatePartHeightMm(libId, value);
    const fab = courtyardBounds(fp, origin, placement.rotationDeg, true);
    const mountLabel = `${libId} ${ref}`;
    if (!MOUNT_RE.test(mountLabel) && !FIDUCIAL_RE.test(mountLabel))
      components.push({
        ref: ref || libId,
        footprint: libId,
        x: origin.x,
        y: origin.y,
        heightMm,
        bounds: body,
        bottom: layerOf(fp) === "B.Cu",
      });
    if (
      !FIDUCIAL_RE.test(mountLabel) &&
      MOUNT_RE.test(mountLabel) &&
      !holes.some((h) => h.ref === ref)
    ) {
      warnings.push(
        `${ref || libId}: mounting footprint has no readable drill; no screw mount inferred.`,
      );
    }
    const near = nearestEdge(outline, origin, body);
    const looksLikeConnector = CONNECTOR_RE.test(`${libId} ${value} ${ref}`);
    if (looksLikeConnector && near.gap <= EDGE_TOLERANCE_MM) {
      const along = near.edge === "minX" || near.edge === "maxX" ? heightOf(body) : widthOf(body);
      const into = near.edge === "minX" || near.edge === "maxX" ? widthOf(body) : heightOf(body);
      connectors.push({
        ref: ref || libId,
        footprint: libId,
        x: mm(origin.x),
        y: mm(origin.y),
        rotationDeg: mm(placement.rotationDeg),
        edge: near.edge,
        widthMm: mm(Math.max(along, 4)),
        depthMm: mm(Math.max(into, 2)),
        heightMm,
        ...(validRect(fab)
          ? {
              face: {
                bounds: fab,
                heightMm,
                centerZ: heightMm / 2,
                source: measured?.source ?? ("fabrication-outline" as const),
              },
            }
          : {}),
        bounds: {
          minX: mm(body.minX),
          minY: mm(body.minY),
          maxX: mm(body.maxX),
          maxY: mm(body.maxY),
        },
      });
    } else if (heightMm >= 3 && ref) {
      tallParts.push({
        ref,
        footprint: libId,
        x: mm(origin.x),
        y: mm(origin.y),
        heightMm,
        bounds: {
          minX: mm(body.minX),
          minY: mm(body.minY),
          maxX: mm(body.maxX),
          maxY: mm(body.maxY),
        },
      });
    }
  }
  tallParts.sort((a, b) => b.heightMm - a.heightMm || a.ref.localeCompare(b.ref));
  return {
    pcbRevision,
    thicknessMm,
    outline,
    holes,
    connectors,
    tallParts,
    components,
    footprints: footprints.length,
    warnings,
  };
}

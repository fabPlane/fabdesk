/**
 * The shared board model: what the workflow stages read from a `.kicad_pcb`.
 * Footprints, pads (netted only, as KiCad's connectivity sees them), tracks, vias, zones, copper
 * layers, stackup and outline. Pure data: later stages (edit, review, release) build on this.
 */
import { atoms, kid, kids, num, parseSexpr, type SNode } from "./sexpr";

export interface Footprint {
  ref: string;
  lib: string;
  value: string | null;
  x: number;
  y: number;
  /** Degrees, 0 <= rot < 360. */
  rot: number;
  /** `F.Cu` or `B.Cu`. */
  layer: string;
  locked: boolean;
  /** Pad number -> net name (every pad that names a net, including the empty net). */
  pins: Record<string, string>;
}

export interface Pad {
  ref: string;
  pad: string;
  net: string;
  x: number;
  y: number;
  /** Copper extent as a circle radius (custom pads include their primitives). */
  r: number;
  /** Copper layers the pad is on as written; `*.Cu` means every copper layer. */
  layers: string[];
}

export interface Segment {
  a: [number, number];
  b: [number, number];
  w: number;
  layer: string;
  net: string;
}

export interface Via {
  kind: "through" | "blind" | "micro" | string;
  /** The two layers as written; use `viaSpan` for stack order. */
  layers: [string, string];
  net: string;
  fill: boolean;
  cap: boolean;
  x: number;
  y: number;
  size: number;
}

export interface Zone {
  net: string;
  layers: string[];
}

export interface StackupLayer {
  name: string;
  type: string;
  thickness?: number;
  material?: string;
  epsilonR?: number;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Board {
  /** KiCad file format version, when stated. */
  version: number | null;
  /** Copper layers, front to back (F.Cu, In1.Cu ... B.Cu). */
  copperLayers: string[];
  stackup: StackupLayer[];
  /** Bounding box of the Edge.Cuts drawing; null when there is none. */
  outline: Rect | null;
  footprints: Map<string, Footprint>;
  pads: Pad[];
  segments: Segment[];
  vias: Via[];
  zones: Zone[];
  /** Routed items (segments, vias, arcs) present in the file. */
  routedItems: number;
}

/** Copper items that name their net by number (the pre-10 file format): tracks then match no net by name. */
export function legacyNetRefs(text: string): number {
  return (text.match(/\n\s+\(net \d+\)/g) ?? []).length;
}

const pair = (n: SNode | undefined): [number, number] => [num(n?.[1]), num(n?.[2])];

function copperOrder(a: string, b: string): number {
  const key = (l: string): [number, number, number] => [
    l === "F.Cu" ? 0 : 1,
    l === "B.Cu" ? 1 : 0,
    Number(l.replace(/\D/g, "")) || 0,
  ];
  const ka = key(a);
  const kb = key(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

function readFootprint(fp: SNode, pads: Pad[]): Footprint | null {
  const props: Record<string, string> = {};
  for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2] ?? "");
  const ref = props["Reference"];
  if (ref === undefined) return null;
  const tr = kid(fp, "transform");
  let x: number, y: number, rot: number;
  if (tr) {
    [x, y] = pair(kid(tr, "translate"));
    rot = num(kid(tr, "rotate")?.[1]);
  } else {
    const at = kid(fp, "at");
    x = num(at?.[1]);
    y = num(at?.[2]);
    rot = num(at?.[3]);
  }
  const rad = (rot * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const pins: Record<string, string> = {};
  for (const pad of kids(fp, "pad")) {
    const net = kid(pad, "net");
    if (!net) continue;
    const name = String(net[net.length - 1] ?? "");
    const number = String(pad[1]);
    pins[number] = name;
    const [px, py] = pair(kid(pad, "at"));
    const size = kid(pad, "size");
    let r = size ? Math.max(num(size[1]), num(size[2])) / 2 : 0.3;
    const prim = kid(pad, "primitives");
    if (prim) {
      for (const g of prim.slice(1)) {
        if (!Array.isArray(g)) continue;
        for (const pts of kids(g, "pts"))
          for (const q of kids(pts, "xy")) r = Math.max(r, Math.hypot(num(q[1]), num(q[2])));
      }
    }
    pads.push({
      ref,
      pad: number,
      net: name,
      x: x + px * c + py * s,
      y: y - px * s + py * c,
      r,
      layers: atoms(kid(pad, "layers")),
    });
  }
  const head = fp.filter((i): i is string => typeof i === "string");
  const lockedNode = kid(fp, "locked");
  return {
    ref,
    lib: String(fp[1] ?? ""),
    value: props["Value"] ?? null,
    x,
    y,
    rot: ((rot % 360) + 360) % 360,
    layer: String(kid(fp, "layer")?.[1] ?? "F.Cu"),
    locked: head.includes("locked") || (lockedNode !== undefined && lockedNode[1] !== "no"),
    pins,
  };
}

function readOutline(root: SNode): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const g of root) {
    if (!Array.isArray(g) || typeof g[0] !== "string") continue;
    if (!/^gr_(line|rect|arc|circle|poly|curve)$/.test(g[0])) continue;
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    if (g[0] === "gr_circle") {
      const [cx, cy] = pair(kid(g, "center"));
      const [ex, ey] = pair(kid(g, "end"));
      const rr = Math.hypot(ex - cx, ey - cy);
      add(cx - rr, cy - rr);
      add(cx + rr, cy + rr);
      continue;
    }
    for (const key of ["start", "mid", "end"]) {
      const n = kid(g, key);
      if (n) add(...pair(n));
    }
    for (const pts of kids(g, "pts")) for (const q of kids(pts, "xy")) add(num(q[1]), num(q[2]));
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function readStackup(root: SNode): StackupLayer[] {
  const setup = kid(root, "setup");
  const st = setup && kid(setup, "stackup");
  if (!st) return [];
  return kids(st, "layer").map((l) => {
    const th = kid(l, "thickness");
    const mat = kid(l, "material");
    const eps = kid(l, "epsilon_r");
    return {
      name: String(l[1] ?? ""),
      type: String(kid(l, "type")?.[1] ?? ""),
      ...(th ? { thickness: num(th[1]) } : {}),
      ...(mat ? { material: String(mat[1]) } : {}),
      ...(eps ? { epsilonR: num(eps[1]) } : {}),
    };
  });
}

export function readBoard(root: SNode): Board {
  const pads: Pad[] = [];
  const footprints = new Map<string, Footprint>();
  for (const fp of kids(root, "footprint")) {
    const f = readFootprint(fp, pads);
    if (f) footprints.set(f.ref, f);
  }
  const segments: Segment[] = kids(root, "segment").map((sg) => ({
    a: pair(kid(sg, "start")),
    b: pair(kid(sg, "end")),
    w: num(kid(sg, "width")?.[1]),
    layer: String(kid(sg, "layer")?.[1] ?? ""),
    net: String(kid(sg, "net")?.slice(-1)[0] ?? ""),
  }));
  const vias: Via[] = kids(root, "via").map((v) => {
    const flags = v.slice(1).filter((t): t is string => typeof t === "string");
    const l = kid(v, "layers");
    return {
      kind: flags[0] ?? "through",
      layers: [String(l?.[1] ?? ""), String(l?.[2] ?? "")],
      net: String(kid(v, "net")?.slice(-1)[0] ?? ""),
      fill: (kid(v, "filling")?.[1] ?? "no") === "yes",
      cap: (kid(v, "capping")?.[1] ?? "no") === "yes",
      x: num(kid(v, "at")?.[1]),
      y: num(kid(v, "at")?.[2]),
      size: num(kid(v, "size")?.[1], 0.5),
    };
  });
  // copper zones only: rule areas (keepouts) name no net
  const zones: Zone[] = kids(root, "zone").flatMap((z) => {
    const netName = kid(z, "net_name") ?? kid(z, "net");
    if (!netName) return [];
    const lay = kid(z, "layers") ?? kid(z, "layer");
    return [{ net: String(netName.slice(-1)[0] ?? ""), layers: atoms(lay) }];
  });
  const layerTable = kid(root, "layers");
  const copper = new Set<string>();
  for (const e of layerTable?.slice(1) ?? [])
    if (Array.isArray(e) && typeof e[1] === "string" && /^(F|B|In\d+)\.Cu$/.test(e[1])) copper.add(e[1]);
  const ver = kid(root, "version");
  return {
    version: ver ? num(ver[1]) : null,
    copperLayers: [...copper].sort(copperOrder),
    stackup: readStackup(root),
    outline: readOutline(root),
    footprints,
    pads,
    segments,
    vias,
    zones,
    routedItems: segments.length + vias.length + kids(root, "arc").length,
  };
}

export function parseBoard(text: string): Board {
  return readBoard(parseSexpr(text));
}

/** True when `pad` has copper on `layer` (`*.Cu` pads are on every layer). */
export function padOnLayer(p: Pad, layer: string): boolean {
  return p.layers.some((l) => l.startsWith("*")) || p.layers.includes(layer);
}

/** A via's layers in stack order (`stack` is the board's copper layers, front to back). */
export function viaSpan(v: Via, stack: readonly string[]): [string, string] {
  const idx = (l: string) => {
    const i = stack.indexOf(l);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return idx(v.layers[0]) <= idx(v.layers[1]) ? [v.layers[0], v.layers[1]] : [v.layers[1], v.layers[0]];
}

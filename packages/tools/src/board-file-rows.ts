/**
 * `pcb_inspect` rows read from the `.kicad_pcb` text, for a board the PCB bridge's KiCad refuses because the file is
 * newer than it (`formatTooNew`). Each kind returns the row shape `design.query` returns through the bridge
 * (`apps/core/src/fp-pcb-design.ts`): millimetres rounded to the nanometre, layers as KiCad `BoardLayer` numbers, pads
 * and footprint graphics transformed to board coordinates. `unrouted` needs KiCad's connectivity (the ratsnest), which
 * the text does not carry, so it has no rows here.
 */
import { atoms, kid, kids, num, parseSexpr, type SNode } from "@fabdesk/board-workflow";
import type { DesignRow, DesignSelect } from "./services";

export type FileRowKind = Exclude<DesignSelect, "outline">;

/** Kinds the file reader cannot answer, with the reason an agent is shown. */
export const FILE_READER_UNAVAILABLE: Partial<Record<FileRowKind, string>> = {
  unrouted:
    "unrouted edges are KiCad's ratsnest, which needs the bridge to load the board; the file does not record them. islandsOfNet (from the file) shows each net's separate copper islands",
};

type Point = { x: number; y: number };

const mm = (v: number) => Math.round(v * 1_000_000) / 1_000_000;
const pt = (x: number, y: number): Point => ({ x: mm(x), y: mm(y) });
const xy = (n: SNode | undefined): [number, number] => [num(n?.[1]), num(n?.[2])];

const NAMED_LAYER: Record<string, number> = {
  "B.Adhes": 35, "F.Adhes": 36, "B.Paste": 37, "F.Paste": 38, "B.SilkS": 39, "F.SilkS": 40, "B.Mask": 41,
  "F.Mask": 42, "Dwgs.User": 43, "Cmts.User": 44, "Eco1.User": 45, "Eco2.User": 46, "Edge.Cuts": 47, Margin: 48,
  "B.CrtYd": 49, "F.CrtYd": 50, "B.Fab": 51, "F.Fab": 52, Rescue: 62,
};

/** KiCad `BoardLayer` number of a file layer name (the bridge's `layer` values); an unknown name stays a string. */
export function boardLayerId(name: string): number | string {
  if (name === "F.Cu") return 3;
  if (name === "B.Cu") return 34;
  const inner = /^In(\d+)\.Cu$/.exec(name);
  if (inner) return 3 + Number(inner[1]);
  const user = /^User\.(\d+)$/.exec(name);
  if (user) {
    const n = Number(user[1]);
    return n <= 9 ? 52 + n : 53 + n;
  }
  return NAMED_LAYER[name] ?? name;
}

function copperOrder(a: string, b: string): number {
  const rank = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 1000 : Number(l.replace(/\D/g, "")) || 0);
  return rank(a) - rank(b);
}

/** A footprint's placement: local (file) coordinates to board coordinates, as KiCad's RotatePoint does (y down). */
type Pose = { x: number; y: number; rot: number; c: number; s: number };
function poseOf(fp: SNode): Pose {
  const tr = kid(fp, "transform");
  let x: number, y: number, rot: number;
  if (tr) {
    [x, y] = xy(kid(tr, "translate"));
    rot = num(kid(tr, "rotate")?.[1]);
  } else {
    const at = kid(fp, "at");
    [x, y] = xy(at);
    rot = num(at?.[3]);
  }
  const rad = (rot * Math.PI) / 180;
  return { x, y, rot, c: Math.cos(rad), s: Math.sin(rad) };
}
const place = (p: Pose, lx: number, ly: number): Point => pt(p.x + lx * p.c + ly * p.s, p.y - lx * p.s + ly * p.c);

const isYes = (n: SNode | undefined) => n !== undefined && n[1] !== "no";
const locked = (n: SNode) => n.includes("locked") || isYes(kid(n, "locked"));
const uuidOf = (n: SNode) => String(kid(n, "uuid")?.[1] ?? kid(n, "tstamp")?.[1] ?? "");

/** Polygon vertices of a `(pts ...)` list; an arc segment contributes its three points. */
function ptsOf(n: SNode | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!n) return out;
  for (const q of n.slice(1)) {
    if (!Array.isArray(q)) continue;
    if (q[0] === "xy") out.push(xy(q));
    else if (q[0] === "arc") for (const key of ["start", "mid", "end"]) {
      const v = kid(q, key);
      if (v) out.push(xy(v));
    }
  }
  return out;
}

const SHAPE_KIND: Record<string, string> = {
  line: "segment",
  rect: "rectangle",
  arc: "arc",
  circle: "circle",
  poly: "polygon",
  curve: "bezier",
};

export interface BoardFileRows {
  version: number | null;
  /** Rows for `kind`, or null when the file reader cannot answer it (`FILE_READER_UNAVAILABLE`). */
  rows(kind: FileRowKind): DesignRow[] | null;
}

export function boardFileRows(text: string): BoardFileRows {
  const root = parseSexpr(text);
  // The pre-10 format numbers nets in a table and copper names them by code.
  const netByCode = new Map<string, string>();
  for (const n of kids(root, "net")) netByCode.set(String(n[1] ?? ""), String(n[2] ?? ""));
  const netOf = (n: SNode): string => {
    const named = kid(n, "net_name");
    if (named) return String(named[1] ?? "");
    const net = kid(n, "net");
    if (!net) return "";
    const last = String(net[net.length - 1] ?? "");
    return net.length === 2 && /^\d+$/.test(last) ? (netByCode.get(last) ?? "") : last;
  };
  const copper: string[] = [];
  for (const e of kid(root, "layers")?.slice(1) ?? [])
    if (Array.isArray(e) && typeof e[1] === "string" && /^(F|B|In\d+)\.Cu$/.test(e[1])) copper.push(e[1]);
  copper.sort(copperOrder);
  const copperOf = (tokens: string[]): string[] => {
    const out = new Set<string>();
    for (const t of tokens) {
      if (t === "*.Cu") for (const l of copper) out.add(l);
      else if (t === "F&B.Cu") out.add("F.Cu").add("B.Cu");
      else if (/^(F|B|In\d+)\.Cu$/.test(t)) out.add(t);
    }
    return [...out].sort(copperOrder);
  };
  const layerFields = (names: string[]) => ({
    layer: names[0] !== undefined ? boardLayerId(names[0]) : undefined,
    layers: names.map(boardLayerId),
    layerNames: names,
  });

  // An SMD pad with no copper layer (a paste-only aperture) keeps its own first layer, as the bridge's layerId does.
  const padLayers = (tokens: string[]) => {
    const fields = layerFields(copperOf(tokens));
    return fields.layer === undefined && tokens[0] !== undefined ? { ...fields, layer: boardLayerId(tokens[0]) } : fields;
  };

  // Footprints locked through a locked group (directly or by a nested group).
  const groupLocked = new Set<string>();
  {
    const groups = kids(root, "group").map((g) => ({ id: uuidOf(g), locked: locked(g), members: atoms(kid(g, "members")) }));
    const byId = new Map(groups.map((g) => [g.id, g]));
    const lockAll = (members: string[], seen: Set<string>) => {
      for (const m of members) {
        if (seen.has(m)) continue;
        seen.add(m);
        groupLocked.add(m);
        const nested = byId.get(m);
        if (nested) lockAll(nested.members, seen);
      }
    };
    for (const g of groups) if (g.locked) lockAll(g.members, new Set());
  }

  const footprints = kids(root, "footprint").map((fp) => {
    const props: Record<string, string> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2] ?? "");
    // pre-8 files keep reference and value as fp_text
    for (const t of kids(fp, "fp_text"))
      if (t[1] === "reference" || t[1] === "value") props[t[1] === "reference" ? "Reference" : "Value"] ??= String(t[2] ?? "");
    return { node: fp, ref: props["Reference"] ?? "", value: props["Value"] ?? "", pose: poseOf(fp), layer: String(kid(fp, "layer")?.[1] ?? "F.Cu") };
  });

  const cache = new Map<FileRowKind, DesignRow[]>();
  const build = (kind: FileRowKind): DesignRow[] | null => {
    switch (kind) {
      case "components":
        return footprints.map((f) => ({
          ref: f.ref,
          value: f.value,
          footprint: String(f.node[1] ?? ""),
          x: mm(f.pose.x),
          y: mm(f.pose.y),
          layer: boardLayerId(f.layer),
          rotation: f.pose.rot,
          flipped: f.layer === "B.Cu",
          locked: locked(f.node) || groupLocked.has(uuidOf(f.node)),
        }));
      case "pads":
        return footprints.flatMap((f) =>
          kids(f.node, "pad").map((pad) => {
            const [lx, ly] = xy(kid(pad, "at"));
            const at = place(f.pose, lx, ly);
            const size = kid(pad, "size");
            return {
              component: f.ref,
              number: String(pad[1] ?? ""),
              net: netOf(pad),
              x: at.x,
              y: at.y,
              width: mm(num(size?.[1])),
              height: mm(num(size?.[2], num(size?.[1]))),
              id: uuidOf(pad),
              ...padLayers(atoms(kid(pad, "layers"))),
            };
          }),
        );
      case "nets": {
        const counts = new Map<string, number>();
        const seen = new Set<string>();
        for (const p of build("pads")!) {
          const net = String(p["net"] ?? "");
          if (!net) continue;
          seen.add(net);
          counts.set(net, (counts.get(net) ?? 0) + 1);
        }
        for (const key of ["segment", "arc", "via", "zone"]) for (const n of kids(root, key)) seen.add(netOf(n));
        seen.delete("");
        const codeByName = new Map([...netByCode].map(([code, name]) => [name, Number(code)]));
        return [...seen]
          .sort((a, b) => (codeByName.get(a) ?? Infinity) - (codeByName.get(b) ?? Infinity) || a.localeCompare(b))
          .map((name) => ({
            name,
            ...(codeByName.has(name) ? { code: codeByName.get(name)! } : {}),
            pads: counts.get(name) ?? 0,
          }));
      }
      case "vias":
        return kids(root, "via").map((v) => {
          const [x, y] = xy(kid(v, "at"));
          const [a = "F.Cu", b = "B.Cu"] = atoms(kid(v, "layers"));
          const ia = copper.indexOf(a);
          const ib = copper.indexOf(b);
          const span = ia >= 0 && ib >= 0 ? copper.slice(Math.min(ia, ib), Math.max(ia, ib) + 1) : copperOf([a, b]);
          return {
            id: uuidOf(v),
            net: netOf(v),
            x: mm(x),
            y: mm(y),
            diameter: mm(num(kid(v, "size")?.[1])),
            drill: mm(num(kid(v, "drill")?.[1])),
            ...layerFields(span),
          };
        });
      case "tracks":
        return root.flatMap((n): DesignRow[] => {
          if (!Array.isArray(n)) return [];
          if (n[0] === "segment") {
            const [sx, sy] = xy(kid(n, "start"));
            const [ex, ey] = xy(kid(n, "end"));
            return [{
              kind: "Track",
              net: netOf(n),
              layer: boardLayerId(String(kid(n, "layer")?.[1] ?? "")),
              id: uuidOf(n),
              start: pt(sx, sy),
              end: pt(ex, ey),
              width: mm(num(kid(n, "width")?.[1])),
              length: mm(Math.hypot(ex - sx, ey - sy)),
            }];
          }
          if (n[0] === "arc")
            return [{
              kind: "Arc",
              net: netOf(n),
              layer: boardLayerId(String(kid(n, "layer")?.[1] ?? "")),
              id: uuidOf(n),
              start: pt(...xy(kid(n, "start"))),
              mid: pt(...xy(kid(n, "mid"))),
              end: pt(...xy(kid(n, "end"))),
              width: mm(num(kid(n, "width")?.[1])),
            }];
          if (n[0] === "via")
            return [{ kind: "Via", net: netOf(n), layer: boardLayerId(atoms(kid(n, "layers"))[0] ?? "F.Cu"), id: uuidOf(n) }];
          return [];
        });
      case "zones":
      case "keepouts":
        return kids(root, "zone")
          .filter((z) => (kind === "keepouts") === (kid(z, "keepout") !== undefined))
          .map((z) => {
            const names = atoms(kid(z, "layers") ?? kid(z, "layer"));
            const expanded = names.some((l) => /\.Cu$/.test(l)) ? copperOf(names) : names;
            return {
              id: uuidOf(z),
              name: String(kid(z, "name")?.[1] ?? ""),
              net: netOf(z),
              layers: expanded.map(boardLayerId),
              clearance: mm(num(kid(kid(z, "connect_pads") ?? [], "clearance")?.[1])),
              minThickness: mm(num(kid(z, "min_thickness")?.[1])),
              filled: kid(z, "filled_polygon") !== undefined,
              points: ptsOf(kid(kid(z, "polygon") ?? [], "pts")).map(([x, y]) => pt(x, y)),
            };
          });
      case "board_geometry":
        return root.flatMap((n): DesignRow[] => {
          if (!Array.isArray(n) || typeof n[0] !== "string") return [];
          const m = /^gr_(line|rect|arc|circle|poly|curve)$/.exec(n[0]);
          if (!m) return [];
          const layer = String(kid(n, "layer")?.[1] ?? "");
          const owned = kids(n, "property").some((p) => p[1] === "fabdesk.generated-outline" && p[2] === "native-atomic-edit");
          return [{
            id: uuidOf(n),
            owner: "board",
            locked: locked(n) || groupLocked.has(uuidOf(n)),
            toolOwnedOutline: layer === "Edge.Cuts" && owned,
            ...shapeGeometry(m[1]!, n, (x, y) => pt(x, y)),
            layer: boardLayerId(layer),
          }];
        });
      case "footprint_geometry": {
        const wanted = new Set(["F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"]);
        return footprints.flatMap((f) =>
          f.node.flatMap((n): DesignRow[] => {
            if (!Array.isArray(n) || typeof n[0] !== "string") return [];
            const m = /^fp_(line|rect|arc|circle|poly|curve)$/.exec(n[0]);
            const layer = String(kid(n, "layer")?.[1] ?? "");
            if (!m || !wanted.has(layer)) return [];
            return [{
              id: uuidOf(n),
              owner: f.ref,
              locked: locked(n),
              toolOwnedOutline: false,
              ...shapeGeometry(m[1]!, n, (x, y) => place(f.pose, x, y)),
              layer: boardLayerId(layer),
            }];
          }),
        );
      }
      case "texts":
        return kids(root, "gr_text").map((t) => {
          const at = kid(t, "at");
          const font = kid(kid(t, "effects") ?? [], "font") ?? [];
          const size = kid(font, "size");
          return {
            id: uuidOf(t),
            text: String(t[1] ?? ""),
            x: mm(num(at?.[1])),
            y: mm(num(at?.[2])),
            layer: boardLayerId(String(kid(t, "layer")?.[1] ?? "")),
            rotation: num(at?.[3]),
            size: { x: mm(num(size?.[2])), y: mm(num(size?.[1])) },
            thickness: mm(num(kid(font, "thickness")?.[1])),
          };
        });
      case "unrouted":
        return null;
    }
  };

  const ver = kid(root, "version");
  return {
    version: ver ? num(ver[1]) : null,
    rows(kind) {
      const hit = cache.get(kind);
      if (hit) return hit;
      const rows = build(kind);
      if (rows) cache.set(kind, rows);
      return rows;
    },
  };
}

/**
 * kind, start and end as the bridge's shape rows carry them (a rectangle's corners, a circle's centre and radius
 * point); arcs add their mid point and polygons and curves their vertices, so region and near filters see the body.
 */
function shapeGeometry(
  kind: string,
  n: SNode,
  map: (x: number, y: number) => Point,
): { kind: string; start: Point; end: Point; mid?: Point; points?: Point[] } {
  const at = (key: string): Point | undefined => {
    const v = kid(n, key);
    return v ? map(...xy(v)) : undefined;
  };
  const shape = SHAPE_KIND[kind] ?? kind;
  if (kind === "poly" || kind === "curve") {
    const points = ptsOf(kid(n, "pts")).map(([x, y]) => map(x, y));
    const origin = map(0, 0);
    return { kind: shape, start: points[0] ?? origin, end: points[points.length - 1] ?? origin, points };
  }
  const start = (kind === "circle" ? at("center") : at("start")) ?? map(0, 0);
  const end = at("end") ?? start;
  const mid = kind === "arc" ? at("mid") : undefined;
  return { kind: shape, start, end, ...(mid ? { mid } : {}) };
}


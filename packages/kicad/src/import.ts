/**
 * KiCad board import: `.kicad_pcb` -> circuit-json + a fail-closed report.
 *
 * `kicad-to-circuit-json` does the geometry (footprints, pads, holes, tracks, vias, zones,
 * outline). What it does not do reliably for a current (nightly) KiCad file is nets: the nightly
 * serialization drops the `(net N "name")` table and references nets by name everywhere, which
 * the converter reads as "no net". This module re-derives net identity from the parsed board
 * (`kicadts`), canonicalizes the names once (`net-names.ts`), links every pad, track, via and
 * pour to its net, emits the `source_*` elements tscircuit needs to build a routing problem, and
 * writes down everything it had to drop or could not verify. It never launches KiCad.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { KicadPcb, SxClass } from "kicadts";
import { KicadToCircuitJsonConverter } from "kicad-to-circuit-json";
import { buildNetNameMap, type NetNameMap } from "./net-names";

export interface ImportKicadOptions {
  pcbPath: string;
  /** Used for ids and messages only. Defaults to the file stem. */
  projectName?: string;
  /** `.kicad_pro` for design rules; defaults to the sibling with the same stem when present. */
  proPath?: string;
  /**
   * Fail (throw `KicadImportError`, report attached) on anything the routing problem would
   * misrepresent: net-name collisions, copper that could not be linked to a net, blind/buried/
   * micro vias, a copper layer count that disagrees with the converter. Default true.
   */
  strict?: boolean;
}

export type LayerMapping = { kicad: string; circuitJson: string; index: number; type: string };

export interface DroppedFeature {
  kind: string;
  count: number;
  detail: string;
}

export interface KicadDesignRules {
  source: string;
  netclass: string;
  traceWidthMm?: number;
  clearanceMm?: number;
  viaDiameterMm?: number;
  viaDrillMm?: number;
  minTrackWidthMm?: number;
  minViaDiameterMm?: number;
  minCopperEdgeClearanceMm?: number;
  diffPairWidthMm?: number;
  diffPairGapMm?: number;
  classes?: Array<Record<string, unknown>>;
}

export interface KicadImportReport {
  schema: 1;
  importedAt: string;
  converter: { name: string; version: string };
  source: {
    path: string;
    file: string;
    sha256: string;
    bytes: number;
    kicadVersion: number | null;
    generator: string | null;
    generatorVersion: string | null;
    /** `net-table` (stable `(net N "x")` list) or `net-by-name` (nightly, names inline). */
    netEncoding: "net-table" | "net-by-name" | "none";
    footprintPlacement: "at" | "transform" | "mixed" | "none";
  };
  board: {
    widthMm: number | null;
    heightMm: number | null;
    outlinePoints: number;
    /** KiCad coordinates of the circuit-json origin; circuit-json y grows up. */
    kicadOrigin: { x: number; y: number } | null;
  };
  layers: {
    copperCount: number;
    circuitJsonLayerCount: number | null;
    mapping: LayerMapping[];
    /** Non-copper KiCad layers present in the file (informational). */
    other: string[];
  };
  counts: {
    footprints: number;
    pads: number;
    padsByType: Record<string, number>;
    segments: number;
    arcs: number;
    vias: number;
    viasByKind: Record<string, number>;
    zones: number;
    filledPolygons: number;
    ruleAreas: number;
    nets: number;
    netsWithPads: number;
    netsRoutable: number;
    copperGraphics: number;
  };
  elements: Record<string, number>;
  nets: NetNameMap & {
    /** Nets referenced by copper but by no pad. */
    withoutPads: string[];
    /** Nets with exactly one pad (nothing to route). */
    singlePad: string[];
  };
  copper: {
    tracesLinked: number;
    tracesUnlinked: number;
    tracesConflicting: number;
    viasLinked: number;
    viasUnlinked: number;
    poursLinked: number;
    poursUnlinked: number;
    padsLinked: number;
    padsUnlinked: number;
    padsNoNet: number;
  };
  dropped: DroppedFeature[];
  unsupported: DroppedFeature[];
  designRules: KicadDesignRules | null;
  timings: { readMs: number; parseMs: number; convertMs: number; linkMs: number; totalMs: number };
  warnings: string[];
  /** Strict-mode failures; empty when the import is usable as a routing problem. */
  failures: string[];
}

export class KicadImportError extends Error {
  constructor(
    message: string,
    readonly report: KicadImportReport,
  ) {
    super(message);
    this.name = "KicadImportError";
  }
}

type El = Record<string, unknown> & { type: string };
type Point = { x: number; y: number };

const COPPER_RE = /^(F|B|In\d+)\.Cu$/;

function copperLayerName(kicad: string): string | undefined {
  if (kicad === "F.Cu") return "top";
  if (kicad === "B.Cu") return "bottom";
  const m = /^In(\d+)\.Cu$/.exec(kicad);
  return m ? `inner${m[1]}` : undefined;
}

/* ---------- kicadts access (structural, so a kicadts bump does not break the build) ---------- */

type NetRef = { id?: number | undefined; name?: string | undefined } | number | string | undefined;
type Named = { name?: string; names?: string[]; _names?: string[] } | string | undefined;

function layerNames(layer: Named | Named[]): string[] {
  if (layer === undefined) return [];
  if (typeof layer === "string") return [layer];
  if (Array.isArray(layer)) return layer.flatMap((l) => layerNames(l));
  const out: string[] = [];
  if (Array.isArray(layer.names)) out.push(...layer.names);
  if (Array.isArray(layer._names)) out.push(...layer._names);
  if (typeof layer.name === "string") out.push(layer.name);
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function xy(v: unknown): Point | undefined {
  const o = v as { x?: unknown; y?: unknown } | undefined;
  const x = num(o?.x);
  const y = num(o?.y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function ptsOf(v: unknown): Point[] {
  const o = v as { points?: unknown; pts?: unknown } | unknown[] | undefined;
  const list = Array.isArray(o)
    ? o
    : Array.isArray((o as { points?: unknown })?.points)
      ? (o as { points: unknown[] }).points
      : Array.isArray((o as { pts?: unknown })?.pts)
        ? (o as { pts: unknown[] }).pts
        : [];
  const out: Point[] = [];
  for (const p of list) {
    const q = xy(p);
    if (q) out.push(q);
  }
  return out;
}

class NetResolver {
  readonly table = new Map<number, string>();
  encoding: "net-table" | "net-by-name" | "none" = "none";
  constructor(nets: unknown[]) {
    for (const n of nets) {
      const o = n as { id?: unknown; name?: unknown; number?: unknown };
      const id = num(o.id) ?? num(o.number);
      if (id !== undefined && typeof o.name === "string") this.table.set(id, o.name);
    }
    if (this.table.size > 0) this.encoding = "net-table";
  }
  /** KiCad name, "" for no net, undefined when the reference cannot be resolved. */
  name(ref: NetRef): string | undefined {
    if (ref === undefined || ref === null) return "";
    if (typeof ref === "string") {
      if (this.encoding !== "net-table") this.encoding = "net-by-name";
      return ref;
    }
    if (typeof ref === "number") return ref === 0 ? "" : this.table.get(ref);
    if (typeof ref.name === "string") {
      if (this.encoding !== "net-table") this.encoding = "net-by-name";
      return ref.name;
    }
    const id = num(ref.id);
    if (id === undefined) return "";
    return id === 0 ? "" : this.table.get(id);
  }
}

/* ---------- geometry keys ---------- */

const KEY_SCALE = 1000; // 1 µm

function key(x: number, y: number, layer: string): string {
  return `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)}:${layer}`;
}

/** Looks up a point allowing 1 µm of rounding noise in either axis. */
function lookup<T>(map: Map<string, T>, x: number, y: number, layer: string): T | undefined {
  const bx = Math.round(x * KEY_SCALE);
  const by = Math.round(y * KEY_SCALE);
  for (const dx of [0, -1, 1]) {
    for (const dy of [0, -1, 1]) {
      const hit = map.get(`${bx + dx},${by + dy}:${layer}`);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

function apply(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/* ---------- design rules ---------- */

async function readDesignRules(proPath: string | undefined): Promise<KicadDesignRules | null> {
  if (!proPath) return null;
  let pro: Record<string, unknown>;
  try {
    pro = JSON.parse(await readFile(proPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const classes = (
    (pro["net_settings"] as { classes?: Array<Record<string, unknown>> } | undefined)?.classes ?? []
  ).filter((c) => typeof c === "object" && c !== null);
  const def = classes.find((c) => c["name"] === "Default") ?? classes[0];
  const rules = ((
    pro["board"] as { design_settings?: { rules?: Record<string, unknown> } } | undefined
  )?.design_settings?.rules ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  const out: KicadDesignRules = {
    source: basename(proPath),
    netclass: typeof def?.["name"] === "string" ? (def["name"] as string) : "Default",
    ...(n(def?.["track_width"]) !== undefined ? { traceWidthMm: n(def?.["track_width"])! } : {}),
    ...(typeof def?.["clearance"] === "number" ? { clearanceMm: def["clearance"] as number } : {}),
    ...(n(def?.["via_diameter"]) !== undefined ? { viaDiameterMm: n(def?.["via_diameter"])! } : {}),
    ...(n(def?.["via_drill"]) !== undefined ? { viaDrillMm: n(def?.["via_drill"])! } : {}),
    ...(n(rules["min_track_width"]) !== undefined
      ? { minTrackWidthMm: n(rules["min_track_width"])! }
      : {}),
    ...(n(rules["min_via_diameter"]) !== undefined
      ? { minViaDiameterMm: n(rules["min_via_diameter"])! }
      : {}),
    ...(n(rules["min_copper_edge_clearance"]) !== undefined
      ? { minCopperEdgeClearanceMm: n(rules["min_copper_edge_clearance"])! }
      : {}),
    ...(n(def?.["diff_pair_width"]) !== undefined
      ? { diffPairWidthMm: n(def?.["diff_pair_width"])! }
      : {}),
    ...(n(def?.["diff_pair_gap"]) !== undefined
      ? { diffPairGapMm: n(def?.["diff_pair_gap"])! }
      : {}),
    classes: classes.map((c) => ({
      name: c["name"],
      clearance: c["clearance"],
      track_width: c["track_width"],
      via_diameter: c["via_diameter"],
      via_drill: c["via_drill"],
      diff_pair_width: c["diff_pair_width"],
      diff_pair_gap: c["diff_pair_gap"],
    })),
  };
  return out;
}

/* ---------- the import ---------- */

export async function importKicadPcb(
  opts: ImportKicadOptions,
): Promise<{ circuitJson: unknown[]; report: KicadImportReport }> {
  const t0 = performance.now();
  const strict = opts.strict ?? true;
  const file = basename(opts.pcbPath);
  const stem = file.replace(/\.kicad_pcb$/i, "");
  const text = await readFile(opts.pcbPath, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const proPath = opts.proPath ?? join(dirname(opts.pcbPath), `${stem}.kicad_pro`);
  const tRead = performance.now();

  // 1. Parse for our own pass over nets and copper.
  const roots = SxClass.parse(text);
  const pcb = roots.find((r): r is KicadPcb => r instanceof KicadPcb);
  if (!pcb) throw new Error(`${file}: not a kicad_pcb file`);
  const tParse = performance.now();

  // 2. Geometry through the converter.
  const warnings: string[] = [];
  const conv = new KicadToCircuitJsonConverter();
  conv.addFile(file, text);
  const restore = captureConsole(warnings);
  try {
    conv.runUntilFinished();
  } finally {
    restore();
  }
  warnings.push(...conv.getWarnings());
  // The converter's own `source_*` elements (stable files, where the net table survives) are
  // replaced wholesale: one canonical mapping for every net reference, from this pass.
  const converterSourceElements = { source_net: 0, source_trace: 0, source_port: 0 } as Record<
    string,
    number
  >;
  const circuitJson = (conv.getOutput() as unknown as El[]).filter((e) => {
    if (e.type in converterSourceElements) {
      converterSourceElements[e.type] = (converterSourceElements[e.type] ?? 0) + 1;
      return false;
    }
    if (e.type === "pcb_trace" || e.type === "pcb_via" || e.type === "pcb_copper_pour") {
      delete e["source_trace_id"];
      delete e["source_net_id"];
    }
    return true;
  });
  const ctx = conv.ctx as
    | { k2cMatPcb?: Matrix; footprintUuidToComponentId?: Map<string, string> }
    | undefined;
  const matrix: Matrix = ctx?.k2cMatPcb ?? { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };
  const uuidToComponent = ctx?.footprintUuidToComponentId ?? new Map<string, string>();
  const tConvert = performance.now();

  const p = pcb as unknown as Record<string, unknown>;
  const failures: string[] = [];
  const dropped: DroppedFeature[] = [];
  const unsupported: DroppedFeature[] = [];
  const drop = (list: DroppedFeature[], kind: string, count: number, detail: string) => {
    if (count > 0) list.push({ kind, count, detail });
  };

  // Layers.
  const definitions =
    (p["layers"] as { definitions?: Array<{ name?: string; type?: string }> } | undefined)
      ?.definitions ?? [];
  const mapping: LayerMapping[] = [];
  const other: string[] = [];
  for (const d of definitions) {
    const name = d.name ?? "";
    const cj = COPPER_RE.test(name) ? copperLayerName(name) : undefined;
    if (cj)
      mapping.push({ kicad: name, circuitJson: cj, index: mapping.length, type: d.type ?? "" });
    else if (name) other.push(name);
  }
  // Stack order: top, inner1..N, bottom regardless of definition order.
  mapping.sort((a, b) => layerRank(a.circuitJson) - layerRank(b.circuitJson));
  mapping.forEach((m, i) => (m.index = i));
  const copperStack = mapping.map((m) => m.circuitJson);
  const copperOf = (kicad: string): string | undefined =>
    mapping.find((m) => m.kicad === kicad)?.circuitJson;
  const board = circuitJson.find((e) => e.type === "pcb_board");
  const cjLayerCount = num(board?.["num_layers"]) ?? null;
  if (cjLayerCount !== null && cjLayerCount !== mapping.length) {
    failures.push(
      `copper layer count mismatch: file declares ${mapping.length} copper layers, converter wrote num_layers=${cjLayerCount}`,
    );
  }

  // Nets.
  const resolver = new NetResolver((p["nets"] as unknown[] | undefined) ?? []);
  const netNames = new Set<string>();
  type NetInfo = {
    canonical: string;
    original: string;
    ports: Set<string>;
    pads: number;
    segments: number;
    vias: number;
    pours: number;
  };
  const nets = new Map<string, NetInfo>(); // by original KiCad name
  const netFor = (original: string | undefined): NetInfo | undefined => {
    if (!original) return undefined;
    let n = nets.get(original);
    if (!n) {
      n = {
        canonical: original,
        original,
        ports: new Set(),
        pads: 0,
        segments: 0,
        vias: 0,
        pours: 0,
      };
      nets.set(original, n);
      netNames.add(original);
    }
    return n;
  };

  // Pads -> ports.
  const padsByComponent = new Map<string, El[]>();
  for (const e of circuitJson) {
    if (e.type !== "pcb_smtpad" && e.type !== "pcb_plated_hole") continue;
    const cid = String(e["pcb_component_id"] ?? "");
    const list = padsByComponent.get(cid) ?? [];
    list.push(e);
    padsByComponent.set(cid, list);
  }
  const pcbPorts = new Map<string, El>();
  for (const e of circuitJson) if (e.type === "pcb_port") pcbPorts.set(String(e["pcb_port_id"]), e);
  const pcbComponents = new Map<string, El>();
  for (const e of circuitJson)
    if (e.type === "pcb_component") pcbComponents.set(String(e["pcb_component_id"]), e);

  const padsByType: Record<string, number> = {};
  let footprints = 0;
  let pads = 0;
  let padsLinked = 0;
  let padsUnlinked = 0;
  let padsNoNet = 0;
  let placementAt = 0;
  let placementTransform = 0;
  let footprintCopperGraphics = 0;
  let unresolvedNetRefs = 0;
  const portComponent = new Map<string, string>(); // source_port_id -> source_component_id
  const portName = new Map<string, string>();
  for (const fp of (p["footprints"] as unknown[] | undefined) ?? []) {
    footprints += 1;
    const f = fp as Record<string, unknown>;
    if (f["transform"] !== undefined) placementTransform += 1;
    else if (f["position"] !== undefined) placementAt += 1;
    const uuid =
      (f["uuid"] as { value?: string } | undefined)?.value ??
      (f["tstamp"] as { value?: string } | undefined)?.value ??
      "";
    const componentId = uuidToComponent.get(uuid);
    const component = componentId ? pcbComponents.get(componentId) : undefined;
    const sourceComponentId = component ? String(component["source_component_id"] ?? "") : "";
    for (const g of ["fpPolys", "fpLines", "fpArcs", "fpCircles", "fpRects"]) {
      for (const item of (f[g] as unknown[] | undefined) ?? []) {
        if (layerNames((item as { layer?: Named }).layer).some((l) => COPPER_RE.test(l)))
          footprintCopperGraphics += 1;
      }
    }
    const fpPads = ((f["fpPads"] ?? f["pads"]) as unknown[] | undefined) ?? [];
    for (const padRaw of fpPads) {
      pads += 1;
      const pad = padRaw as Record<string, unknown>;
      const padType = String(pad["padType"] ?? pad["type"] ?? "?");
      padsByType[padType] = (padsByType[padType] ?? 0) + 1;
      const number = String(pad["number"] ?? "");
      const netName = resolver.name(pad["net"] as NetRef);
      if (netName === undefined) {
        unresolvedNetRefs += 1;
        continue;
      }
      if (netName === "" || padType === "np_thru_hole") {
        padsNoNet += 1;
        continue;
      }
      const net = netFor(netName)!;
      net.pads += 1;
      const candidates =
        (componentId ? padsByComponent.get(componentId) : undefined)?.filter((e) =>
          (e["port_hints"] as unknown[] | undefined)?.some((h) => String(h) === number),
        ) ?? [];
      const sourcePortIds = new Set<string>();
      for (const c of candidates) {
        const port = pcbPorts.get(String(c["pcb_port_id"] ?? ""));
        const spid = port ? String(port["source_port_id"] ?? "") : "";
        if (spid) sourcePortIds.add(spid);
      }
      if (sourcePortIds.size === 0) {
        padsUnlinked += 1;
        continue;
      }
      padsLinked += 1;
      for (const spid of sourcePortIds) {
        net.ports.add(spid);
        if (sourceComponentId) portComponent.set(spid, sourceComponentId);
        portName.set(spid, number);
      }
    }
  }

  // Copper: segments, arcs, vias, zones (in KiCad coordinates, transformed to circuit-json).
  const endpointNet = new Map<string, string>(); // key(x,y,layer) -> original net name
  const viaNet = new Map<string, string>(); // key(x,y,"*") -> net
  let segments = 0;
  let arcs = 0;
  let copperGraphics = 0;
  for (const s of (p["segments"] as unknown[] | undefined) ?? []) {
    segments += 1;
    const seg = s as Record<string, unknown>;
    const netName = resolver.name(seg["net"] as NetRef);
    const layer = layerNames(seg["layer"] as Named)
      .map(copperOf)
      .find((l): l is string => l !== undefined);
    const a = xy(seg["start"]);
    const b = xy(seg["end"]);
    if (netName === undefined) {
      unresolvedNetRefs += 1;
      continue;
    }
    if (!netName || !layer || !a || !b) continue;
    netFor(netName)!.segments += 1;
    for (const pt of [a, b]) {
      const q = apply(matrix, pt);
      endpointNet.set(key(q.x, q.y, layer), netName);
    }
  }
  for (const s of (p["arcs"] as unknown[] | undefined) ?? []) {
    arcs += 1;
    const arc = s as Record<string, unknown>;
    const netName = resolver.name(arc["net"] as NetRef);
    const layer = layerNames(arc["layer"] as Named)
      .map(copperOf)
      .find((l): l is string => l !== undefined);
    if (netName === undefined) {
      unresolvedNetRefs += 1;
      continue;
    }
    if (!netName || !layer) continue;
    netFor(netName)!.segments += 1;
    for (const k of ["start", "end", "mid"]) {
      const pt = xy(arc[k]);
      if (!pt) continue;
      const q = apply(matrix, pt);
      endpointNet.set(key(q.x, q.y, layer), netName);
    }
  }
  const viasByKind: Record<string, number> = {};
  let vias = 0;
  for (const v of (p["vias"] as unknown[] | undefined) ?? []) {
    vias += 1;
    const via = v as Record<string, unknown>;
    const kind = typeof via["type"] === "string" && via["type"] ? String(via["type"]) : "through";
    viasByKind[kind] = (viasByKind[kind] ?? 0) + 1;
    const netName = resolver.name(via["net"] as NetRef);
    const at = xy(via["at"]);
    if (netName === undefined) {
      unresolvedNetRefs += 1;
      continue;
    }
    if (!netName || !at) continue;
    netFor(netName)!.vias += 1;
    const q = apply(matrix, at);
    viaNet.set(key(q.x, q.y, "*"), netName);
    endpointNet.set(key(q.x, q.y, "*"), netName);
  }
  for (const [kind, count] of Object.entries(viasByKind)) {
    if (kind !== "through")
      unsupported.push({
        kind: `via:${kind}`,
        count,
        detail:
          "blind/buried/micro vias are imported as through vias by the converter; the routing problem would misstate the stack",
      });
  }
  const pourNet = new Map<string, string>(); // key(firstPoint, layer) -> net
  let zones = 0;
  let filledPolygons = 0;
  let ruleAreas = 0;
  let unfilledZones = 0;
  let zoneKeepoutTracks = 0;
  for (const z of (p["zones"] as unknown[] | undefined) ?? []) {
    zones += 1;
    const zone = z as Record<string, unknown>;
    if (zone["keepout"] !== undefined) {
      ruleAreas += 1;
      const ko = zone["keepout"] as { tracks?: string; vias?: string; copperpour?: string };
      if (ko.tracks === "not_allowed" || ko.vias === "not_allowed") zoneKeepoutTracks += 1;
      continue;
    }
    const rawNet = zone["net"] as NetRef;
    const netName =
      resolver.name(rawNet) ??
      (typeof zone["netName"] === "string" ? (zone["netName"] as string) : undefined);
    const polys = (zone["filledPolygons"] as unknown[] | undefined) ?? [];
    if (polys.length === 0) {
      unfilledZones += 1;
      continue;
    }
    if (netName === undefined) {
      unresolvedNetRefs += 1;
      continue;
    }
    if (netName) netFor(netName)!.pours += polys.length;
    for (const fpRaw of polys) {
      filledPolygons += 1;
      const fpoly = fpRaw as Record<string, unknown>;
      const layer = layerNames((fpoly["layer"] ?? zone["layer"]) as Named)
        .map(copperOf)
        .find((l): l is string => l !== undefined);
      const pts = ptsOf(fpoly["pts"]);
      const first = pts[0];
      if (!layer || !first || !netName) continue;
      const q = apply(matrix, first);
      pourNet.set(key(q.x, q.y, layer), netName);
    }
  }
  for (const g of ["grLines", "grArcs", "grCircles", "grCurves"]) {
    for (const item of (p[g] as unknown[] | undefined) ?? []) {
      if (layerNames((item as { layer?: Named }).layer).some((l) => COPPER_RE.test(l)))
        copperGraphics += 1;
    }
  }
  drop(
    dropped,
    "rule-area",
    ruleAreas,
    `keepout/rule areas are not converted; ${zoneKeepoutTracks} restrict tracks or vias and are NOT enforced by the router`,
  );
  drop(
    dropped,
    "zone-unfilled",
    unfilledZones,
    "zones without filled polygons are not converted (no copper to preserve)",
  );
  drop(
    dropped,
    "copper-graphic",
    copperGraphics,
    "gr_line/gr_arc/gr_circle/gr_curve on copper layers are not converted (gr_rect/gr_poly become pads)",
  );
  drop(
    dropped,
    "footprint-copper-graphic",
    footprintCopperGraphics,
    "fp_poly/fp_line/... on copper layers inside footprints are not converted",
  );
  drop(
    unsupported,
    "net-ref-unresolved",
    unresolvedNetRefs,
    "net references the file's net table does not define",
  );

  // Canonical names.
  const nameMap = buildNetNameMap(netNames);
  for (const n of nets.values()) n.canonical = nameMap.byOriginal[n.original] ?? n.original;
  if (nameMap.collisions.length > 0) {
    failures.push(
      `net name collisions: ${nameMap.collisions.map((c) => `${c.canonical} <- ${c.originals.join(" | ")}`).join("; ")}`,
    );
  }

  // Source elements.
  const sourceNetId = new Map<string, string>(); // canonical -> id
  const sourceTraceId = new Map<string, string>();
  const added: El[] = [];
  const seenPorts = new Set<string>();
  let netIndex = 0;
  let traceIndex = 0;
  const netList = [...nets.values()].sort((a, b) => a.canonical.localeCompare(b.canonical));
  for (const n of netList) {
    if (sourceNetId.has(n.canonical)) continue;
    const id = `source_net_${netIndex++}`;
    sourceNetId.set(n.canonical, id);
    added.push({
      type: "source_net",
      source_net_id: id,
      name: n.canonical,
      member_source_group_ids: [],
      ...(n.canonical === "GND" || /^GND/.test(n.canonical) ? { is_ground: true } : {}),
      ...(/^(P\d|VCC|VDD|VBUS|\+)/.test(n.canonical) ? { is_power: true } : {}),
    });
    for (const spid of n.ports) {
      if (seenPorts.has(spid)) continue;
      seenPorts.add(spid);
      const name = portName.get(spid) ?? "";
      added.push({
        type: "source_port",
        source_port_id: spid,
        source_component_id: portComponent.get(spid) ?? "",
        name,
        ...(/^\d+$/.test(name) ? { pin_number: Number(name) } : {}),
        port_hints: [name],
      });
    }
    if (n.ports.size >= 1) {
      const tid = `source_trace_${traceIndex++}`;
      sourceTraceId.set(n.canonical, tid);
      added.push({
        type: "source_trace",
        source_trace_id: tid,
        connected_source_port_ids: [...n.ports],
        connected_source_net_ids: [id],
        display_name: n.canonical,
      });
    }
  }

  // Link converter copper to nets.
  let tracesLinked = 0;
  let tracesUnlinked = 0;
  let tracesConflicting = 0;
  let viasLinked = 0;
  let viasUnlinked = 0;
  let poursLinked = 0;
  let poursUnlinked = 0;
  const attach = (e: El, original: string): void => {
    const n = nets.get(original);
    if (!n) return;
    const nid = sourceNetId.get(n.canonical);
    const tid = sourceTraceId.get(n.canonical);
    if (nid) e["source_net_id"] = nid;
    if (tid) e["source_trace_id"] = tid;
  };
  for (const e of circuitJson) {
    if (e.type === "pcb_via") {
      const x = num(e["x"]);
      const y = num(e["y"]);
      const hit = x !== undefined && y !== undefined ? lookup(viaNet, x, y, "*") : undefined;
      if (hit) {
        attach(e, hit);
        viasLinked += 1;
      } else viasUnlinked += 1;
    } else if (e.type === "pcb_trace") {
      const route = (e["route"] as Array<Record<string, unknown>> | undefined) ?? [];
      const hits = new Set<string>();
      for (const pt of route) {
        const x = num(pt["x"]);
        const y = num(pt["y"]);
        if (x === undefined || y === undefined) continue;
        const layer = typeof pt["layer"] === "string" ? (pt["layer"] as string) : undefined;
        const hit =
          (layer ? lookup(endpointNet, x, y, layer) : undefined) ?? lookup(endpointNet, x, y, "*");
        if (hit) hits.add(hit);
      }
      if (hits.size === 0) tracesUnlinked += 1;
      else {
        if (hits.size > 1) tracesConflicting += 1;
        attach(e, [...hits][0]!);
        tracesLinked += 1;
      }
    } else if (e.type === "pcb_copper_pour") {
      const pts = (e["points"] as Point[] | undefined) ?? [];
      const first = pts[0];
      const layer = typeof e["layer"] === "string" ? (e["layer"] as string) : "";
      const hit = first ? lookup(pourNet, first.x, first.y, layer) : undefined;
      if (hit) {
        attach(e, hit);
        e["net_name"] = nets.get(hit)?.canonical ?? hit;
        poursLinked += 1;
      } else poursUnlinked += 1;
    }
  }
  const tLink = performance.now();

  if (tracesUnlinked > 0)
    failures.push(`${tracesUnlinked} converted trace(s) could not be linked to a net`);
  if (viasUnlinked > 0)
    failures.push(`${viasUnlinked} converted via(s) could not be linked to a net`);
  if (poursUnlinked > 0)
    failures.push(`${poursUnlinked} copper pour(s) could not be linked to a net`);
  if (tracesConflicting > 0)
    failures.push(`${tracesConflicting} converted trace(s) touch endpoints of more than one net`);
  if (padsUnlinked > 0)
    failures.push(`${padsUnlinked} netted pad(s) have no converted pad element`);
  for (const u of unsupported) failures.push(`unsupported: ${u.kind} x${u.count} (${u.detail})`);
  if (nets.size === 0) failures.push("no nets found");
  if (tracesLinked + viasLinked + poursLinked + padsLinked === 0)
    failures.push("no owned copper recognised");

  const elements: Record<string, number> = {};
  for (const e of circuitJson) elements[e.type] = (elements[e.type] ?? 0) + 1;
  for (const e of added) elements[e.type] = (elements[e.type] ?? 0) + 1;

  const withoutPads = netList.filter((n) => n.pads === 0).map((n) => n.canonical);
  const singlePad = netList.filter((n) => n.ports.size === 1).map((n) => n.canonical);
  const designRules = await readDesignRules(proPath);
  const outline = (board?.["outline"] as unknown[] | undefined) ?? [];
  const placement: KicadImportReport["source"]["footprintPlacement"] =
    placementAt && placementTransform
      ? "mixed"
      : placementTransform
        ? "transform"
        : placementAt
          ? "at"
          : "none";

  const report: KicadImportReport = {
    schema: 1,
    importedAt: new Date().toISOString(),
    converter: { name: "kicad-to-circuit-json", version: converterVersion() },
    source: {
      path: opts.pcbPath,
      file,
      sha256,
      bytes: Buffer.byteLength(text),
      kicadVersion: num(p["version"]) ?? null,
      generator: typeof p["generator"] === "string" ? (p["generator"] as string) : null,
      generatorVersion:
        typeof p["generatorVersion"] === "string" ? (p["generatorVersion"] as string) : null,
      netEncoding: resolver.encoding,
      footprintPlacement: placement,
    },
    board: {
      widthMm: num(board?.["width"]) ?? null,
      heightMm: num(board?.["height"]) ?? null,
      outlinePoints: outline.length,
      kicadOrigin: { x: -matrix.e, y: matrix.f },
    },
    layers: { copperCount: mapping.length, circuitJsonLayerCount: cjLayerCount, mapping, other },
    counts: {
      footprints,
      pads,
      padsByType,
      segments,
      arcs,
      vias,
      viasByKind,
      zones,
      filledPolygons,
      ruleAreas,
      nets: nets.size,
      netsWithPads: netList.filter((n) => n.pads > 0).length,
      netsRoutable: netList.filter((n) => n.ports.size >= 2).length,
      copperGraphics: copperGraphics + footprintCopperGraphics,
    },
    elements,
    nets: { ...nameMap, withoutPads, singlePad },
    copper: {
      tracesLinked,
      tracesUnlinked,
      tracesConflicting,
      viasLinked,
      viasUnlinked,
      poursLinked,
      poursUnlinked,
      padsLinked,
      padsUnlinked,
      padsNoNet,
    },
    dropped,
    unsupported,
    designRules,
    timings: {
      readMs: round(tRead - t0),
      parseMs: round(tParse - tRead),
      convertMs: round(tConvert - tParse),
      linkMs: round(tLink - tConvert),
      totalMs: round(performance.now() - t0),
    },
    warnings,
    failures,
  };
  void stem;
  void copperStack;
  const out = [...circuitJson, ...added];
  if (strict && failures.length > 0) {
    throw new KicadImportError(
      `${file}: import is not usable as a routing problem: ${failures.join("; ")}`,
      report,
    );
  }
  return { circuitJson: out, report };
}

function layerRank(name: string): number {
  if (name === "top") return 0;
  if (name === "bottom") return 1_000_000;
  const m = /^inner(\d+)$/.exec(name);
  return m ? Number(m[1]) : 500_000;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function converterVersion(): string {
  try {
    // Resolved relative to this package; the workspace hoists one copy.
    const pkg = require("kicad-to-circuit-json/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function captureConsole(sink: string[]): () => void {
  const warn = console.warn;
  const error = console.error;
  const capture = (...args: unknown[]) => {
    sink.push(
      args
        .map((a) =>
          a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a),
        )
        .join(" "),
    );
  };
  console.warn = capture;
  console.error = capture;
  return () => {
    console.warn = warn;
    console.error = error;
  };
}

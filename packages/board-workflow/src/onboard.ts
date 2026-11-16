/**
 * Onboarding: derive a board's requirements (its own definition of done) from the board and its
 * `.kicad_pro`: fixed parts as anchors, plane layers, power / pair / impedance classes, tap pads,
 * heights, and the circuit snapshot. Everything is a first proposal with its basis recorded; the
 * agent reviews `review` and owns the numbers afterwards (currents, widths, plane layers).
 */
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { legacyNetRefs, parseBoard, type Board, type Footprint, type Pad } from "./board";
import {
  boardHome,
  designHash,
  exists,
  locateProject,
  readJsonOrNull,
  writeJsonFile,
  type DesignHash,
} from "./files";
import { netsByClass, readProjectSettings, type ProjectSettings } from "./project";
import {
  REQUIREMENT_FILES,
  type Acceptance,
  type NetClassSpec,
  type Requirements,
  type TapPad,
} from "./requirements";

const IMPEDANCE = /ohm|(^|[_\W])\d+R($|[_\W])|(^|_)SE_|IMPED|Z0/i;
const PAIR_CLASS = /diff|pair|usb|lvds|pcie|eth|hdmi|\bdp\b|_dp|mipi|csi|dsi|sata|ddr|dqs|clk|ohm|sfi|serdes|can/i;
const POWER_CLASS = /pwr|power|supply|vbat|bat|vin|vbus|gnd|ground|rail/i;
const FIXED_REF = /^((J[A-Z]*|SW|CN|P)\d|H\d|MH|FID|FIT_)/;
const PAIR_STYLES: ReadonlyArray<readonly [string, string]> = [
  ["DP", "DN"],
  ["DP", "DM"],
  ["+", "-"],
  ["P", "N"],
  ["P", "M"],
];

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");

function pairCore(name: string): string {
  const net = name.startsWith("Net-(");
  const core = net && name.endsWith(")") ? name.slice(5, -1) : name;
  if (!net) return core;
  return core.replaceAll("{slash}", "/").split("/").pop()!;
}

function beforeLast(s: string, sep: string): string {
  const i = s.lastIndexOf(sep);
  return i < 0 || sep === "" ? s : s.slice(0, i);
}

/** [P, N] pairs by KiCad/KRT suffix rules plus the P/M convention, matched within one style. */
export function findPairs(nets: Iterable<string>): Array<[string, string]> {
  const list = [...nets];
  const used = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const [pos, neg] of PAIR_STYLES) {
    const rx = new RegExp(`^(.*?)(${escapeRx(pos)}|${escapeRx(neg)})([\\d_]*)$`, "s");
    const groups = new Map<string, { P?: string; N?: string }>();
    for (const n of list) {
      if (used.has(n)) continue;
      const core = pairCore(n);
      const m = rx.exec(core);
      if (!m) continue;
      const pre = n.startsWith("Net-(") ? n.slice(0, 5) + beforeLast(n.slice(5, -1), core) : "";
      const key = JSON.stringify([pre, m[1], m[3]]);
      const g = groups.get(key) ?? {};
      g[m[2] === pos ? "P" : "N"] = n;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.P !== undefined && g.N !== undefined) {
        pairs.push([g.P, g.N]);
        used.add(g.P);
        used.add(g.N);
      }
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return pairs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
}

/** '100n', '0.1uF', '4k7', '10K' -> farads or ohms; null when unreadable. */
export function valueSi(v: string | null | undefined): number | null {
  const m = /^\s*([\d.]+)\s*([pnumkKMR]?)(\d*)/.exec(String(v ?? ""));
  if (!m) return null;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, R: 1, "": 1 };
  const x = Number(m[1]! + (m[3] ? "." + m[3] : ""));
  return Number.isFinite(x) ? x * mult[m[2]!]! : null;
}

/**
 * Low-current pads on power-class nets may be tapped narrower than the class width (the A7 check
 * accepts a branch that feeds only tap pads at the tap width). Categories as C6 lastmile89, each
 * with its basis; IC supply pins only on classes <= 0.3 mm (logic rails, <= 1 A).
 */
export function tapPads(
  classes: Record<string, NetClassSpec>,
  fps: Map<string, Footprint>,
  pads: readonly Pad[],
  boardMin: number,
): Record<string, Record<string, TapPad> | string> {
  const out: Record<string, Record<string, TapPad> | string> = {
    _format: "net -> {REF.PAD: {width (mm), basis}}",
  };
  for (const [k, c] of Object.entries(classes)) {
    if (!k.startsWith("PWR_")) continue;
    const w = c.track_width!;
    const members = new Set(c.nets);
    for (const p of pads) {
      if (!members.has(p.net)) continue;
      const pfx = /^[A-Z]+/.exec(p.ref)?.[0] ?? "";
      const val = valueSi(fps.get(p.ref)?.value);
      let tap: [number, string] | null = null;
      if (pfx === "R" && val !== null && val >= 100) tap = [0.15, "resistor >= 100 ohm: under 60 mA at rail voltages up to 6 V"];
      else if (pfx === "TP") tap = [0.15, "test point: probe current only"];
      else if (pfx === "C" && val !== null && val <= 100e-9)
        tap = [0.2, "100 nF or smaller HF decoupler: small ripple share beside the bulk capacitors"];
      else if ((pfx === "U" || pfx === "IC") && w <= 0.3 + 1e-6)
        tap = [
          0.15,
          `logic IC supply pin on a ${w} mm (<= 1 A) rail: per-pin current (tens of mA) far under 0.6 A ` +
            "(0.15 mm, IPC-2221 external); routers neck to the board minimum at fine-pitch pins",
        ];
      if (tap && tap[0] < w) {
        const byNet = (out[p.net] ??= {}) as Record<string, TapPad>;
        byNet[`${p.ref}.${p.pad}`] = { width: Math.max(tap[0], boardMin), basis: tap[1] };
      }
    }
  }
  return out;
}

/** Python's `format(x, 'g')`-free number text for anchors: shortest form at micron precision. */
const mm = (x: number) => String(Number(x.toFixed(6)));

export interface OnboardOptions {
  /** Name for the purpose line; defaults to the project folder name. */
  name?: string;
  /** Extra fixed references (besides connectors, switches, holes, netless and locked parts). */
  fixed?: string[];
  /** Plane layers; default: inner layers holding only GND zones and no other-net tracks. */
  planes?: string[];
  /** Replace a routed board's native rules with the proposal (for a bare-board flow). */
  proposedRules?: boolean;
  /** Expected current per net, amps (the neck rule scales with it; the review stage reads it). */
  currents?: Record<string, number>;
}

export interface OnboardRecord {
  source: string;
  at: string;
  decided: string[];
  review: string[];
  fixed: string[];
  counts: {
    footprints: number;
    fixed: number;
    movable: number;
    nets: number;
    pairs: number;
    classes: number;
    layers: string[];
    planes: string[];
  };
  /** Hash of the board, schematics and project settings as onboarded (the baseline key). */
  boardHash: string;
  designHash: string;
  confirmed: boolean;
}

export interface Derived {
  requirements: Requirements;
  decided: string[];
  review: string[];
  fixed: string[];
  counts: OnboardRecord["counts"];
}

/** Pure derivation from the board text and the project settings. */
export function deriveRequirements(
  boardText: string,
  settings: ProjectSettings,
  opts: OnboardOptions & { pcbName: string },
): Derived {
  const legacy = legacyNetRefs(boardText);
  if (legacy)
    throw new Error(
      `${opts.pcbName} is in the pre-10 KiCad file format (${legacy} items name their net by number); ` +
        "tracks would match no net by name. Upgrade it first: board_check upgrade: true (a checked copy written over the board, the previous one kept), or upgradeCopy.",
    );
  const board: Board = parseBoard(boardText);
  const fps = board.footprints;
  const pads = board.pads;
  const decided: string[] = [];
  const review: string[] = [];
  const name = opts.name ?? "board";
  decided.push(`${board.routedItems} routed items (segments/vias/arcs) in the source`);

  // ---- layers and planes
  const copper = board.copperLayers;
  const zones = new Map<string, Set<string>>();
  for (const z of board.zones) for (const l of z.layers) (zones.get(l) ?? zones.set(l, new Set()).get(l)!).add(z.net);
  const segLayerNet = new Set(board.segments.map((s) => `${s.layer}\u0000${s.net}`));
  const hasGnd = (n: string) => n.includes("GND");
  let planes: string[];
  if (opts.planes) {
    planes = opts.planes;
    decided.push(`planes from options: ${JSON.stringify(planes)}`);
  } else {
    planes = copper.filter(
      (l) =>
        l.startsWith("In") &&
        zones.get(l)?.size &&
        [...zones.get(l)!].every(hasGnd) &&
        ![...segLayerNet].some((k) => {
          const [ly, n] = k.split("\u0000");
          return ly === l && !hasGnd(n!);
        }),
    );
    decided.push(`planes: inner layers with only GND zones and no other-net tracks in the source: ${planes.length ? JSON.stringify(planes) : "none"}`);
    review.push("planes: confirm the plane layers (no signal tracks will be allowed on them)");
  }
  const signalLayers = copper.filter((l) => !planes.includes(l));
  const gndCount = new Map<string, number>();
  for (const p of pads) if (hasGnd(p.net)) gndCount.set(p.net, (gndCount.get(p.net) ?? 0) + 1);
  let gnd = "GND";
  let best = 0;
  for (const [n, c] of gndCount)
    if (c > best) {
      best = c;
      gnd = n;
    }

  // ---- fixed parts
  const netted = new Set(pads.filter((p) => p.net).map((p) => p.ref));
  const extra = new Set(opts.fixed ?? []);
  const fixed = [...fps.values()]
    .filter((f) => FIXED_REF.test(f.ref) || !netted.has(f.ref) || f.locked || extra.has(f.ref))
    .map((f) => f.ref)
    .sort();
  decided.push(`${fixed.length} fixed parts (connectors, switches, holes, netless, locked, extra): ${JSON.stringify(fixed)}`);
  review.push("fixed: confirm every connector/mating part is really fixed and nothing else is");

  // ---- requirements
  const mechanical = {
    units: "mm",
    anchors: fixed.map((r) => {
      const f = fps.get(r)!;
      return { reference: r, at: [mm(f.x), mm(f.y)] as [string, string], rotation: [mm(f.rot)] as [string], layer: f.layer };
    }),
    basis: `onboard: fixed parts at their source poses (${opts.pcbName})`,
  };
  const circuit = {
    components: [...fps.values()]
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map((f) => ({ reference: f.ref, value: f.value, pins: f.pins })),
    basis: `onboard snapshot of ${opts.pcbName}: footprint set, values and pad nets`,
  };
  const heights = { entries: [], basis: "no height data supplied" };

  const nets = new Set(pads.filter((p) => p.net).map((p) => p.net));
  const ncls = netsByClass(settings, nets);
  const pcls = new Map(settings.classes.map((c) => [c.name, c]));
  const dflt = pcls.get("Default") ?? { name: "Default" };
  const minW = settings.minTrackWidth ?? 0.1;
  const minC = settings.minClearance ?? 0.1;
  const dw = dflt.track_width ?? 0.15;
  const classes: Record<string, NetClassSpec> = {};
  const pairsAll = findPairs(nets);
  for (const [cname, c] of pcls) {
    if (cname === "Default") continue;
    const members = [...ncls].filter(([, k]) => k === cname).map(([n]) => n).sort();
    if (!members.length) continue;
    const memberSet = new Set(members);
    const cpairs = pairsAll.filter((p) => memberSet.has(p[0]) && memberSet.has(p[1]));
    const safe = cname.replace(/\W+/g, "_").toUpperCase();
    // A pair class by name, or pairs make up most of it and it is not a power class (a power class
    // holding BAT_P/BAT_N is not).
    const pairish = PAIR_CLASS.test(cname);
    const mostlyPairs = 2 * cpairs.length >= 0.6 * members.length;
    const width = c.track_width ?? 0;
    if (cpairs.length && (pairish || (mostlyPairs && !POWER_CLASS.test(cname)))) {
      const dpw = c.diff_pair_width || (c.track_width ?? dw);
      classes[`PAIR_${safe}`] = {
        source_class: cname,
        track_width: dpw,
        diff_pair_width: dpw,
        diff_pair_gap: c.diff_pair_gap || 0.15,
        layers: signalLayers,
        escape_layers: ["F.Cu", "B.Cu"],
        escape_allowance_mm: 4.0,
        inner_stray_mm: 1e9,
        pairs: cpairs,
        intra_pair_skew_max_mm: 2.5,
        min_coupled_share: 0.5,
        coupling_applies_from_mm: 7.0,
        neck_min_width_ratio: 0.9,
        neck_max_mm: 2.5,
        basis:
          `onboard from .kicad_pro class '${cname}': width/gap as set there; layers = all signal layers ` +
          "(no impedance stack data); coupling rule as C6 (>= 7 mm pairs at least half coupled).",
      };
      const leftover = members.filter((n) => !cpairs.some((p) => p.includes(n)));
      if (leftover.length) review.push(`class ${cname}: nets without a pair partner ${JSON.stringify(leftover.slice(0, 6))}`);
    } else if (width > dw + 1e-6 && IMPEDANCE.test(cname)) {
      // An impedance class (50R, 90ohm, SE_..): its width comes from the stack, not from current.
      classes[`IMP_${safe}`] = {
        source_class: cname,
        track_width: width,
        nets: members,
        basis: `onboard from .kicad_pro impedance class '${cname}'; width from the stack; native DRC checks it`,
      };
    } else if (width > dw + 1e-6) {
      const key = `PWR_${Math.round(width * 1000)}`;
      const have = classes[key];
      if (have) {
        have.nets = [...new Set([...(have.nets ?? []), ...members])].sort();
        have.source_class += `, ${cname}`;
        continue;
      }
      classes[key] = {
        source_class: cname,
        track_width: width,
        inner_track_width: width,
        nets: members,
        basis:
          `onboard from .kicad_pro class '${cname}' (width ${width} mm). Current not supplied: the agent ` +
          "should confirm the width from the expected current (IPC-2221).",
      };
    }
  }
  decided.push(`classes: ${JSON.stringify(Object.entries(classes).map(([k, v]) => [k, v.source_class]))}`);
  review.push("rules: confirm power widths from current and pair width/gap from the stack (onboard copies the .kicad_pro)");

  const acceptance: Acceptance = {
    schema: "FLOW_ACCEPTANCE_V1",
    status: "ONBOARD_PROPOSAL",
    purpose: `Generated acceptance for ${name} from ${opts.pcbName}; review before relying on it.`,
    authority: {
      circuit: "requirements/circuit.json",
      mechanical: "requirements/mechanical.json",
      heights: "requirements/heights.json",
    },
    heights: { F_max_mm: 1e9, B_max_mm: 1e9, basis: "no height limits supplied" },
    manufacturing_rules: {
      adopted: {
        min_track_width: minW,
        min_clearance: minC,
        default_class: {
          track_width: dw,
          clearance: dflt.clearance ?? minC,
          via_diameter: dflt.via_diameter ?? 0.5,
          via_drill: dflt.via_drill ?? 0.2,
        },
      },
      scoped_rules: [],
      basis: "copied from the source .kicad_pro",
      native_project_rules: board.routedItems > 0 && !opts.proposedRules,
      native_project_rules_basis:
        "the source is a routed board: its own .kicad_pro classes and .kicad_dru scoped rules are the authority " +
        "for edits; proposedRules replaces them with this proposal (bare-board flow)",
    },
    stack_policy: {
      copper_layers: copper,
      plane_layers: planes,
      no_track_layers: planes,
      ground_net: gnd,
      via_spans: { through: [copper[0] ?? "F.Cu", copper[copper.length - 1] ?? "B.Cu"] },
    },
    net_classes: {
      tap_rule:
        "A branch whose removal cuts off only tap pads may be as narrow as the widest tap minimum on it " +
        "(C6 lastmile89 rule; categories and bases in tap_pads).",
      tap_pads: tapPads(classes, fps, pads, minW),
      neck_allowance: "Power tracks may neck to the board minimum within 1.0 mm of a pad.",
      ...(opts.currents && Object.keys(opts.currents).length ? { net_current_A: opts.currents } : {}),
      class_clearance: dflt.clearance ?? minC,
      router_width_rules: { neck_floor_mm: minW },
      classes,
    },
    automatic_checks: {
      A1_connectivity: "native DRC 0 unconnected",
      A2_drc: "0 DRC errors",
      A3_parity: "schematic parity 0",
      A4_circuit: "circuit.json",
      A5_anchors: "mechanical.json anchors",
      A6_stack: "no tracks on plane layers",
      A7_widths: "power class widths",
      A8_pairs: "pair width/layers/coupling",
      A9_heights: "heights.json",
    },
  };
  const pairCount = Object.values(classes).reduce((n, c) => n + (c.pairs?.length ?? 0), 0);
  return {
    requirements: { acceptance, circuit, mechanical, heights },
    decided,
    review,
    fixed,
    counts: {
      footprints: fps.size,
      fixed: fixed.length,
      movable: fps.size - fixed.length,
      nets: nets.size,
      pairs: pairCount,
      classes: Object.keys(classes).length,
      layers: copper,
      planes,
    },
  };
}

export function requirementsDir(projectDir: string): string {
  return join(boardHome(projectDir), "requirements");
}

export async function readRequirements(projectDir: string): Promise<Requirements | null> {
  const dir = requirementsDir(projectDir);
  const [acceptance, circuit, mechanical, heights] = await Promise.all(
    (["acceptance", "circuit", "mechanical", "heights"] as const).map((k) =>
      readJsonOrNull<never>(join(dir, REQUIREMENT_FILES[k])),
    ),
  );
  if (!acceptance || !circuit || !mechanical || !heights) return null;
  return { acceptance, circuit, mechanical, heights } as Requirements;
}

export async function readOnboardRecord(projectDir: string): Promise<OnboardRecord | null> {
  return readJsonOrNull<OnboardRecord>(join(boardHome(projectDir), "onboard.json"));
}

export interface OnboardResult extends Derived {
  record: OnboardRecord;
  hash: DesignHash;
  dir: string;
}

/**
 * Onboard the project's board: derive its requirements and store them in `<project>/.fabdesk/board/`.
 * Refuses to overwrite existing requirements unless `refresh` (the agent may have edited them).
 */
export async function onboard(
  projectDir: string,
  opts: OnboardOptions & { pcb?: string; refresh?: boolean; now?: () => Date } = {},
): Promise<OnboardResult> {
  const files = await locateProject(projectDir, opts.pcb);
  const dir = requirementsDir(projectDir);
  if (!opts.refresh && (await exists(join(dir, REQUIREMENT_FILES.acceptance))))
    throw new Error("requirements already exist (.fabdesk/board/requirements); pass refresh to derive them again");
  const settings = files.pro ? readProjectSettings(await readFile(files.pro, "utf8")) : readProjectSettings("{}");
  const pcbName = basename(files.pcb);
  const derived = deriveRequirements(await readFile(files.pcb, "utf8"), settings, {
    ...opts,
    name: opts.name ?? (basename(projectDir) || "board"),
    pcbName,
  });
  if (!files.pro) derived.review.push("no .kicad_pro: net classes and board rules are defaults");
  for (const k of ["acceptance", "circuit", "mechanical", "heights"] as const)
    await writeJsonFile(join(dir, REQUIREMENT_FILES[k]), derived.requirements[k]);
  const hash = await designHash(projectDir);
  const record: OnboardRecord = {
    source: files.pcb,
    at: (opts.now?.() ?? new Date()).toISOString(),
    decided: derived.decided,
    review: derived.review,
    fixed: derived.fixed,
    counts: derived.counts,
    boardHash: hash.board,
    designHash: hash.design,
    confirmed: false,
  };
  await writeJsonFile(join(boardHome(projectDir), "onboard.json"), record);
  return { ...derived, record, hash, dir };
}

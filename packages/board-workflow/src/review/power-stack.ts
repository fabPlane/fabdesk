/**
 * The complete declared-current inner-power audit (the toolkit's `review/power_stack.py` over `tools/stack_audit.py`'s
 * census), independent of `checkCurrent`'s trunk heuristic.
 *
 * Census (`stackCensus`, stack_audit `inspect`): every current-declared net with copper on an inner layer, plus the
 * acceptance's `supplier_stack.audit_power_nets`, with its tracks, vias, pads (contact outline, schematic pin name and
 * electrical type), zones; and every declared pair's routed geometry.
 *
 * Audit (`auditPower`): widths reduced by `supplier_stack.power_width_reduction_mm` (the etched top width); terminals by
 * exported pin type (`terminal`); heat = IPC-2221 internal on actual copper with the full net current on every inner
 * segment (<= 20 C); drop = the worst track/via shortest path between all terminals (<= 2 % of the net-name voltage),
 * pours never credited. A missing or disconnected terminal, or fewer than two, fails the net. The IPC-2152 baseline fit
 * and the ECSS IPC-2152 vacuum fit are reported as cross-checks only.
 *
 * Check (`checkInnerPower`, `inner_power`): the toolkit ran this as its custom check `checks.d/inner-power.json` on the
 * C6 boards; here it is built in and runs on a board whose acceptance declares a `supplier_stack` (the data it audits
 * against) or whose review config sets `inner_power`. Findings are the custom check's (rule INNER_POWER, same ids).
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board, Segment, Via } from "../board";
import type { Acceptance } from "../requirements";
import { kid, kids, num, type SNode } from "../sexpr";
import { pyDumps, rise2221, traceRiseC } from "./checks";
import type { ReviewCtx } from "./context";
import { pathCensus, mathDist, pySum, type ContactShape, type PathCensus } from "./current-paths";
import { f } from "./fmt";
import * as I from "./impedance";
import type { Comp } from "./netlist";
import { makeFinding, newResult, type CheckResult } from "./types";

/** The acceptance's supplier-stack record (the keys the audit reads). */
export interface SupplierStack {
  audit_power_nets?: string[];
  power_width_reduction_mm?: number;
  [k: string]: unknown;
}

export interface CensusPad {
  ref: string;
  pad: string;
  net: string;
  x: number;
  y: number;
  r: number;
  layers: string[];
  contact_r: number;
  contact_shape: ContactShape | null;
  value: string | null;
  function: string | null;
  type: string | null;
}

export interface CensusNet {
  current_A: number;
  pads: CensusPad[];
  segments: Segment[];
  zones: Array<{ layer: string | null; polygons: number[][][] }>;
  vias: Via[];
}

export interface StackCensus {
  board: string;
  pcb_sha256: string;
  power_model: { width_reduction_mm: number };
  /** [name, "copper" | "dielectric", thickness mm, er], front to back. */
  stack: Array<[string, string, number, number]>;
  inner_power: Record<string, CensusNet>;
  pairs: Array<{ class: string; pair: [string, string]; layers: ReturnType<typeof I.measuredGap>; segments: Segment[]; vias: Via[] }>;
}

const OUTER = new Set(["F.Cu", "B.Cu"]);

export const supplierStack = (acc: Acceptance | null): SupplierStack | null => ((acc?.["supplier_stack"] as SupplierStack | undefined) ?? null);

/**
 * stack_audit `inspect`: the read-only census. `copper` is the stack a `*.Cu` pad spans (the acceptance's
 * `stack_policy.copper_layers`, else the board's copper layers).
 */
export function stackCensus(text: string, root: SNode, board: Board, acc: Acceptance, comps: Map<string, Comp>, boardPath = ""): StackCensus {
  const copper = acc.stack_policy?.copper_layers ?? board.copperLayers;
  const radii = new Map<string, number>();
  const shapes = new Map<string, ContactShape>();
  for (const fp of kids(root, "footprint")) {
    let ref: string | undefined;
    for (const p of kids(fp, "property")) if (p[1] === "Reference") ref = String(p[2] ?? "");
    for (const p of kids(fp, "pad")) {
      const size = kid(p, "size");
      if (!size) continue;
      const sz: [number, number] = [num(size[1]), num(size[2])];
      const at = kid(p, "at") ?? [];
      const key = `${ref}\u0000${String(p[1])}`;
      radii.set(key, Math.min(...sz) / 2);
      shapes.set(key, {
        shape: String(p[3] ?? ""),
        size: sz,
        rotation: at.length > 3 ? num(at[3]) : (board.footprints.get(ref ?? "")?.rot ?? 0),
        roundrect_ratio: num(kid(p, "roundrect_rratio")?.[1], 0),
      });
    }
  }
  const nc = acc.net_classes;
  const currents: Record<string, number> = {};
  for (const cl of Object.values(nc.classes ?? {})) if (cl.current_max_A) for (const n of cl.nets ?? []) currents[n] = cl.current_max_A;
  Object.assign(currents, nc.net_current_A ?? {});
  const inner = new Set(board.segments.filter((s) => !OUTER.has(s.layer) && s.net in currents).map((s) => s.net));
  for (const n of supplierStack(acc)?.audit_power_nets ?? []) inner.add(n);
  const powers: Record<string, CensusNet> = {};
  for (const net of [...inner].sort()) {
    if (!(net in currents)) throw new Error(`supplier_stack.audit_power_nets names ${net}, which has no declared current`);
    const pads: CensusPad[] = [];
    for (const p of board.pads) {
      if (p.net !== net) continue;
      const pin = comps.get(p.ref)?.pins.get(p.pad);
      const key = `${p.ref}\u0000${p.pad}`;
      const layers = p.layers.some((l) => l.startsWith("*")) ? [...copper] : p.layers.filter((l) => l.endsWith(".Cu"));
      pads.push({
        ...p,
        layers: [...new Set(layers)].sort(),
        contact_r: radii.get(key) ?? 0.0,
        contact_shape: shapes.get(key) ?? null,
        value: board.footprints.get(p.ref)?.value ?? null,
        function: pin ? pin.name : null,
        type: pin ? pin.type : null,
      });
    }
    const zones: CensusNet["zones"] = [];
    for (const z of kids(root, "zone")) {
      const zn = kid(z, "net_name") ?? kid(z, "net");
      if (String(zn?.[zn.length - 1] ?? "") !== net || !zn) continue;
      const lay = kid(z, "layer");
      zones.push({
        layer: lay ? String(lay[lay.length - 1]) : null,
        polygons: kids(z, "filled_polygon").map((poly) => kids(kid(poly, "pts") ?? [], "xy").map((q) => [num(q[1]), num(q[2])])),
      });
    }
    powers[net] = { current_A: currents[net]!, pads, segments: board.segments.filter((s) => s.net === net), zones, vias: board.vias.filter((v) => v.net === net) };
  }
  const pairs: StackCensus["pairs"] = [];
  for (const [name, cl] of Object.entries(nc.classes ?? {})) {
    if (!cl.pairs?.length) continue;
    for (const [p, n] of cl.pairs) {
      const ps = board.segments.filter((s) => s.net === p), ns = board.segments.filter((s) => s.net === n);
      pairs.push({ class: name, pair: [p, n], layers: I.measuredGap(ps, ns, Number(cl.diff_pair_width), Number(cl.diff_pair_gap)), segments: [...ps, ...ns], vias: board.vias.filter((v) => v.net === p || v.net === n) });
    }
  }
  return {
    board: boardPath,
    pcb_sha256: createHash("sha256").update(text).digest("hex"),
    power_model: { width_reduction_mm: supplierStack(acc)?.power_width_reduction_mm ?? 0 },
    stack: I.stackup(text).map((l) => [l.name, l.kind, l.th, l.er]),
    inner_power: powers,
    pairs,
  };
}

const TERMINAL_KIND = new Set(["J", "L", "F", "Q", "D", "BT", "P", "CN", "USB", "FB"]);
const SUPPLY_PIN = /^(VDD|VCC|VD\d|DVDD|IOVDD|IOVCC|PLLVCC|LVDSVCC|ADC_AVDD|USB_VDD|VREG_IN)/;

/** A supply terminal: an exported power pin, a series/connector part, or an IC supply pin by name. */
export function terminal(p: { ref: string; function?: string | null; type?: string | null }): boolean {
  if (p.type === "power_in" || p.type === "power_out") return true;
  const kind = (p.ref.split("_").pop() ?? "").replace(/\d.*$/, "");
  if (TERMINAL_KIND.has(kind)) return true;
  if (kind === "U" || kind === "IC") return SUPPLY_PIN.test(p.function || "");
  return false;
}

/**
 * Independent published IPC-2152 vacuum-chart fit (ECSS-Q-ST-70-12C D.1.2/D.2): I = .0756 dT^.4375 (1550 A)^(.5 dT^.0301),
 * A in mm^2, solved for dT. A cross-check, not qualification of another board thickness.
 */
export function riseEcss2152Vac(iA: number, wMm: number, tMm: number): number {
  let lo = 1e-6, hi = 1e4;
  for (let k = 0; k < 80; k++) {
    const mid = Math.sqrt(lo * hi);
    const current = 0.0756 * mid ** 0.4375 * (1550 * wMm * tMm) ** (0.5 * mid ** 0.0301);
    if (current < iA) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface PowerRow {
  net: string;
  current_A: number;
  inner_length_mm: number;
  min_width_mm: number;
  copper_mm: number;
  ipc2221_C: number;
  width_reduction_mm: number;
  legacy_ipc2152_fit_C: number;
  ecss_ipc2152_vac_fit_C: number;
  graph: PathCensus;
  terminals: string[];
  drop_mV: number;
  voltage_V: number | null;
  drop_pct: number | null;
  pass: boolean;
}

export interface PowerAudit {
  pass: boolean;
  rows: PowerRow[];
  thermal_gate: string;
  coverage: string;
  pcb_sha256: string;
}

export function auditPower(census: StackCensus, limits: { rise_max_c?: number; drop_max_pct?: number } = {}): PowerAudit {
  const copper: Record<string, number> = {};
  for (const [name, kind, th] of census.stack) if (kind === "copper") copper[name] = th;
  const stack = Object.keys(copper);
  const rows: PowerRow[] = [];
  const isInner = (l: string) => !OUTER.has(l);
  for (const [net, d0] of Object.entries(census.inner_power)) {
    // the etched top width (smaller than the trapezoid's average) when the supplier's etch bound is declared
    const reduction = census.power_model?.width_reduction_mm ?? 0;
    const segments = d0.segments.map((s) => ({ ...s, w: s.w - reduction }));
    if (segments.some((s) => s.w <= 0)) throw new Error("nonpositive finished conductor width");
    const tids = d0.pads.flatMap((p, i) => (terminal(p) ? [i] : []));
    const graph = pathCensus(segments, d0.vias, d0.pads, copper, stack, tids);
    const inner = segments.filter((s) => isInner(s.layer));
    const currents = d0.current_A;
    const candidates = inner.length ? inner : segments;
    if (!candidates.length) throw new Error(`${net}: no tracks to audit`);
    let worst = candidates[0]!;
    let temp = rise2221(currents, worst.w, copper[worst.layer]!, isInner(worst.layer));
    for (const s of candidates.slice(1)) {
      const r = rise2221(currents, s.w, copper[s.layer]!, isInner(s.layer));
      if (r > temp) {
        temp = r;
        worst = s;
      }
    }
    const t = copper[worst.layer]!, w = worst.w;
    temp = rise2221(currents, w, t, isInner(worst.layer));
    const vm = /(\d+)V(\d*)/.exec(net);
    const volts = vm ? Number(`${vm[1]}.${vm[2] || "0"}`) : null;
    const mv = graph.resistance_ohm * currents * 1000;
    const len = pySum(inner.map((s) => mathDist(s.a, s.b)));
    rows.push({
      net,
      current_A: currents,
      inner_length_mm: len,
      min_width_mm: w,
      copper_mm: t,
      ipc2221_C: temp,
      width_reduction_mm: reduction,
      legacy_ipc2152_fit_C: traceRiseC(currents, w, t),
      ecss_ipc2152_vac_fit_C: riseEcss2152Vac(currents, w, t),
      graph,
      terminals: tids.map((i) => `${d0.pads[i]!.ref}.${d0.pads[i]!.pad}`),
      drop_mV: mv,
      voltage_V: volts,
      drop_pct: volts ? mv / (volts * 10) : null,
      pass: !graph.missing_terminals.length && !graph.disconnected_terminal_pairs.length && tids.length >= 2 && temp <= (limits.rise_max_c ?? 20) && (volts === null || mv <= volts * 10 * (limits.drop_max_pct ?? 2)),
    });
  }
  return {
    pass: rows.length > 0 && rows.every((x) => x.pass),
    rows,
    thermal_gate: "IPC-2221 internal, actual copper; full current on every inner segment",
    coverage: "all current-declared inner nets; no minimum segment-length filter; no pour credit",
    pcb_sha256: census.pcb_sha256,
  };
}

/** The `inner_power` review check (the toolkit's custom check `inner-power-complete`, same findings and ids). */
export async function checkInnerPower(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("inner_power", "L3");
  const cfg = ctx.project.cfg.inner_power;
  const acc = ctx.acceptance;
  if (cfg === false || (!cfg && !supplierStack(acc))) {
    r.status = "skipped";
    r.detail = cfg === false ? "turned off (review.inner_power: false)" : "no supplier_stack in the acceptance and review.inner_power not set";
    return r;
  }
  if (!acc) {
    r.status = "error";
    r.detail = "no acceptance.json: the audit needs the declared currents";
    return r;
  }
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist (the netlist check did not run or failed): terminals come from the exported pin types";
    return r;
  }
  const limits = typeof cfg === "object" ? cfg : {};
  let audit: PowerAudit;
  try {
    audit = auditPower(stackCensus(ctx.pcbText, ctx.root, ctx.board, acc, ctx.comps, ctx.project.pcb), limits);
  } catch (e) {
    r.status = "error";
    r.detail = `inner-power audit failed: ${e instanceof Error ? e.message : String(e)}`;
    return r;
  }
  const out = join(ctx.out, "inner-power-complete.json");
  await writeFile(out, JSON.stringify(audit, null, 2) + "\n");
  r.artifacts["audit"] = out;
  for (const d of audit.rows) {
    if (d.pass) continue;
    r.findings.push(
      makeFinding({
        layer: "L3",
        rule: "INNER_POWER",
        severity: "must-fix",
        net: d.net,
        key: d.net,
        claim: `${d.net}: complete inner-power audit fails: ${f(d.ipc2221_C, 1)} C / ${f(d.drop_mV, 1)} mV; ${d.graph.missing_terminals.length} missing and ${d.graph.disconnected_terminal_pairs.length} disconnected terminals`.slice(0, 300),
        evidence: [{ source: out, detail: pyDumps(d) }],
        suggest: "repair current-carrying copper or the explicit model coverage; no skipped terminal is a pass",
      }),
    );
  }
  if (!r.findings.length)
    r.findings.push(makeFinding({ layer: "L3", rule: "INNER_POWER", severity: "note", key: "complete", claim: `All ${audit.rows.length} current-declared inner nets pass complete track/via path coverage, IPC-2221 actual-copper heat and 2% drop` }));
  r.detail = `${audit.rows.length} current-declared inner nets; ${audit.rows.filter((x) => !x.pass).length} fail; IPC-2221 internal <= ${limits.rise_max_c ?? 20} C, drop <= ${limits.drop_max_pct ?? 2} %` + (audit.rows.length && audit.rows[0]!.width_reduction_mm ? `; widths less ${audit.rows[0]!.width_reduction_mm} mm etch` : "");
  return r;
}

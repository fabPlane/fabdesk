/**
 * Via manufacturing bindings: classify every via against exact pad copper, find the ones that need fill and cap.
 *
 * A via whose drill hole meets the copper of an SMD pad (any net) is via-in-pad: solder wicks through an open hole, so it
 * must be filled and copper-capped (IPC-4761 Type VII). Laser microvias always need fill + cap. Other through vias need
 * nothing. Pad copper is exact for rect / roundrect / oval / circle (absolute pad angles, KiCad 9+); custom pads use their
 * primitive extent. `applyViaBindings` writes `(capping yes) (filling yes)` on every via that needs them (an attribute
 * only: no geometry changes).
 */
import { kid, kids, num, parseSexpr, topLevelSpans as sexprTopLevelSpans, type SNode } from "../sexpr";

interface SmdPad {
  ref: string;
  pad: string;
  net: string;
  x: number;
  y: number;
  ang: number;
  w: number;
  h: number;
  shape: string;
  layers: Set<string>;
}

export interface ViaClass {
  uuid: string | null;
  xy: [number, number];
  net: string;
  type: "micro" | "blind" | "through";
  span: string[];
  diameter_mm: number;
  drill_mm: number;
  in_component_lands: string[];
  required_filling: boolean;
  required_copper_capping: boolean;
  native_filling: boolean;
  native_capping: boolean;
  /** Offsets of the via's block in the file text (not part of the bindings file). */
  span_: [number, number];
}

export interface ViaBindings {
  schema: "FLOW_VIA_PROCESS_BINDINGS_V1";
  board: string;
  rule: string;
  counts: { vias: number; through: number; micro: number; via_in_pad: number; require_fill_cap: number; missing_native_before: number; filled_not_required: number };
  bindings: Array<Omit<ViaClass, "span_">>;
}

function smdPads(root: SNode): SmdPad[] {
  const out: SmdPad[] = [];
  for (const fp of kids(root, "footprint")) {
    const tr = kid(fp, "transform");
    let x: number, y: number, rot: number;
    if (tr) {
      const t = kid(tr, "translate");
      [x, y] = [num(t?.[1]), num(t?.[2])];
      rot = kid(tr, "rotate") ? num(kid(tr, "rotate")![1]) : 0;
    } else {
      const at = kid(fp, "at");
      [x, y, rot] = [num(at?.[1]), num(at?.[2]), at && at.length > 3 ? num(at[3]) : 0];
    }
    const ref = kids(fp, "property").find((p) => p[1] === "Reference")?.[2];
    const c = Math.cos(rot * (Math.PI / 180));
    const s = Math.sin(rot * (Math.PI / 180));
    for (const pad of kids(fp, "pad")) {
      if (pad.length < 3 || pad[2] !== "smd") continue;
      const at = kid(pad, "at");
      const px = num(at?.[1]);
      const py = num(at?.[2]);
      const pang = at && at.length > 3 ? num(at[3]) : 0; // absolute pad angle
      const size = kid(pad, "size");
      let w = num(size?.[1]);
      let h = num(size?.[2]);
      const shape = String(pad[3] ?? "rect");
      const prim = kid(pad, "primitives");
      if (prim) {
        const ext: number[] = [];
        for (const g of prim.slice(1)) if (Array.isArray(g)) for (const pts of kids(g, "pts")) for (const q of kids(pts, "xy")) ext.push(Math.abs(num(q[1])), Math.abs(num(q[2])));
        if (ext.length) w = h = Math.max(w, h, 2 * Math.max(...ext));
      }
      const layers = new Set((kid(pad, "layers") ?? []).slice(1).filter((l): l is string => typeof l === "string" && l.endsWith(".Cu")));
      const net = kid(pad, "net");
      out.push({ ref: String(ref ?? ""), pad: String(pad[1]), net: net ? String(net[net.length - 1]) : "", x: x + px * c + py * s, y: y - px * s + py * c, ang: pang, w, h, shape, layers });
    }
  }
  return out;
}

/** Distance test of a circle (via hole) against exact pad copper. */
export function holeMeetsPad(vx: number, vy: number, rad: number, p: Pick<SmdPad, "x" | "y" | "ang" | "w" | "h" | "shape">): boolean {
  const a = p.ang * (Math.PI / 180);
  const dx = vx - p.x;
  const dy = vy - p.y;
  const u = dx * Math.cos(a) - dy * Math.sin(a); // into the pad frame (KiCad y-down, angle counter-clockwise)
  const v = dx * Math.sin(a) + dy * Math.cos(a);
  const hw = p.w / 2;
  const hh = p.h / 2;
  if (p.shape === "circle") return Math.hypot(u, v) <= hw + rad;
  if (p.shape === "oval") {
    const r = Math.min(hw, hh);
    return Math.hypot(Math.max(0, Math.abs(u) - (hw - r)), Math.max(0, Math.abs(v) - (hh - r))) <= r + rad;
  }
  return Math.hypot(Math.max(0, Math.abs(u) - hw), Math.max(0, Math.abs(v) - hh)) <= rad;
}

/** Spans of depth-1 s-expressions starting with `key` (any whitespace after the keyword, so CRLF boards read the same). */
export function topLevelSpans(text: string, key: string): Array<[number, number]> {
  return sexprTopLevelSpans(text, key).map((s): [number, number] => [s.start, s.end]);
}

export function classifyVias(text: string): ViaClass[] {
  const pads = smdPads(parseSexpr(text));
  const out: ViaClass[] = [];
  for (const [s, e] of topLevelSpans(text, "via")) {
    const b = text.slice(s, e);
    const at = /\(at ([-\d.]+) ([-\d.]+)/.exec(b);
    const drill = /\(drill ([-\d.]+)/.exec(b);
    const size = /\(size ([-\d.]+)/.exec(b);
    if (!at || !drill || !size) continue;
    const [x, y] = [Number(at[1]), Number(at[2])];
    const layersBlk = /\(layers[^)]*\)/.exec(b)?.[0] ?? "";
    const layers = [...layersBlk.matchAll(/"([^"]+\.Cu)"/g)].map((m) => m[1]!);
    const type = /\(via\s+micro/.test(b) ? "micro" : /\(via\s+blind/.test(b) ? "blind" : "through";
    const net = /\(net "([^"]*)"\)/.exec(b)?.[1] ?? "";
    const uuid = /\(uuid "([^"]+)"\)/.exec(b)?.[1] ?? null;
    const lset = new Set(layers);
    const hit = pads.filter((p) => [...p.layers].some((l) => lset.has(l)) && holeMeetsPad(x, y, Number(drill[1]) / 2, p));
    const need = type === "micro" || hit.length > 0;
    out.push({
      uuid,
      xy: [x, y],
      net,
      type,
      span: layers,
      diameter_mm: Number(size[1]),
      drill_mm: Number(drill[1]),
      in_component_lands: hit.map((p) => `${p.ref}.${p.pad}`).sort(),
      required_filling: need,
      required_copper_capping: need,
      native_filling: b.includes("(filling yes)"),
      native_capping: b.includes("(capping yes)"),
      span_: [s, e],
    });
  }
  return out;
}

export function viaBindings(boardPath: string, vias: ViaClass[]): { record: ViaBindings; missing: ViaClass[] } {
  const need = vias.filter((v) => v.required_filling);
  const missing = need.filter((v) => !(v.native_filling && v.native_capping));
  const extra = vias.filter((v) => !v.required_filling && (v.native_filling || v.native_capping));
  return {
    missing,
    record: {
      schema: "FLOW_VIA_PROCESS_BINDINGS_V1",
      board: boardPath,
      rule:
        "Via-in-pad (drill hole meets SMD pad copper) and every laser microvia: filled and copper-capped (IPC-4761 Type VII); other through vias: no requirement. Supplier capability not qualified.",
      counts: {
        vias: vias.length,
        through: vias.filter((v) => v.type === "through").length,
        micro: vias.filter((v) => v.type === "micro").length,
        via_in_pad: vias.filter((v) => v.in_component_lands.length).length,
        require_fill_cap: need.length,
        missing_native_before: missing.length,
        filled_not_required: extra.length,
      },
      bindings: need.map(({ span_: _s, ...rest }) => rest),
    },
  };
}

/** The board text with `(capping yes) (filling yes)` set on every via that needs them. */
export function applyViaBindings(text: string, missing: ViaClass[]): string {
  let t = text;
  for (const v of [...missing].sort((a, b) => b.span_[0] - a.span_[0])) {
    const [s, e] = v.span_;
    let b = t.slice(s, e);
    b = b.replace(/\(capping \w+\)\s*|\(filling \w+\)\s*/g, "");
    const eol = b.includes("\r\n") ? "\r\n" : "\n"; // keep a CRLF board CRLF
    b = b.replace(/(\(layers[^)]*\))/, `$1${eol}\t\t(capping yes)${eol}\t\t(filling yes)`);
    t = t.slice(0, s) + b + t.slice(e);
  }
  return t;
}

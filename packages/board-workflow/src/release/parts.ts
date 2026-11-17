/**
 * What a release reads from the board: each footprint with its properties, flags, pads (library orientation) and
 * 3D models. Built over the same s-expression tree as the shared board model (`readBoard`), which keeps only what the
 * acceptance checks need.
 */
import { isFittedPurchasedPart } from "@fabdesk/protocol";
import { kid, kids, num, type SNode } from "../sexpr";

export interface PartPad {
  n: string;
  x: number;
  y: number;
  w: number;
  h: number;
  net: string;
  type: string;
}

export interface BomPart {
  ref: string;
  value: string | null;
  lib: string;
  side: "F" | "B";
  x: number;
  y: number;
  rot: number;
  props: Record<string, string>;
  flags: string[];
  pads: PartPad[];
  models: string[];
}

const mod360 = (r: number) => ((r % 360) + 360) % 360;

export function placement(fp: SNode): { x: number; y: number; rot: number } {
  const tr = kid(fp, "transform");
  if (tr) {
    const t = kid(tr, "translate");
    const rot = kid(tr, "rotate");
    return { x: num(t?.[1]), y: num(t?.[2]), rot: rot ? num(rot[1]) : 0 };
  }
  const at = kid(fp, "at");
  return { x: num(at?.[1]), y: num(at?.[2]), rot: at && at.length > 3 ? num(at[3]) : 0 };
}

export function boardParts(root: SNode): BomPart[] {
  const out: BomPart[] = [];
  for (const fp of kids(root, "footprint")) {
    const props: Record<string, string> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2] ?? "");
    const ref = props["Reference"];
    if (ref === undefined) continue;
    const flags = footprintFlags(fp);
    const { x, y, rot } = placement(fp);
    const layer = String(kid(fp, "layer")?.[1] ?? "F.Cu");
    const side = layer[0] === "B" ? "B" : "F";
    const pads: PartPad[] = [];
    for (const pad of kids(fp, "pad")) {
      const a = kid(pad, "at");
      const sz = kid(pad, "size");
      let py = num(a?.[2]);
      if (side === "B") py = -py; // the board file stores B-side children flipped (y mirrored): back to library orientation
      const net = kid(pad, "net");
      pads.push({
        n: String(pad[1]),
        x: num(a?.[1]),
        y: py,
        w: sz ? num(sz[1]) : 0,
        h: sz ? num(sz[2]) : 0,
        net: net ? String(net[net.length - 1] ?? "") : "",
        type: String(pad[2] ?? ""),
      });
    }
    out.push({
      ref,
      value: props["Value"] ?? null,
      lib: String(fp[1] ?? ""),
      side,
      x,
      y,
      rot: mod360(rot),
      props,
      flags,
      pads,
      models: kids(fp, "model").map((m) => String(m[1])),
    });
  }
  return out;
}

/**
 * The one definition of a fitted part, shared by review coverage and the release (BOM check, BOM gate, JLC handoff).
 * A part is bought and fitted when it is not DNP / exclude_from_bom / board_only, its footprint is not a board feature
 * made with the copper (mounting hole, solder jumper / bridge: `isFittedPurchasedPart`), it has pads, and it is netted
 * or a connector / switch / IC reference (a mechanical-only J/SW/U part is still bought). The assembler places it (a CPL
 * row) unless it is also exclude_from_pos_files (fitted by hand) or copper only (a test pad / solder jumper with nothing
 * to buy, as the BOM check decides it).
 */
export interface FitPart {
  ref: string;
  /** Library id (`Lib:Name`): the review's name for it. */
  footprint?: string;
  /** Library id: the release's name for it. */
  lib?: string;
  flags: readonly string[];
  pads: ReadonlyArray<{ net: string }>;
  /** Footprint properties: a part number there makes it a bought part even on a board-feature footprint name. */
  props?: Readonly<Record<string, string>>;
}

/** Fields that carry an LCSC/JLC code (bomcheck's CODE_KEYS) and the MPN fields bomcheck reads. */
export const LCSC_FIELDS = ["LCSC", "LCSC Part", "LCSC_Part", "JLC", "JLCPCB", "JLC Part", "LCSC Part #"] as const;
const MPN_FIELDS = ["MPN", "Manufacturer_Part_Number", "MPN_ID"] as const;

/** The footprint names a part number (an LCSC code or an MPN): someone means to buy it. */
export function hasPartNumber(props: Readonly<Record<string, string>> | undefined): boolean {
  if (!props) return false;
  return LCSC_FIELDS.some((k) => /^C\d{3,}$/.test((props[k] ?? "").trim())) || MPN_FIELDS.some((k) => (props[k] ?? "").trim().length > 0);
}

export type NotFitted = "dnp" | "exclude_from_bom" | "board_only" | "board_feature" | "no_pads" | "not_netted";

/** Why a part is not bought and fitted, or null when it is. */
export function notFittedReason(p: FitPart): NotFitted | null {
  for (const flag of ["dnp", "exclude_from_bom", "board_only"] as const) if (p.flags.includes(flag)) return flag;
  // a board-feature footprint name (mounting hole, solder jumper) is copper, unless the part names a part number
  // (an SMT standoff on a "MountingHole_..." footprint is still bought and placed)
  if (!isFittedPurchasedPart({ footprint: p.footprint ?? p.lib ?? "", flags: p.flags }) && !hasPartNumber(p.props)) return "board_feature";
  if (!p.pads.length) return "no_pads";
  if (!p.pads.some((q) => q.net && !q.net.startsWith("unconnected-")) && !/^(J|SW|U|IC)/.test(p.ref.split("_").pop() ?? "")) return "not_netted";
  return null;
}

/** A part that is bought and fitted (see `FitPart`): the release's and review coverage's `assembled`. */
export function assembled(p: FitPart): boolean {
  return notFittedReason(p) === null;
}

/** Test pad / solder jumper copper with nothing to buy: TP/JP/SJ, at most 3 SMD pads, no 3D model. The caller checks it has no part number. */
export function copperOnlyShape(p: { ref: string; pads: ReadonlyArray<{ type?: string }>; models: readonly string[] }): boolean {
  return !p.models.length && p.pads.length <= 3 && p.pads.every((q) => q.type === "smd") && /(^|_)(TP|JP|SJ)\d+$/.test(p.ref);
}

/** A fitted part the assembler places from the CPL: not exclude_from_pos_files, and not copper only. */
export function placedPart(p: FitPart, copperOnly: boolean): boolean {
  return assembled(p) && !p.flags.includes("exclude_from_pos_files") && !copperOnly;
}

/** A footprint's inclusion flags: `(attr ...)` tokens, and KiCad 9+'s `(dnp yes)` style nodes (a `no` value is not a flag). */
export function footprintFlags(fp: SNode): string[] {
  const attr = kid(fp, "attr") ?? [];
  const flags = new Set(attr.slice(1).filter((x): x is string => typeof x === "string"));
  for (const k of ["dnp", "exclude_from_bom", "board_only", "exclude_from_pos_files"]) {
    const n = kid(fp, k);
    if (n && n[1] !== "no") flags.add(k);
  }
  return [...flags].sort();
}

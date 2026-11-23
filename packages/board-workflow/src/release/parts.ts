/**
 * What a release reads from the board: each footprint with its properties, flags, pads (library orientation) and
 * 3D models. Built over the same s-expression tree as the shared board model (`readBoard`), which keeps only what the
 * acceptance checks need.
 */
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
    const attr = kid(fp, "attr") ?? [];
    const flags = new Set(attr.slice(1).filter((x): x is string => typeof x === "string"));
    // KiCad 9+ writes these as (dnp yes) / (exclude_from_bom yes) too; a `no` value is not a flag
    for (const k of ["dnp", "exclude_from_bom", "board_only", "exclude_from_pos_files"]) {
      const n = kid(fp, k);
      if (n && n[1] !== "no") flags.add(k);
    }
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
      flags: [...flags].sort(),
      pads,
      models: kids(fp, "model").map((m) => String(m[1])),
    });
  }
  return out;
}

/** A part that is assembled: not DNP / excluded, and either netted or a connector/switch/IC-like reference. */
export function assembled(p: BomPart): boolean {
  if (p.flags.includes("dnp") || p.flags.includes("exclude_from_bom") || p.flags.includes("board_only")) return false;
  const netted = p.pads.some((q) => q.net && !q.net.startsWith("unconnected-"));
  if (!netted && !/^(J|SW|U|IC)/.test(p.ref.split("_").pop()!)) return false;
  return p.pads.length > 0;
}

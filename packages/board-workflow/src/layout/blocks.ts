/**
 * Placement blocks of a board (port of the toolkit's `tools/block_inventory.py`): the `BLOCKS.json` a floorplan names.
 *
 * Each footprint joins its schematic sheet. For `split` sheets, each part joins the anchor IC (U/IC references) it shares
 * the most signal nets with (rails and ground are not evidence); parts sharing none go to the anchor of their sheet with
 * the rarest shared supply (then the nearest), then to the block most of their signal-net neighbours are in, else
 * `<sheet>:unassigned`. Per block: parts, courtyard area per side (sum of courtyard bounding boxes, pad box + 0.25 mm per
 * side when there is none), locked parts, parts taller than 2.3 mm (B only on C6) and parts without a courtyard.
 *
 * `deriveGroups` (spec.ts) is not this: it groups by anchor IC over the whole board with no sheet, for the KRT placer's
 * groups.json. A floorplan is written in blocks (a sheet, or an anchor IC inside a split sheet), so this is kept.
 * C6 values the toolkit hard-coded are options: the anchor pattern (`_(U|IC)\d` after a sheet prefix), the ground net
 * (`IO_GND`), the height screen.
 */
import { pyRound } from "../accept";
import { kid, kids, parseSexpr, type SNode } from "../sexpr";

export interface Block {
  parts: string[];
  area_F: number;
  area_B: number;
  locked: string[];
  tall_B_only: string[];
  no_courtyard: string[];
  /** The anchor's value, or the block name for a sheet block (null when the anchor has no value). */
  label: string | null;
  count: number;
}

export interface BlockOptions {
  /** Sheets (file name without `.kicad_sch`) split by anchor IC. */
  split?: string[];
  /** Height screen entries (`requirements/heights.json` / C6 `component-height-screens.json`). */
  heights?: Array<{ ref: string; height_above_surface_mm?: number | null }>;
  /** Ground net, left out of the supply pass (default the toolkit's `IO_GND`). */
  ground?: string;
  /** Anchor references inside a split sheet, matched at the start (default the toolkit's `.*_(U|IC)\d`). */
  anchor?: RegExp;
}

/** Rails, ground and unconnected pads: not grouping evidence (the toolkit's POWERISH). */
export const POWERISH = /GND|VBUS|5V|3V3|2V5|1V8|1V5|1V1|VAD|SYS$|BAT_CHG|PACK_PLUS|PMID|^unconnected-/;
const f = (x: unknown) => Number(x);

function courtyardBox(fp: SNode): [number, number, boolean] {
  const xs: number[] = [], ys: number[] = [];
  for (const g of fp) {
    if (!Array.isArray(g) || !["fp_line", "fp_rect", "fp_poly", "fp_circle"].includes(g[0] as string)) continue;
    const layer = kid(g, "layer");
    if (!layer || !String(layer[1]).includes("CrtYd")) continue;
    if (g[0] === "fp_circle") {
      const c = kid(g, "center")!, e = kid(g, "end")!;
      const [cx, cy, ex, ey] = [f(c[1]), f(c[2]), f(e[1]), f(e[2])];
      const rr = ((ex - cx) ** 2 + (ey - cy) ** 2) ** 0.5;
      xs.push(cx - rr, cx + rr);
      ys.push(cy - rr, cy + rr);
      continue;
    }
    for (const k of ["start", "end"]) {
      const p = kid(g, k);
      if (p) (xs.push(f(p[1])), ys.push(f(p[2])));
    }
    const pts = kid(g, "pts");
    for (const xy of kids(pts ?? [], "xy")) (xs.push(f(xy[1])), ys.push(f(xy[2])));
  }
  if (xs.length) return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), true];
  for (const pad of kids(fp, "pad")) {
    const at = kid(pad, "at"), size = kid(pad, "size");
    if (at && size) {
      const w = f(size[1]), h = f(size[2]);
      xs.push(f(at[1]) - w / 2, f(at[1]) + w / 2);
      ys.push(f(at[2]) - h / 2, f(at[2]) + h / 2);
    }
  }
  return xs.length ? [Math.max(...xs) - Math.min(...xs) + 0.5, Math.max(...ys) - Math.min(...ys) + 0.5, false] : [1, 1, false];
}

const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

/** `block_inventory.py` on a board text: block name -> block, sorted by name. */
export function blockInventory(text: string, o: BlockOptions = {}): Record<string, Block> {
  const root = parseSexpr(text);
  const split = new Set(o.split ?? []);
  const ground = o.ground ?? "IO_GND";
  const anchorRe = o.anchor ?? /^.*_(U|IC)\d/;
  const heights = new Map((o.heights ?? []).map((e) => [e.ref, e.height_above_surface_mm ?? null]));
  const meta = new Map<string, { sheet: string; value: string | undefined; area: number; courtyard: boolean; locked: boolean }>();
  const pos = new Map<string, { x: number; y: number; layer: string }>();
  const pads: Array<{ ref: string; net: string }> = [];
  for (const fp of kids(root, "footprint")) {
    const props: Record<string, string> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2]);
    const ref = props["Reference"]!;
    const [w, h, hasCy] = courtyardBox(fp);
    const sf = kid(fp, "sheetfile");
    meta.set(ref, {
      sheet: (sf ? String(sf[1]) : "").replace(".kicad_sch", ""),
      value: props["Value"],
      area: pyRound(w * h, 2),
      courtyard: hasCy,
      locked: fp.some((x) => Array.isArray(x) && x[0] === "locked" && x[1] === "yes"),
    });
    const tr = kid(fp, "transform");
    let x: number, y: number;
    if (tr) [x, y] = [f(kid(tr, "translate")![1]), f(kid(tr, "translate")![2])];
    else [x, y] = [f(kid(fp, "at")![1]), f(kid(fp, "at")![2])];
    pos.set(ref, { x, y, layer: String(kid(fp, "layer")?.[1] ?? "F.Cu") });
    for (const pad of kids(fp, "pad")) {
      const net = kid(pad, "net");
      if (net) pads.push({ ref, net: String(net[net.length - 1]) });
    }
  }
  const netsOf = new Map<string, Set<string>>();
  const sig = (r: string) => netsOf.get(r) ?? new Set<string>();
  for (const p of pads) if (!POWERISH.test(p.net)) (netsOf.get(p.ref) ?? netsOf.set(p.ref, new Set()).get(p.ref)!).add(p.net);
  const block = new Map<string, string | null>();
  for (const [ref, m] of meta) {
    block.set(ref, m.sheet);
    if (!split.has(m.sheet)) continue;
    const anchors = [...meta].filter(([r, mm]) => mm.sheet === m.sheet && anchorRe.test(r)).map(([r]) => r);
    if (anchors.includes(ref)) {
      block.set(ref, ref);
      continue;
    }
    let best: string | null = null, bv = -1;
    for (const u of anchors) {
      const v = intersect(sig(ref), sig(u)).length;
      if (v > bv) ((best = u), (bv = v));
    }
    block.set(ref, best !== null && bv > 0 ? best : null);
  }
  const allNets = new Map<string, Set<string>>();
  for (const p of pads) if (p.net !== ground && !p.net.startsWith("unconnected-")) (allNets.get(p.ref) ?? allNets.set(p.ref, new Set()).get(p.ref)!).add(p.net);
  const nets = (r: string) => allNets.get(r) ?? new Set<string>();
  // the toolkit iterates a set here; sorted makes an exact tie (same rounded score, same distance) deterministic
  const anchorsAll = [...new Set([...block.values()].filter((b): b is string => b !== null && meta.has(b)))].sort();
  const holders = new Map<string, number>();
  for (const u of anchorsAll) for (const n of nets(u)) holders.set(n, (holders.get(n) ?? 0) + 1);
  for (const ref of [...block].filter(([, b]) => b === null).map(([r]) => r)) {
    // power-net pass: the rarer shared supply wins, then distance
    let best: string | null = null, bk: [number, number] = [0, 0];
    for (const u of anchorsAll) {
      if (meta.get(u)!.sheet !== meta.get(ref)!.sheet) continue;
      let s = 0;
      for (const n of intersect(nets(ref), nets(u))) s += 1 / holders.get(n)!;
      if (!s) continue;
      const pu = pos.get(u)!, pr = pos.get(ref)!;
      const k: [number, number] = [pyRound(s, 3), -((pu.x - pr.x) ** 2 + (pu.y - pr.y) ** 2)];
      if (best === null || k[0] > bk[0] || (k[0] === bk[0] && k[1] > bk[1])) ((best = u), (bk = k));
    }
    if (best !== null) block.set(ref, best);
  }
  for (const ref of [...block].filter(([, b]) => b === null).map(([r]) => r)) {
    // second hop through neighbours
    const votes = new Map<string, number>();
    for (const oref of meta.keys()) {
      const b = block.get(oref);
      if (oref === ref || !b) continue;
      if (intersect(sig(ref), sig(oref)).length) votes.set(b, (votes.get(b) ?? 0) + 1);
    }
    let best: string | null = null, bv = 0;
    for (const [b, v] of votes) if (v > bv) ((best = b), (bv = v));
    block.set(ref, best ?? meta.get(ref)!.sheet + ":unassigned");
  }
  const blocks = new Map<string, Omit<Block, "label" | "count">>();
  for (const [ref, b0] of block) {
    const b = b0!;
    const B = blocks.get(b) ?? blocks.set(b, { parts: [], area_F: 0, area_B: 0, locked: [], tall_B_only: [], no_courtyard: [] }).get(b)!;
    const side = pos.get(ref)!.layer[0] === "B" ? "area_B" : "area_F";
    const m = meta.get(ref)!;
    B.parts.push(ref);
    B[side] = pyRound(B[side] + m.area, 1);
    if (m.locked) B.locked.push(ref);
    if ((heights.get(ref) ?? 0) > 2.3) B.tall_B_only.push(ref);
    if (!m.courtyard) B.no_courtyard.push(ref);
  }
  const out: Record<string, Block> = {};
  for (const b of [...blocks.keys()].sort()) {
    const v = blocks.get(b)!;
    out[b] = { ...v, label: meta.has(b) ? (meta.get(b)!.value ?? null) : b, count: v.parts.length };
  }
  return out;
}

/** One line per block (the toolkit's print), then the totals. */
export function blockLines(blocks: Record<string, Block>): string[] {
  const lines: string[] = [];
  let F = 0, B = 0;
  for (const [b, v] of Object.entries(blocks)) {
    F += v.area_F;
    B += v.area_B;
    lines.push(`${b.padEnd(32)} ${(v.label ?? "").slice(0, 18).padEnd(18)} n${String(v.count).padStart(3)}  F ${v.area_F.toFixed(1).padStart(6)}  B ${v.area_B.toFixed(1).padStart(6)}  locked ${v.locked.join(",") || "-"}  tall ${v.tall_B_only.join(",") || "-"}`);
  }
  lines.push(`total courtyard area F ${Math.round(F)} B ${Math.round(B)} mm2`);
  return lines;
}

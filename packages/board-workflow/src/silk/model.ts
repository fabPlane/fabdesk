/**
 * The silkscreen model: what the checker and solver need, in mm, without a CAD kernel.
 *
 *  - pad mask openings, untented vias, mask graphics and silk strokes: from KiCad's own Gerber plot of the mask and
 *    silkscreen layers (X2 `%TO.C` component attributes give the owner), so their shapes are exactly what KiCad plots;
 *    the plot is made from a copy of the board with every Reference hidden and the free silk texts removed (labels and
 *    free texts are judged by their boxes, as the Reference text is not an obstacle to itself);
 *  - courtyards, assembly outlines, the board outline, labels and free texts: from the board file, with text extents
 *    from `textbox.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runKicadCli, type KicadCli } from "@fabdesk/kicad";
import { placement } from "../release/parts";
import { parseGerber } from "../release/gerber";
import { kid, kids, num, parseSexpr, type SNode } from "../sexpr";
import { gerberShapes } from "./gerber-shapes";
import { bboxOf, type Poly, type Pt, type Rect } from "./geometry";
import { arcPoints, boxOfPoints, loops, polyArea, shapesOn, strokeWidth, toBoard, type FpPlacement } from "./shapes";
import { plotCopy } from "./textedit";
import { textBoxAt, textSize, uprightStyle } from "./textbox";
import { inside } from "./geometry";

export interface Label {
  visible: boolean;
  layer: string;
  on_silk: boolean;
  height: number;
  stroke: number;
  angle: number;
  box: Rect;
}

export interface Part {
  side: "F" | "B";
  x: number;
  y: number;
  rot: number;
  courtyard: Poly[];
  cbox: Rect;
  body: Rect;
  netted: boolean;
  npads: number;
  attrs: { board_only: boolean; dnp: boolean; no_bom: boolean };
  label: Label;
}

export interface FreeText {
  owner: string;
  uuid: string;
  text: string;
  side: "F" | "B";
  height: number;
  stroke: number;
  angle: number;
  box: Rect;
}

/** A free text that moves like the label of the part it names. */
export interface ExtraItem {
  side: "F" | "B";
  cbox: Rect;
  body: Rect;
  owner: string;
  label_text: string;
  heights: number[];
  stroke: number;
  uuid: string;
  is_text: true;
}

export interface SilkModel {
  parts: Record<string, Part>;
  copper: { F: Array<[string, Poly]>; B: Array<[string, Poly]> };
  silk: { F: Array<[string, Poly]>; B: Array<[string, Poly]> };
  outline: Poly[];
  holes_outline: Poly[];
  texts: FreeText[];
  extra: Record<string, ExtraItem>;
  /** Width and height of a label's text box. */
  textBox: (s: string, h: number, w: number) => [number, number];
  /** Where the shapes came from, for the report. */
  source: { mask_silk: "kicad-gerber"; labels: "board-file"; text_extent: "measured-table" };
}

const atomsOf = (n: SNode | undefined) => (n ? n.slice(1).filter((x): x is string => typeof x === "string") : []);

interface TextProps {
  text: string;
  x: number;
  y: number;
  angle: number;
  h: number;
  t: number;
  hjust: "left" | "center" | "right";
  vjust: "top" | "center" | "bottom";
  mirror: boolean;
  hide: boolean;
  unlocked: boolean;
  layer: string;
}

function readTextProps(n: SNode, text: string): TextProps {
  const at = kid(n, "at");
  const eff = kid(n, "effects");
  const font = eff && kid(eff, "font");
  const size = font && kid(font, "size");
  const th = font && kid(font, "thickness");
  const just = atoms(kid(eff ?? [], "justify"));
  const hideNode = kid(n, "hide") ?? (eff && kid(eff, "hide"));
  const flags = n.filter((i): i is string => typeof i === "string");
  const h = size ? num(size[1], 1) : 1;
  return {
    text,
    x: num(at?.[1]),
    y: num(at?.[2]),
    angle: at && at.length > 3 ? num(at[3]) : 0,
    h,
    t: th ? num(th[1], 0) : 0,
    hjust: just.includes("left") ? "left" : just.includes("right") ? "right" : "center",
    vjust: just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "center",
    mirror: just.includes("mirror"),
    hide: (hideNode !== undefined && hideNode[1] !== "no") || flags.includes("hide"),
    unlocked: kid(n, "unlocked")?.[1] === "yes",
    layer: String(kid(n, "layer")?.[1] ?? ""),
  };
}
const atoms = atomsOf;

const onSilk = (layer: string) => /^[FB]\.Silk(S|screen)$/.test(layer);

function fpBoxFallback(fp: SNode, pl: FpPlacement): Rect | null {
  const pts: Pt[] = [];
  for (const pad of kids(fp, "pad")) {
    const a = kid(pad, "at");
    const sz = kid(pad, "size");
    const [px, py, pang, w, h] = [num(a?.[1]), num(a?.[2]), a && a.length > 3 ? num(a[3]) : 0, num(sz?.[1]), num(sz?.[2])];
    const [cx, cy] = toBoard(pl, px, py);
    const c = Math.cos(pang * (Math.PI / 180));
    const s = Math.sin(pang * (Math.PI / 180));
    for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) pts.push([cx + dx * c + dy * s, cy - dx * s + dy * c]);
  }
  for (const g of fp) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !/^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0])) continue;
    const hw = strokeWidth(g) / 2;
    const add = (x: number, y: number, pad = hw) => {
      const [bx, by] = toBoard(pl, x, y);
      pts.push([bx - pad, by - pad], [bx + pad, by + pad]);
    };
    if (g[0] === "fp_circle") {
      const c = kid(g, "center"), e = kid(g, "end");
      const r = Math.hypot(num(e?.[1]) - num(c?.[1]), num(e?.[2]) - num(c?.[2]));
      add(num(c?.[1]), num(c?.[2]), r + hw);
      continue;
    }
    if (g[0] === "fp_arc") {
      const [s0, m0, e0] = ["start", "mid", "end"].map((k) => [num(kid(g, k)?.[1]), num(kid(g, k)?.[2])] as Pt) as [Pt, Pt, Pt];
      for (const [x, y] of arcPoints(s0, m0, e0)) add(x, y);
      continue;
    }
    for (const k of ["start", "end"]) {
      const n = kid(g, k);
      if (n) add(num(n[1]), num(n[2]));
    }
    for (const pp of kids(g, "pts")) for (const q of kids(pp, "xy")) add(num(q[1]), num(q[2]));
  }
  return pts.length ? boxOfPoints(pts) : null;
}

/** Everything from the board file; the Gerber-derived obstacles are added by `buildSilkModel`. */
export function readSilkParts(root: SNode): { parts: Record<string, Part>; texts: FreeText[]; outline: Poly[]; holes: Poly[] } {
  const parts: Record<string, Part> = {};
  for (const fp of kids(root, "footprint")) {
    const props: Record<string, SNode> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = p;
    const refNode = props["Reference"];
    if (!refNode) continue;
    const ref = String(refNode[2] ?? "");
    const pl = placement(fp);
    const side: "F" | "B" = String(kid(fp, "layer")?.[1] ?? "F.Cu").startsWith("B") ? "B" : "F";
    const crtLayer = side === "B" ? "B.CrtYd" : "F.CrtYd";
    const fabLayer = side === "B" ? "B.Fab" : "F.Fab";
    const pads = kids(fp, "pad");
    let crt = loops(shapesOn(fp, crtLayer, "fp_")).map((l) => l.map(([x, y]) => toBoard(pl, x, y)));
    let cbox: Rect;
    if (crt.length) cbox = boxOfPoints(crt.flat());
    else {
      // no courtyard: the footprint's own extent (pads and graphics); with none, KiCad falls back on its field texts
      const fields = Object.values(props).map((p) => {
        const q = readTextProps(p, String(p[2] ?? ""));
        const [x0, y0, x1, y1] = textBoxAt(q.text, { h: q.h, t: q.t, hjust: q.hjust, vjust: q.vjust, mirror: q.mirror, angle: q.angle });
        const [bx, by] = toBoard(pl, q.x, q.y);
        return [bx + x0, by + y0, bx + x1, by + y1] as Rect;
      });
      cbox = fpBoxFallback(fp, pl) ?? (fields.length ? ([Math.min(...fields.map((f) => f[0])), Math.min(...fields.map((f) => f[1])), Math.max(...fields.map((f) => f[2])), Math.max(...fields.map((f) => f[3]))] as Rect) : [pl.x, pl.y, pl.x, pl.y]);
      crt = [[[cbox[0], cbox[1]], [cbox[2], cbox[1]], [cbox[2], cbox[3]], [cbox[0], cbox[3]]]];
    }
    // body: the assembly outline (Fab graphics) covers the board once the part is mounted; the courtyard adds a placement
    // margin around it. No Fab outline: the courtyard shrunk by its usual 0.25 mm margin.
    const fab = shapesOn(fp, fabLayer, "fp_");
    let body: Rect;
    if (fab.length) {
      const bbs = fab.map((s) => boxOfPoints(s.pts.map(([x, y]) => toBoard(pl, x, y)), s.width / 2));
      const raw: Rect = [Math.min(...bbs.map((b) => b[0])), Math.min(...bbs.map((b) => b[1])), Math.max(...bbs.map((b) => b[2])), Math.max(...bbs.map((b) => b[3]))];
      body = [Math.max(cbox[0], Math.min(cbox[2], raw[0])), Math.max(cbox[1], Math.min(cbox[3], raw[1])), Math.max(cbox[0], Math.min(cbox[2], raw[2])), Math.max(cbox[1], Math.min(cbox[3], raw[3]))];
    } else {
      body = [cbox[0] + 0.25, cbox[1] + 0.25, cbox[2] - 0.25, cbox[3] - 0.25];
      if (body[0] > body[2] || body[1] > body[3]) body = cbox;
    }
    const flags = new Set(fp.filter((i): i is string => typeof i === "string"));
    for (const a of atoms(kid(fp, "attr"))) flags.add(a);
    const flag = (k: string) => flags.has(k) || (kid(fp, k) !== undefined && kid(fp, k)![1] !== "no");
    const tp = readTextProps(refNode, ref);
    const [bx0, by0, bx1, by1] = textBoxAt(ref, ((st) => (tp.unlocked ? st : uprightStyle(st)))({ h: tp.h, t: tp.t, hjust: tp.hjust, vjust: tp.vjust, mirror: tp.mirror, angle: tp.angle }));
    const pos = toBoard(pl, tp.x, tp.y);
    parts[ref] = {
      side,
      x: pl.x,
      y: pl.y,
      rot: pl.rot,
      courtyard: crt,
      cbox,
      body,
      netted: pads.some((p) => String(kid(p, "net")?.slice(-1)[0] ?? "") !== ""),
      npads: pads.length,
      attrs: { board_only: flag("board_only"), dnp: flag("dnp"), no_bom: flag("exclude_from_bom") },
      label: { visible: !tp.hide, layer: tp.layer, on_silk: onSilk(tp.layer), height: tp.h, stroke: tp.t, angle: ((tp.angle % 360) + 360) % 360, box: [pos[0] + bx0, pos[1] + by0, pos[0] + bx1, pos[1] + by1] },
    };
  }
  const texts: FreeText[] = [];
  for (const g of kids(root, "gr_text")) {
    const layer = String(kid(g, "layer")?.[1] ?? "");
    if (!onSilk(layer)) continue;
    const tp = readTextProps(g, String(g[1] ?? ""));
    if (tp.hide) continue;
    const uuid = String(kid(g, "uuid")?.[1] ?? "");
    const [bx0, by0, bx1, by1] = textBoxAt(tp.text, { h: tp.h, t: tp.t, hjust: tp.hjust, vjust: tp.vjust, mirror: tp.mirror, angle: tp.angle });
    texts.push({ owner: `text:${uuid}`, uuid, text: tp.text, side: layer[0] === "B" ? "B" : "F", height: tp.h, stroke: tp.t, angle: ((tp.angle % 360) + 360) % 360, box: [tp.x + bx0, tp.y + by0, tp.x + bx1, tp.y + by1] });
  }
  // board outline: Edge.Cuts of the board and of footprints, chained into loops; nested loops are holes
  const shapes = shapesOn(root, "Edge.Cuts", "gr_");
  for (const fp of kids(root, "footprint")) {
    const pl = placement(fp);
    for (const s of shapesOn(fp, "Edge.Cuts", "fp_")) shapes.push({ ...s, pts: s.pts.map(([x, y]) => toBoard(pl, x, y)) });
  }
  const all = loops(shapes).sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  const outline: Poly[] = [];
  const holes: Poly[] = [];
  for (const l of all) {
    const depth = all.filter((o) => o !== l && Math.abs(polyArea(o)) > Math.abs(polyArea(l)) && inside(l[0]![0], l[0]![1], o)).length;
    (depth % 2 ? holes : outline).push(l);
  }
  return { parts, texts, outline, holes };
}

async function plotShapes(cli: KicadCli, board: string, dir: string, signal?: AbortSignal) {
  await mkdir(dir, { recursive: true });
  await runKicadCli(cli, ["pcb", "export", "gerbers", "--layers", "F.Mask,B.Mask,F.Silkscreen,B.Silkscreen", "--output", dir + "/", board], { ...(signal ? { signal } : {}) });
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(dir);
  const read = async (layer: string) => {
    const n = names.find((x) => new RegExp(`-${layer}\\.\\w+$`).test(x));
    return n ? gerberShapes(parseGerber(await readFile(join(dir, n), "latin1"))) : [];
  };
  return { fMask: await read("F_Mask"), bMask: await read("B_Mask"), fSilk: await read("F_Silkscreen"), bSilk: await read("B_Silkscreen") };
}

export async function buildSilkModel(pcbText: string, opts: { cli: KicadCli; workDir: string; signal?: AbortSignal }): Promise<SilkModel> {
  const root = parseSexpr(pcbText);
  const { parts, texts, outline, holes } = readSilkParts(root);
  const scratch = join(opts.workDir, "plot");
  await mkdir(scratch, { recursive: true });
  const board = join(scratch, "silkplot.kicad_pcb");
  await writeFile(board, plotCopy(pcbText));
  const sh = await plotShapes(opts.cli, board, join(scratch, "gerbers"), opts.signal);
  const m: SilkModel = {
    parts,
    copper: { F: [], B: [] },
    silk: { F: [], B: [] },
    outline,
    holes_outline: holes,
    texts,
    extra: {},
    textBox: (s, h, w) => {
      const z = textSize(s, h, w);
      return [z.w, z.h];
    },
    source: { mask_silk: "kicad-gerber", labels: "board-file", text_extent: "measured-table" },
  };
  const owner = (a: { comp?: string }, fn?: string) => (a.comp && parts[a.comp] ? a.comp : fn?.startsWith("ViaPad") ? "via" : a.comp ? a.comp : "mask-opening");
  for (const [s, mask, silk] of [["F", sh.fMask, sh.fSilk], ["B", sh.bMask, sh.bSilk]] as const) {
    for (const g of mask) m.copper[s].push([owner(g.attrs, g.fn), g.poly]);
    for (const g of silk) m.silk[s].push([g.attrs.comp ?? "board", g.poly]);
  }
  for (const tx of texts) {
    const [x0, y0, x1, y1] = tx.box;
    m.silk[tx.side].push([tx.owner, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
  }
  void bboxOf;
  return m;
}

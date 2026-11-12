/**
 * What changed between two versions of a board, as a picture. OLD and NEW are KiCad board files or project folders.
 * Copper that both share is drawn faint, removed copper red, added copper green; a part that moved gets its old outline red,
 * its new one green and an arrow between them. The page also lists the counts per layer and every moved, added or removed
 * part, so a change can be reviewed by looking. `changePage` is the HTML page; `changeSvg` the same drawing standalone.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoard, type Board, type Segment, type Via } from "../board";
import { kid, kids, num, parseSexpr } from "../sexpr";
import { pyRound } from "../accept";

export type EdgeSeg = [number, number, number, number, "gr_line" | "gr_rect" | "gr_arc"];
type Box = [number, number, number, number];

export interface BoardModel {
  board: Board;
  edge: EdgeSeg[];
  boxes: Map<string, Box>;
}

export interface Moved {
  ref: string;
  from: [number, number, number, string];
  to: [number, number, number, string];
  mm: number;
}

export interface BoardDiff {
  old: string;
  new: string;
  edge: EdgeSeg[];
  seg_same: Segment[];
  seg_add: Segment[];
  seg_del: Segment[];
  via_add: Via[];
  via_del: Via[];
  moved: Moved[];
  added: string[];
  removed: string[];
  box_old: Map<string, Box>;
  box_new: Map<string, Box>;
}

async function boardFile(p: string): Promise<string> {
  if (p.endsWith(".kicad_pcb")) return p;
  const c = (await readdir(p)).filter((n) => n.endsWith(".kicad_pcb")).sort();
  if (!c.length) throw new Error(`no .kicad_pcb in ${p}`);
  return join(p, c[0]!);
}

export function modelOf(text: string): BoardModel {
  const root = parseSexpr(text);
  const board = readBoard(root);
  const edge: EdgeSeg[] = [];
  for (const kind of ["gr_line", "gr_rect", "gr_arc"] as const)
    for (const g of kids(root, kind))
      if (kid(g, "layer")?.[1] === "Edge.Cuts") {
        const st = kid(g, "start"), en = kid(g, "end");
        if (st && en) edge.push([num(st[1]), num(st[2]), num(en[1]), num(en[2]), kind]);
      }
  const boxes = new Map<string, Box>();
  for (const p of board.pads) {
    const b = boxes.get(p.ref) ?? boxes.set(p.ref, [1e9, 1e9, -1e9, -1e9]).get(p.ref)!;
    b[0] = Math.min(b[0], p.x - p.r);
    b[1] = Math.min(b[1], p.y - p.r);
    b[2] = Math.max(b[2], p.x + p.r);
    b[3] = Math.max(b[3], p.y + p.r);
  }
  return { board, edge, boxes };
}

const r3 = (v: number) => pyRound(v, 3);
const keySeg = (s: Segment) => {
  const a = `${r3(s.a[0])},${r3(s.a[1])}`, b = `${r3(s.b[0])},${r3(s.b[1])}`;
  return [s.net, s.layer, r3(s.w), ...[a, b].sort()].join("|");
};
const keyVia = (v: Via) => `${v.net}|${r3(v.x)}|${r3(v.y)}`;

export function diffModels(o: BoardModel, n: BoardModel, names: { old: string; new: string } = { old: "old", new: "new" }): BoardDiff {
  const ksO = new Map(o.board.segments.map((s) => [keySeg(s), s])), ksN = new Map(n.board.segments.map((s) => [keySeg(s), s]));
  const kvO = new Map(o.board.vias.map((v) => [keyVia(v), v])), kvN = new Map(n.board.vias.map((v) => [keyVia(v), v]));
  const moved: Moved[] = [], added: string[] = [], removed: string[] = [];
  const refs = [...new Set([...o.board.footprints.keys(), ...n.board.footprints.keys()])].sort();
  for (const ref of refs) {
    const a = o.board.footprints.get(ref), b = n.board.footprints.get(ref);
    if (!b) removed.push(ref);
    else if (!a) added.push(ref);
    else if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-3 || Math.abs(((a.rot - b.rot) % 360 + 360) % 360) > 1e-3 || a.layer !== b.layer)
      moved.push({ ref, from: [a.x, a.y, a.rot, a.layer], to: [b.x, b.y, b.rot, b.layer], mm: pyRound(Math.hypot(a.x - b.x, a.y - b.y), 2) });
  }
  const only = <T,>(x: Map<string, T>, y: Map<string, T>) => [...x].filter(([k]) => !y.has(k)).map(([, v]) => v);
  return {
    old: names.old,
    new: names.new,
    edge: n.edge.length ? n.edge : o.edge,
    seg_same: [...ksN].filter(([k]) => ksO.has(k)).map(([, v]) => v),
    seg_add: only(ksN, ksO),
    seg_del: only(ksO, ksN),
    via_add: only(kvN, kvO),
    via_del: only(kvO, kvN),
    moved,
    added,
    removed,
    box_old: o.boxes,
    box_new: n.boxes,
  };
}

export async function diffBoards(oldPath: string, newPath: string): Promise<BoardDiff> {
  const [fo, fn] = [await boardFile(oldPath), await boardFile(newPath)];
  return diffModels(modelOf(await readFile(fo, "utf8")), modelOf(await readFile(fn, "utf8")), { old: oldPath, new: newPath });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n3 = (v: number) => v.toFixed(3);

export function changeSvg(d: BoardDiff, layers?: ReadonlySet<string>): string {
  const xs = d.edge.flatMap((e) => [e[0], e[2]]), ys = d.edge.flatMap((e) => [e[1], e[3]]);
  const [lx, ly] = [xs.length ? xs : [0, 100], ys.length ? ys : [0, 100]];
  const x0 = Math.min(...lx) - 2, y0 = Math.min(...ly) - 2, x1 = Math.max(...lx) + 2, y1 = Math.max(...ly) + 2;
  const keep = (s: Segment) => !layers || layers.has(s.layer);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(2)} ${y0.toFixed(2)} ${(x1 - x0).toFixed(2)} ${(y1 - y0).toFixed(2)}" class="board">`];
  for (const e of d.edge) {
    if (e[4] === "gr_rect") out.push(`<rect x="${n3(Math.min(e[0], e[2]))}" y="${n3(Math.min(e[1], e[3]))}" width="${n3(Math.abs(e[2] - e[0]))}" height="${n3(Math.abs(e[3] - e[1]))}" class="edge"/>`);
    else out.push(`<line x1="${n3(e[0])}" y1="${n3(e[1])}" x2="${n3(e[2])}" y2="${n3(e[3])}" class="edge"/>`);
  }
  const segs = (lst: Segment[], cls: string) => {
    for (const s of lst)
      if (keep(s)) {
        const side = s.layer === "B.Cu" ? "b" : s.layer === "F.Cu" ? "f" : "i";
        out.push(`<line x1="${n3(s.a[0])}" y1="${n3(s.a[1])}" x2="${n3(s.b[0])}" y2="${n3(s.b[1])}" stroke-width="${n3(Math.max(s.w, 0.08))}" class="${cls} ${side}"/>`);
      }
  };
  segs(d.seg_same, "same");
  segs(d.seg_del, "del");
  segs(d.seg_add, "add");
  for (const v of d.via_del) out.push(`<circle cx="${n3(v.x)}" cy="${n3(v.y)}" r="${n3(v.size / 2)}" class="vdel"/>`);
  for (const v of d.via_add) out.push(`<circle cx="${n3(v.x)}" cy="${n3(v.y)}" r="${n3(v.size / 2)}" class="vadd"/>`);
  for (const m of d.moved) {
    for (const [which, cls] of [[d.box_old, "pdel"], [d.box_new, "padd"]] as const) {
      const b = which.get(m.ref);
      if (b) out.push(`<rect x="${n3(b[0])}" y="${n3(b[1])}" width="${n3(b[2] - b[0])}" height="${n3(b[3] - b[1])}" class="${cls}"/>`);
    }
    const [fx, fy] = m.from, [tx, ty] = m.to;
    out.push(`<line x1="${n3(fx)}" y1="${n3(fy)}" x2="${n3(tx)}" y2="${n3(ty)}" class="arrow" marker-end="url(#ah)"/>`);
    out.push(`<text x="${n3(tx + 0.4)}" y="${n3(ty - 0.4)}" class="lbl">${esc(m.ref)}</text>`);
  }
  for (const [ref, cls, boxes] of [...d.added.map((r) => [r, "padd", d.box_new] as const), ...d.removed.map((r) => [r, "pdel", d.box_old] as const)]) {
    const b = boxes.get(ref);
    if (b) out.push(`<rect x="${n3(b[0])}" y="${n3(b[1])}" width="${n3(b[2] - b[0])}" height="${n3(b[3] - b[1])}" class="${cls}"/><text x="${n3(b[2] + 0.3)}" y="${n3(b[1])}" class="lbl">${esc(ref)}</text>`);
  }
  out.splice(1, 0, '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="ahead"/></marker></defs>');
  out.push("</svg>");
  return out.join("\n");
}

const LIGHT = { bg: "#f7f7f4", fg: "#1d2422", sameF: "#c9a58c", sameB: "#9fb3cf", sameI: "#b9c4bf", add: "#1f9d55", del: "#d23c3c", edge: "#1d2422" };
const DRAWING_CSS = (c: typeof LIGHT) =>
  `.edge{fill:none;stroke:${c.edge};stroke-width:0.15} line.same{stroke-linecap:round;opacity:.55} line.same.f{stroke:${c.sameF}} line.same.b{stroke:${c.sameB}} line.same.i{stroke:${c.sameI}} line.add{stroke:${c.add};stroke-linecap:round} line.del{stroke:${c.del};stroke-linecap:round;stroke-dasharray:.3 .2} .vadd{fill:${c.add}} .vdel{fill:none;stroke:${c.del};stroke-width:.08} .padd{fill:none;stroke:${c.add};stroke-width:.12} .pdel{fill:none;stroke:${c.del};stroke-width:.12;stroke-dasharray:.4 .25} .arrow{stroke:${c.fg};stroke-width:.1} .ahead{fill:${c.fg}} .lbl{font-size:1.1px;fill:${c.fg}}`;

/** The drawing with its own (light) styles, for viewers and converters that do not load the page. */
export function changeSvgStandalone(d: BoardDiff, layers?: ReadonlySet<string>): string {
  return changeSvg(d, layers).replace('class="board">', `class="board"><style>${DRAWING_CSS(LIGHT)} svg{background:${LIGHT.bg}}</style>`);
}

const PAGE_CSS = `
:root { --bg:#f7f7f4; --fg:#1d2422; --muted:#62706b; --line:#d8dbd5; --same-f:#c9a58c; --same-b:#9fb3cf; --same-i:#b9c4bf; --add:#1f9d55; --del:#d23c3c; --edge:#1d2422; }
@media (prefers-color-scheme: dark) { :root { --bg:#141918; --fg:#e4eae7; --muted:#9aa8a3; --line:#2c3735; --same-f:#6e5646; --same-b:#475a75; --same-i:#4a5450; --add:#4fd389; --del:#ff6b6b; --edge:#c9d2ce; color-scheme:dark; } }
body { background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; margin:0; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:20px; }
h1 { font-size:20px; margin:0 0 4px; } .muted { color:var(--muted); }
.wrap { max-width:1100px; margin:0 auto; display:grid; gap:14px; }
.board { width:100%; height:auto; background:var(--bg); border:1px solid var(--line); border-radius:6px; }
${DRAWING_CSS({ bg: "var(--bg)", fg: "var(--fg)", sameF: "var(--same-f)", sameB: "var(--same-b)", sameI: "var(--same-i)", add: "var(--add)", del: "var(--del)", edge: "var(--edge)" })}
table { border-collapse:collapse; font-size:13px; } td, th { padding:4px 10px; border-bottom:1px solid var(--line); text-align:left; }
.k-add { color:var(--add); font-weight:600; } .k-del { color:var(--del); font-weight:600; }
.scroll { overflow-x:auto; }`;

export function changePage(d: BoardDiff, layers?: ReadonlySet<string>): string {
  const by = new Map<string, [number, number]>();
  for (const s of d.seg_add) (by.get(s.layer) ?? by.set(s.layer, [0, 0]).get(s.layer)!)[0]++;
  for (const s of d.seg_del) (by.get(s.layer) ?? by.set(s.layer, [0, 0]).get(s.layer)!)[1]++;
  const rows = [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, [a, r]]) => `<tr><td>tracks on ${esc(k)}</td><td><span class='k-add'>+${a}</span> / <span class='k-del'>-${r}</span></td><td></td></tr>`);
  rows.push(`<tr><td>vias</td><td><span class='k-add'>+${d.via_add.length}</span> / <span class='k-del'>-${d.via_del.length}</span></td><td></td></tr>`);
  rows.push(`<tr><td>parts moved</td><td>${d.moved.length}</td><td>${esc(d.moved.slice(0, 40).map((m) => `${m.ref} ${m.mm} mm`).join(", "))}</td></tr>`);
  rows.push(`<tr><td>parts added / removed</td><td>${d.added.length} / ${d.removed.length}</td><td>${esc([...d.added, ...d.removed].join(", "))}</td></tr>`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board change</title>
<style>${PAGE_CSS}</style>
<div class="wrap">
<div><h1>Board change</h1><div class="muted">old: ${esc(d.old)}<br>new: ${esc(d.new)}</div></div>
<div class="muted"><span class="k-del">red</span> removed · <span class="k-add">green</span> added · faint copper unchanged (F warm, B blue, inner grey) · arrows: parts that moved</div>
${changeSvg(d, layers)}
<div class="scroll"><table><tr><th>What</th><th>Count</th><th>Detail</th></tr>${rows.join("")}</table></div>
</div>
`;
}

export function changeSummary(d: BoardDiff): string {
  return `tracks +${d.seg_add.length}/-${d.seg_del.length}, vias +${d.via_add.length}/-${d.via_del.length}, parts moved ${d.moved.length}, added ${d.added.length}, removed ${d.removed.length}`;
}

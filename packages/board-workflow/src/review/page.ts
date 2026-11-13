/**
 * One interactive HTML page comparing routed boards, from KiCad's own plots (the toolkit's `tools/board_page.py`).
 *
 * For each board: every copper, fab, courtyard and edge layer is exported with kicad-cli (true geometry, board mm
 * coordinates), gzip+base64 embedded and unpacked in the browser; open connections and DRC errors come from the native
 * DRC report beside the board (`acceptance.drc.json`, what layout scoring writes) or one the caller passes; the score
 * chips (A1 A2 A6 A7 A8) from `score.json` beside it; KiCad 3D renders of both sides are embedded unless turned off.
 * The page pans/zooms, toggles layers, mirrors for a bottom view, and zooms to any open or violation from the lists.
 *
 * The toolkit's layer list is its 8-layer board's (In1..In6); kicad-cli writes nothing for a layer the board lacks, so
 * here the copper layers are the board's own (the toolkit's colours and defaults for the names it lists, a palette for
 * any further inner layer). kicad-cli runs one job at a time, in order.
 */
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { kid, kids, parseSexpr } from "../sexpr";

/** name, colour, default on, opacity: the toolkit's table, in its drawing order (bottom first). */
export const PAGE_LAYERS: ReadonlyArray<readonly [string, string, boolean, number]> = [
  ["Edge.Cuts", "#d8d2a8", true, 1.0],
  ["In1.Cu", "#5d8a6a", false, 0.35],
  ["In6.Cu", "#8a6a9a", false, 0.35],
  ["In4.Cu", "#c9b33a", true, 0.8],
  ["In3.Cu", "#46b5a8", true, 0.8],
  ["In5.Cu", "#b763c9", true, 0.85],
  ["In2.Cu", "#e08a3a", true, 0.85],
  ["B.Cu", "#4b86d6", true, 0.75],
  ["F.Cu", "#d64b4b", true, 0.8],
  ["B.Courtyard", "#7aa6c2", false, 0.9],
  ["F.Courtyard", "#d6a0a0", false, 0.9],
  ["B.Fab", "#8fa9bf", false, 0.9],
  ["F.Fab", "#d9c7a3", false, 0.9],
];
const EXTRA_INNER = ["#7f9c5a", "#5a8f9c", "#9c5a7f", "#9c8a5a", "#6a6ab0", "#b06a6a", "#6ab08a", "#b0a06a"];

/** The page's layers for one board: the toolkit's table restricted to the copper the board has, further inner copper after Edge.Cuts. */
export function pageLayers(boardText: string): Array<readonly [string, string, boolean, number]> {
  const root = parseSexpr(boardText);
  const block = kid(root, "layers");
  const copper = new Set<string>();
  for (const l of block ?? []) if (Array.isArray(l) && typeof l[1] === "string" && /\.Cu$/.test(l[1])) copper.add(l[1]);
  if (!copper.size) return [...PAGE_LAYERS]; // no layer table (a fragment): the toolkit's list as it is
  const known = new Set(PAGE_LAYERS.map((l) => l[0]));
  const extra = [...copper].filter((n) => !known.has(n)).sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0));
  const out = PAGE_LAYERS.filter((l) => !l[0].endsWith(".Cu") || copper.has(l[0]));
  out.splice(1, 0, ...extra.map((n, i) => [n, EXTRA_INNER[i % EXTRA_INNER.length]!, true, 0.8] as const));
  return out;
}

export interface PageOpen {
  net: string;
  a: [number, number];
  b: [number, number];
  d: string;
}
export interface PageViolation {
  t: string;
  p: [number, number];
  d: string;
}

interface DrcItem {
  description: string;
  pos: { x: number; y: number };
}
interface DrcJson {
  unconnected_items?: Array<{ items: DrcItem[]; excluded?: boolean }>;
  violations?: Array<{ type: string; severity?: string; description: string; items: DrcItem[]; excluded?: boolean }>;
}

/** Opens (net, both ends, every item's description) and error-severity violations from a native DRC report (`drc_items`), owner exclusions left out. */
export function drcItems(d: DrcJson): { opens: PageOpen[]; viol: PageViolation[] } {
  const opens: PageOpen[] = [], viol: PageViolation[] = [];
  // items the owner excluded in KiCad are not shown (the workflow's DRC reading: project severity, exclusions dropped)
  for (const u of d.unconnected_items ?? []) {
    const it = u.items;
    if (!it.length || u.excluded) continue;
    const net = /\[([^\]]+)\]/.exec(it[0]!.description);
    opens.push({ net: net ? net[1]! : "?", a: [it[0]!.pos.x, it[0]!.pos.y], b: [it[it.length - 1]!.pos.x, it[it.length - 1]!.pos.y], d: it.map((i) => i.description.replace(/\s+/g, " ")).join(" / ") });
  }
  for (const v of d.violations ?? []) {
    if (v.severity !== "error" || !v.items.length || v.excluded) continue;
    const p = v.items[0]!.pos;
    viol.push({ t: v.type, p: [p.x, p.y], d: [...v.description].slice(0, 160).join("") });
  }
  return { opens, viol };
}

const HEAD = /^[\s\S]*?<svg[^>]*viewBox="([^"]+)"[^>]*>/;

/** A kicad-cli SVG reduced to the page's layer body: no title/desc, black -> currentColor, white -> the hole colour. Returns [viewBox, body]. */
export function svgBody(text: string): [string, string] {
  const m = HEAD.exec(text);
  if (!m) throw new Error("kicad-cli SVG without a viewBox");
  let body = text.slice(m[0].length, text.lastIndexOf("</svg>"));
  body = body.replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/g, "");
  body = body.replaceAll("#000000", "currentColor").replaceAll("#FFFFFF", "var(--hole)");
  return [m[1]!, body];
}

export interface PageLayer {
  n: string;
  c: string;
  on: boolean;
  o: number;
  /** gzip + base64 of the layer's SVG body. */
  z: string;
}

export interface PageBoard {
  label: string;
  path: string;
  vb: string | null;
  layers: PageLayer[];
  r3: Record<string, string>;
  opens: PageOpen[];
  viol: PageViolation[];
  score: Record<string, unknown>;
}

export type KicadRun = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** A board file, or the only/first `.kicad_pcb` of a folder (sorted), like the change picture's OLD/NEW. */
export async function pageBoardFile(p: string): Promise<string> {
  if (p.endsWith(".kicad_pcb")) return p;
  const c = (await readdir(p)).filter((n) => n.endsWith(".kicad_pcb")).sort();
  if (!c.length) throw new Error(`no .kicad_pcb in ${p}`);
  return join(p, c[0]!);
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export interface PageBoardOptions {
  /** kicad-cli, called one job at a time. */
  kicad: KicadRun;
  /** Skip the 3D renders (the toolkit's `--no-3d`). */
  no3d?: boolean;
  /** A native DRC report to read instead of `acceptance.drc.json` beside the board. */
  drc?: string;
  signal?: AbortSignal;
  /** Called after each kicad-cli job (layer name or `3d top`). */
  progress?: (note: string) => void;
}

/** One board's page data: plots of every page layer, 3D renders, opens and DRC errors, score. */
export async function boardPageData(label: string, path: string, o: PageBoardOptions): Promise<PageBoard & { notes: string[] }> {
  const pcb = await pageBoardFile(path);
  const dir = (await stat(path)).isDirectory() ? path : dirname(pcb);
  const tmp = await mkdtemp(join(tmpdir(), "board-page-"));
  const notes: string[] = [];
  try {
    const layers: PageLayer[] = [];
    let vb: string | null = null;
    for (const [name, col, on, op] of pageLayers(await readFile(pcb, "utf8"))) {
      o.signal?.throwIfAborted();
      const out = join(tmp, `${name}.svg`);
      const r = await o.kicad(["pcb", "export", "svg", pcb, "-o", out, "--mode-single", "-l", name, "--page-size-mode", "2", "--exclude-drawing-sheet", "--black-and-white", "--drill-shape-opt", "2"]);
      const text = await readFile(out, "utf8").catch(() => null);
      if (r.exitCode !== 0 || text === null) throw new Error(`kicad-cli could not plot ${name} of ${pcb}: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.exitCode}`}`);
      const [v, body] = svgBody(text);
      vb = v;
      layers.push({ n: name, c: col, on, o: op, z: gzipSync(Buffer.from(body), { level: 9 }).toString("base64") });
      o.progress?.(name);
    }
    const r3: Record<string, string> = {};
    if (!o.no3d)
      for (const side of ["top", "bottom"]) {
        o.signal?.throwIfAborted();
        const out = join(tmp, `${side}.jpg`);
        const r = await o.kicad(["pcb", "render", pcb, "-o", out, "--side", side, "--width", "1400", "--height", "1000", "--quality", "basic", "--background", "opaque"]);
        const img = await readFile(out).catch(() => null);
        if (r.exitCode !== 0 || !img) notes.push(`3D render (${side}) failed: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.exitCode}`}`);
        else r3[side] = `data:image/jpeg;base64,${img.toString("base64")}`;
        o.progress?.(`3d ${side}`);
      }
    const drc = (await readJson(o.drc ?? join(dir, "acceptance.drc.json"))) as DrcJson | null;
    if (!drc) notes.push(`no DRC report (${o.drc ?? join(dir, "acceptance.drc.json")}): opens and DRC errors are not shown`);
    const { opens, viol } = drc ? drcItems(drc) : { opens: [], viol: [] };
    const score = ((await readJson(join(dir, "score.json"))) ?? {}) as Record<string, unknown>;
    return { label, path: dir, vb, layers, r3, opens, viol, score, notes };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The page (the toolkit's template; a doctype and charset added so a file opened from disk reads its UTF-8 text). */
export function boardPageHtml(boards: readonly PageBoard[], title = "Board Viewer", sub = "KiCad plots of each routed candidate, with native DRC opens and errors."): string {
  const data = JSON.stringify(boards.map((b) => ({ label: b.label, path: b.path, vb: b.vb, layers: b.layers, r3: b.r3, opens: b.opens, viol: b.viol, score: b.score }))).replaceAll("</", "<\\/");
  return '<!doctype html><meta charset="utf-8">\n' + PAGE.replaceAll("__TITLE__", esc(title)).replaceAll("__SUB__", esc(sub)).replace("__DATA__", () => data);
}

const PAGE = String.raw`<title>__TITLE__</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: KiCad-style dark canvas filling the screen; one side rail for boards, layers, opens and DRC. */
:root {
  --bg: #0e1214; --panel: #151b1e; --line: #263035; --fg: #d9e1e3; --muted: #8a989d;
  --accent: #e3b34c; --open: #ff4d6d; --viol: #ffa53a; --ok: #6cc28a; --hole: #0e1214;
  --ui: "Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}
html, body { height: 100%; }
[hidden] { display: none !important; }
body { background: var(--bg); color: var(--fg); font: 15px/1.35 var(--ui); overflow: hidden; margin: 0; }
.app { display: grid; grid-template-columns: 330px 1fr; height: 100%; }
aside { background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; display: flex;
  flex-direction: column; gap: 14px; padding-block: 14px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: 14px; }
h1 { font-size: 19px; font-weight: 600; margin: 0; letter-spacing: .01em; text-wrap: balance; }
h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 0 0 6px; }
.sub { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
.tabs { display: flex; flex-direction: column; gap: 4px; }
.tab { all: unset; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; padding: 7px 9px;
  border: 1px solid var(--line); border-radius: 4px; }
.tab:hover { border-color: var(--muted); }
.tab:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tab[aria-selected="true"] { border-color: var(--accent); background: #1d2427; }
.tab b { font-weight: 600; }
.tab .num { font: 600 15px var(--mono); color: var(--open); text-align: right; font-variant-numeric: tabular-nums; }
.tab .num.zero { color: var(--ok); }
.tab .chips { grid-column: 1 / -1; display: flex; gap: 4px; flex-wrap: wrap; }
.chip { font: 11px var(--mono); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); }
.chip.fail { border-color: #6b2b36; color: #ff8fa3; } .chip.pass { border-color: #2f5a3d; color: #9fd8b1; }
.layers { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; }
.layers label { display: flex; align-items: center; gap: 6px; cursor: pointer; font: 13px var(--mono); }
.sw { width: 12px; height: 12px; border-radius: 2px; flex: none; }
.presets { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
button { font: 500 13px var(--ui); color: var(--fg); background: #1d2427; border: 1px solid var(--line);
  border-radius: 3px; padding: 4px 8px; cursor: pointer; }
button:hover { border-color: var(--muted); } button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.list { display: flex; flex-direction: column; max-height: 30vh; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; }
.list button { all: unset; cursor: pointer; padding: 4px 8px; border-bottom: 1px solid var(--line); font: 12px var(--mono); display: flex; gap: 8px; }
.list button:hover, .list button.sel { background: #222b2f; }
.list .k { color: var(--open); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.list.v .k { color: var(--viol); }
.list .x { color: var(--muted); }
main { position: relative; min-width: 0; }
svg#board { width: 100%; height: 100%; display: block; cursor: grab; touch-action: none; background: var(--bg); }
svg#board.drag { cursor: grabbing; }
.hud { position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); right: max(12px, env(safe-area-inset-right, 0px)); display: flex; gap: 4px; }
.info { position: absolute; left: 12px; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); right: max(12px, env(safe-area-inset-right, 0px));
  font: 12px var(--mono); color: var(--fg); background: rgba(14,18,20,.85); padding: 6px 9px; border: 1px solid var(--line); border-radius: 4px; pointer-events: none; }
.r3 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.r3 img { width: 100%; border: 1px solid var(--line); border-radius: 3px; cursor: zoom-in; }
.over { position: absolute; inset: 0; background: rgba(8,10,11,.94); display: flex; align-items: center; justify-content: center; padding: 20px; }
.over img { max-height: 100%; }
.loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font: 14px var(--mono); }
@media (max-width: 760px) { .app { grid-template-columns: 1fr; grid-template-rows: 55% 45%; } aside { order: 2; border-right: 0; border-top: 1px solid var(--line);
  padding-right: max(16px, env(safe-area-inset-right, 0px)); } main { order: 1; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
<div class="app">
<aside>
  <div><h1>__TITLE__</h1><p class="sub">__SUB__</p></div>
  <section><h2>Boards</h2><div class="tabs" id="tabs" role="tablist"></div></section>
  <section><h2>Layers</h2><div class="layers" id="layers"></div>
    <div class="presets"><button id="p-all">All signal</button><button id="p-f">Front</button><button id="p-b">Back</button><button id="p-in">Inner</button><button id="p-fab">Parts</button><button id="flip" aria-pressed="false">View from back</button></div></section>
  <section><h2 id="oh">Open connections</h2><div class="list" id="opens"></div></section>
  <section><h2 id="vh">DRC errors</h2><div class="list v" id="viol"></div></section>
  <section id="r3s"><h2>KiCad 3D render</h2><div class="r3" id="r3"></div></section>
</aside>
<main>
  <svg id="board" xmlns="http://www.w3.org/2000/svg"><g id="flipg"><g id="lay"></g><g id="ov"></g></g></svg>
  <div class="hud"><button id="zin" aria-label="Zoom in">+</button><button id="zout" aria-label="Zoom out">&minus;</button><button id="fit">Fit</button></div>
  <div class="info" id="info">Drag to pan, scroll to zoom. Click an open connection or DRC error in the list to jump to it.</div>
  <div class="loading" id="loading">Unpacking KiCad layers…</div>
</main>
</div>
<script>
const BOARDS = __DATA__;
const $ = id => document.getElementById(id);
const svg = $('board'), lay = $('lay'), ov = $('ov');
let cur = 0, vb = null, home = null, flipped = false;
const vis = {}; // layer visibility persists across boards
const cache = {};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
async function unz(b64) {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(s).text();
}
function setVB(v) { vb = v; svg.setAttribute('viewBox', v.join(' ')); }
function applyFlip() {
  const [x, , w] = home; $('flipg').setAttribute('transform', flipped ? ` + "`translate(${2 * x + w} 0) scale(-1 1)`" + ` : '');
}
function score(b) {
  const s = b.score || {}, sum = s.summary || {};
  const keys = ['A1_connectivity', 'A2_drc', 'A6_stack', 'A7_widths', 'A8_pairs'];
  return keys.filter(k => k in sum).map(k => ` + "`<span class=\"chip ${sum[k] ? 'pass' : 'fail'}\">${k.split('_')[0]}</span>`" + `).join('');
}
function tabs() {
  $('tabs').innerHTML = BOARDS.map((b, i) => {
    const o = (b.score && 'open' in b.score) ? b.score.open : b.opens.length;
    return ` + "`<button class=\"tab\" role=\"tab\" aria-selected=\"${i === cur}\" data-i=\"${i}\"><b>${esc(b.label)}</b><span class=\"num ${o ? '' : 'zero'}\">${o} open</span><span class=\"chips\">${score(b)}</span></button>`" + `;
  }).join('');
  $('tabs').querySelectorAll('.tab').forEach(t => t.onclick = () => show(+t.dataset.i));
}
async function show(i) {
  cur = i; tabs(); const b = BOARDS[i];
  $('loading').hidden = false;
  if (!cache[i]) {
    cache[i] = await Promise.all(b.layers.map(async l => ({...l, svg: await unz(l.z)})));
  }
  lay.innerHTML = cache[i].map(l => ` + "`<g class=\"L\" data-n=\"${l.n}\" style=\"color:${l.c};opacity:${l.o}\" ${(vis[l.n] ?? l.on) ? '' : 'display=\"none\"'}>${l.svg}</g>`" + `).join('');
  home = b.vb.split(' ').map(Number); if (!vb) setVB(home.slice()); applyFlip();
  $('layers').innerHTML = b.layers.map(l => ` + "`<label><input type=\"checkbox\" id=\"ly-${l.n}\" data-n=\"${l.n}\" ${(vis[l.n] ?? l.on) ? 'checked' : ''}><span class=\"sw\" style=\"background:${l.c}\"></span>${l.n}</label>`" + `).join('');
  $('layers').querySelectorAll('input').forEach(c => c.onchange = () => setLayer(c.dataset.n, c.checked));
  drawOverlay(b); lists(b);
  $('r3').innerHTML = Object.entries(b.r3).map(([s, src]) => ` + "`<img src=\"${src}\" alt=\"KiCad 3D render, ${s} side\">`" + `).join('');
  $('r3s').hidden = !Object.keys(b.r3).length;
  $('r3').querySelectorAll('img').forEach(im => im.onclick = () => { const o = document.createElement('div'); o.className = 'over'; o.innerHTML = ` + "`<img src=\"${im.src}\" alt=\"${im.alt}\">`" + `; o.onclick = () => o.remove(); document.querySelector('main').append(o); });
  $('loading').hidden = true;
}
function setLayer(n, on) {
  vis[n] = on; const g = lay.querySelector(` + "`g[data-n=\"${n}\"]`" + `); if (g) on ? g.removeAttribute('display') : g.setAttribute('display', 'none');
  const c = $('ly-' + n); if (c) c.checked = on;
}
function preset(names) { BOARDS[cur].layers.forEach(l => setLayer(l.n, names.includes(l.n) || l.n === 'Edge.Cuts')); }
const copper = () => BOARDS[cur].layers.map(l => l.n).filter(n => /\.Cu$/.test(n));
$('p-all').onclick = () => preset(copper());
$('p-f').onclick = () => preset(['F.Cu', 'F.Courtyard']);
$('p-b').onclick = () => preset(['B.Cu', 'B.Courtyard']);
$('p-in').onclick = () => preset(copper().filter(n => /^In\d+\.Cu$/.test(n)));
$('p-fab').onclick = () => preset(['F.Fab', 'B.Fab', 'F.Courtyard', 'B.Courtyard']);
$('flip').onclick = () => { flipped = !flipped; $('flip').setAttribute('aria-pressed', flipped); applyFlip(); };
const NS = 'http://www.w3.org/2000/svg';
function el(t, a) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }
function drawOverlay(b) {
  ov.innerHTML = '';
  b.viol.forEach((v, i) => { const [x, y] = v.p; const g = el('g', {'data-v': i});
    g.append(el('path', {d: ` + "`M${x - .35},${y - .35}L${x + .35},${y + .35}M${x - .35},${y + .35}L${x + .35},${y - .35}`" + `, stroke: 'var(--viol)', 'stroke-width': .12, fill: 'none'})); ov.append(g); });
  b.opens.forEach((o, i) => { const g = el('g', {'data-o': i});
    g.append(el('line', {x1: o.a[0], y1: o.a[1], x2: o.b[0], y2: o.b[1], stroke: 'var(--bg)', 'stroke-width': .5, opacity: .7, fill: 'none'}));
    g.append(el('line', {x1: o.a[0], y1: o.a[1], x2: o.b[0], y2: o.b[1], stroke: 'var(--open)', 'stroke-width': .22, fill: 'none'}));
    for (const p of [o.a, o.b]) g.append(el('circle', {cx: p[0], cy: p[1], r: .45, fill: 'none', stroke: 'var(--open)', 'stroke-width': .18}));
    ov.append(g); });
}
function lists(b) {
  $('oh').textContent = ` + "`Open connections (${b.opens.length})`" + `;
  $('opens').innerHTML = b.opens.map((o, i) => ` + "`<button data-i=\"${i}\"><span class=\"k\">${esc(o.net)}</span><span class=\"x\">${o.a[0].toFixed(1)},${o.a[1].toFixed(1)}</span></button>`" + `).join('') || '<span class="chip pass" style="margin:6px">none</span>';
  const byType = {}; b.viol.forEach(v => byType[v.t] = (byType[v.t] || 0) + 1);
  $('vh').textContent = ` + "`DRC errors (${b.viol.length}: ${Object.entries(byType).map(([k, n]) => k + ' ' + n).join(', ') || 'none'})`" + `;
  $('viol').innerHTML = b.viol.map((v, i) => ` + "`<button data-i=\"${i}\"><span class=\"k\">${esc(v.t)}</span><span class=\"x\">${v.p[0].toFixed(1)},${v.p[1].toFixed(1)}</span></button>`" + `).join('');
  $('opens').querySelectorAll('button').forEach(e => e.onclick = () => { const o = b.opens[+e.dataset.i]; sel(e); focus([o.a, o.b], o.net + ' — ' + o.d); });
  $('viol').querySelectorAll('button').forEach(e => e.onclick = () => { const v = b.viol[+e.dataset.i]; sel(e); focus([v.p], v.t + ' — ' + v.d); });
}
function sel(e) { document.querySelectorAll('.list .sel').forEach(x => x.classList.remove('sel')); e.classList.add('sel'); }
function focus(pts, text) {
  let xs = pts.map(p => flipped ? 2 * home[0] + home[2] - p[0] : p[0]), ys = pts.map(p => p[1]);
  const pad = 3, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - Math.min(...xs) + 2 * pad, h = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  const r = svg.clientWidth / svg.clientHeight, W = Math.max(w, h * r), H = W / r;
  setVB([x0 + w / 2 - W / 2, y0 + h / 2 - H / 2, W, H]); $('info').textContent = text;
}
function fit() { const r = svg.clientWidth / svg.clientHeight, [x, y, w, h] = home, W = Math.max(w, h * r) * 1.04, H = W / r; setVB([x + w / 2 - W / 2, y + h / 2 - H / 2, W, H]); }
function zoom(f, cx, cy) { const [x, y, w, h] = vb; cx ??= x + w / 2; cy ??= y + h / 2; setVB([cx - (cx - x) * f, cy - (cy - y) * f, w * f, h * f]); }
function pt(e) { const r = svg.getBoundingClientRect(); return [vb[0] + (e.clientX - r.left) / r.width * vb[2], vb[1] + (e.clientY - r.top) / r.height * vb[3]]; }
svg.addEventListener('wheel', e => { e.preventDefault(); const [cx, cy] = pt(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, cx, cy); }, {passive: false});
const ptrs = new Map(); let last = null, pinch = null;
svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e); last = e; svg.classList.add('drag'); });
svg.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) { const [x, y] = pt(e); $('info').textContent = ` + "`x ${x.toFixed(2)} mm   y ${y.toFixed(2)} mm`" + `; return; }
  ptrs.set(e.pointerId, e);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinch) zoom(pinch / d, ...pt({clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2})); pinch = d; return; }
  const r = svg.getBoundingClientRect(); setVB([vb[0] - (e.clientX - last.clientX) / r.width * vb[2], vb[1] - (e.clientY - last.clientY) / r.height * vb[3], vb[2], vb[3]]); last = e;
});
const up = e => { ptrs.delete(e.pointerId); pinch = null; last = [...ptrs.values()][0] || null; if (!ptrs.size) svg.classList.remove('drag'); };
svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
$('zin').onclick = () => zoom(1 / 1.4); $('zout').onclick = () => zoom(1.4); $('fit').onclick = fit;
addEventListener('resize', () => home && fit());
show(0).then(fit);
</script>
`;

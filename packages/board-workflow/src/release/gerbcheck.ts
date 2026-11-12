/**
 * gerbcheck: do the Gerbers show the board? An independent Gerber reader's render against KiCad's own plot.
 *
 * KiCad writes the Gerbers, so comparing them with a KiCad re-plot alone would share KiCad's bugs. Here the Gerbers are
 * read by this package's own RS-274X reader (`gerber.ts`) and drawn to SVG; the native board's same layer is plotted by
 * kicad-cli (SVG, black and white). Both are rasterised by resvg on the same frame (the Edge.Cuts box) at the same DPI,
 * lined up by the best whole-pixel shift (at most a few pixels), thresholded and XOR-ed. Per layer: copper pixels in
 * each, pixels that differ, the share of differing pixels that survive a 1-pixel band (anti-aliasing/rounding at 1/dpi
 * is not geometry) over the union; PASS per layer when that share is under `tol` (default 0.1 %). Every Excellon file is
 * parsed and its holes counted per tool. Read-only on the inputs.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { runKicadCli, rasterizeSvgPixels, type KicadCli } from "@fabdesk/kicad";
import { kid, kids, num, parseSexpr, type SNode } from "../sexpr";
import { gerberToSvg, parseExcellon, parseGerber } from "./gerber";

export const LAYERS: Record<string, string> = {
  F_Cu: "F.Cu",
  B_Cu: "B.Cu",
  F_Mask: "F.Mask",
  B_Mask: "B.Mask",
  F_Silkscreen: "F.SilkS",
  B_Silkscreen: "B.SilkS",
  F_Paste: "F.Paste",
  B_Paste: "B.Paste",
  Edge_Cuts: "Edge.Cuts",
};
for (let i = 1; i <= 30; i++) LAYERS[`In${i}_Cu`] = `In${i}.Cu`;

type Box = { x0: number; y0: number; x1: number; y1: number };

function arcExtremes(g: SNode): Array<[number, number]> {
  const p = (k: string): [number, number] => {
    const n = kid(g, k);
    return [num(n?.[1]), num(n?.[2])];
  };
  const [[x1, y1], [x2, y2], [x3, y3]] = [p("start"), p("mid"), p("end")] as [[number, number], [number, number], [number, number]];
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) return [];
  const ux = ((x1 ** 2 + y1 ** 2) * (y2 - y3) + (x2 ** 2 + y2 ** 2) * (y3 - y1) + (x3 ** 2 + y3 ** 2) * (y1 - y2)) / d;
  const uy = ((x1 ** 2 + y1 ** 2) * (x3 - x2) + (x2 ** 2 + y2 ** 2) * (x1 - x3) + (x3 ** 2 + y3 ** 2) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const T = 2 * Math.PI;
  const mod = (v: number) => ((v % T) + T) % T;
  const ang = (x: number, y: number) => mod(Math.atan2(y - uy, x - ux));
  const [a1, a2, a3] = [ang(x1, y1), ang(x2, y2), ang(x3, y3)];
  const ccw = mod(a2 - a1) < mod(a3 - a1); // does start -> mid -> end run counter-clockwise
  const out: Array<[number, number]> = [];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    const on = ccw ? mod(t - a1) <= mod(a3 - a1) : mod(a1 - t) <= mod(a1 - a3);
    if (on) out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]);
  }
  return out;
}

/** Outline box from the board's own Edge.Cuts graphics (arcs contribute the extremes they pass through). */
export function boardEdge(root: SNode): Box | null {
  const pts: Array<[number, number]> = [];
  for (const g of root) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !/^gr_(line|rect|arc|circle|poly|curve)$/.test(g[0])) continue;
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    for (const k of ["start", "end", "mid", "center"]) {
      const n = kid(g, k);
      if (n) pts.push([num(n[1]), num(n[2])]);
    }
    for (const pp of kids(g, "pts")) for (const q of kids(pp, "xy")) pts.push([num(q[1]), num(q[2])]);
    if (g[0] === "gr_circle") {
      const c = kid(g, "center"), e = kid(g, "end");
      const r = Math.hypot(num(e?.[1]) - num(c?.[1]), num(e?.[2]) - num(c?.[2]));
      pts.push([num(c?.[1]) - r, num(c?.[2]) - r], [num(c?.[1]) + r, num(c?.[2]) + r]);
    }
    if (g[0] === "gr_arc") pts.push(...arcExtremes(g));
  }
  if (!pts.length) return null;
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}

const lum = (rgba: Uint8Array, n: number) => {
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = rgba[i * 4]! < 128 ? 1 : 0; // 1 = drawn
  return m;
};

function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && m[yy * w + xx]) {
            v = 1;
            break;
          }
        }
      }
      o[y * w + x] = v;
    }
  return o;
}

function shifted(m: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  if (!dx && !dy) return m;
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < w) o[y * w + x] = m[sy * w + sx]!;
    }
  }
  return o;
}

function bestShift(g: Uint8Array, k: Uint8Array, w: number, h: number, max: number): [number, number] {
  let best: [number, number] = [0, 0];
  let bv = Infinity;
  // coarse and cheap: count XOR over a row-subsampled window
  for (let dy = -max; dy <= max; dy++)
    for (let dx = -max; dx <= max; dx++) {
      let v = 0;
      for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y += 3) {
        const sy = y - dy;
        for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) if (g[y * w + x] !== k[sy * w + x - dx]) v++;
      }
      if (v < bv) {
        bv = v;
        best = [dx, dy];
      }
    }
  return best;
}

function png(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

export interface LayerCheck {
  gerber_px?: number;
  kicad_px?: number;
  diff_px?: number;
  beyond_1px?: number;
  diff_share?: number;
  shift_px?: [number, number];
  pass?: boolean;
  error?: string;
}

export interface GerbCheckResult {
  gerbers: string;
  pcb: string;
  dpi: number;
  layers: Record<string, LayerCheck>;
  drill: Record<string, { tools: number; holes_or_slots: number }>;
  /** Features the reader could not draw (step-and-repeat, block apertures). */
  unsupported: string[];
  pass: boolean;
}

export interface GerbCheckOptions {
  /** Folder holding the Gerber and drill files. */
  gerbers: string;
  pcb: string;
  /** Output folder for the SVGs, difference pictures and gerbcheck.json. */
  out: string;
  cli: KicadCli;
  dpi?: number;
  tol?: number;
  signal?: AbortSignal;
  onProgress?: (layer: string) => void;
}

export async function gerbCheck(o: GerbCheckOptions): Promise<GerbCheckResult> {
  const dpi = o.dpi ?? 400;
  const tol = o.tol ?? 0.001;
  await mkdir(o.out, { recursive: true });
  const names = (await readdir(o.gerbers)).sort();
  const files = names.filter((n) => !/\.(drl|pdf|gbrjob|json|ipc)$/i.test(n));
  const rx = new RegExp("-(" + Object.keys(LAYERS).sort((a, b) => b.length - a.length).join("|") + ")\\.\\w+$");
  const found: Record<string, string> = {};
  for (const n of files) {
    const m = rx.exec(n);
    if (m) found[m[1]!] = n;
  }
  if (!found["Edge_Cuts"]) throw new Error("no Edge_Cuts gerber");
  const box = boardEdge(parseSexpr(await readFile(o.pcb, "utf8")));
  if (!box) throw new Error(`${o.pcb}: no Edge.Cuts outline`);
  const width = Math.round(((box.x1 - box.x0) * dpi) / 25.4);
  const res: GerbCheckResult = { gerbers: o.gerbers, pcb: o.pcb, dpi, layers: {}, drill: {}, unsupported: [], pass: false };
  for (const [k, name] of Object.entries(found)) {
    if (k === "Edge_Cuts") continue;
    if (o.signal?.aborted) throw new Error("cancelled");
    o.onProgress?.(k);
    const kl = LAYERS[k]!;
    const ksvg = join(o.out, `kicad-${k}.svg`);
    const r = await runKicadCli(
      o.cli,
      ["pcb", "export", "svg", "--check-zones", "--layers", kl, "--mode-single", "--exclude-drawing-sheet", "--page-size-mode", "2", "--black-and-white", "--drill-shape-opt", "0", "--output", ksvg, o.pcb],
      { tolerateExit: true, ...(o.signal ? { signal: o.signal } : {}) },
    );
    if (r.exitCode) {
      res.layers[k] = { error: r.stderr.slice(-300) };
      continue;
    }
    const g = parseGerber(await readFile(join(o.gerbers, name), "latin1"));
    for (const u of g.unsupported) if (!res.unsupported.includes(u)) res.unsupported.push(`${k}: ${u}`);
    const gsvg = gerberToSvg(g, box);
    await writeFile(join(o.out, `gerb-${k}.svg`), gsvg);
    // KiCad's SVG is in board coordinates already; put it on the same frame as the Gerber drawing
    const kText = (await readFile(ksvg, "utf8")).replace(/width="[^"]*" height="[^"]*" viewBox="[^"]*"/, `width="${box.x1 - box.x0}mm" height="${box.y1 - box.y0}mm" viewBox="${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}"`);
    const [gp, kp] = await Promise.all([rasterizeSvgPixels(gsvg, { width }), rasterizeSvgPixels(kText, { width })]);
    const w = Math.min(gp.width, kp.width);
    const h = Math.min(gp.height, kp.height);
    const crop = (p: { rgba: Uint8Array; width: number; height: number }) => {
      if (p.width === w && p.height === h) return lum(p.rgba, w * h);
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = p.rgba[(y * p.width + x) * 4]! < 128 ? 1 : 0;
      return m;
    };
    const G = crop(gp);
    const K0 = crop(kp);
    const [dx, dy] = bestShift(G, K0, w, h, 4);
    const K = shifted(K0, w, h, dx, dy);
    const dG = dilate(G, w, h);
    const dK = dilate(K, w, h);
    let gs = 0, ks = 0, diff = 0, sig = 0, union = 0;
    const img = new Uint8Array(w * h * 3).fill(255);
    for (let i = 0; i < w * h; i++) {
      const a = G[i]!, b = K[i]!;
      gs += a;
      ks += b;
      if (a | b) union++;
      if (a !== b) diff++;
      if ((a && !dK[i]) || (b && !dG[i])) sig++;
      const q = i * 3;
      if (a && b) img[q] = img[q + 1] = img[q + 2] = 60;
      else if (a) (img[q] = 220), (img[q + 1] = 30), (img[q + 2] = 30);
      else if (b) (img[q] = 30), (img[q + 1] = 60), (img[q + 2] = 220);
    }
    await writeFile(join(o.out, `diff-${k}.png`), png(img, w, h));
    const share = union ? sig / union : 0;
    res.layers[k] = { gerber_px: gs, kicad_px: ks, diff_px: diff, beyond_1px: sig, diff_share: Math.round(share * 1e5) / 1e5, shift_px: [dy, dx], pass: share < tol };
  }
  for (const n of names) {
    if (!/\.drl$/i.test(n)) continue;
    const x = parseExcellon(await readFile(join(o.gerbers, n), "latin1"));
    res.drill[n] = { tools: Object.keys(x.tools).length, holes_or_slots: x.holes + x.slots };
  }
  res.pass = Object.keys(res.layers).length > 0 && Object.values(res.layers).every((v) => v.pass);
  await writeFile(join(o.out, "gerbcheck.json"), JSON.stringify(res, null, 1) + "\n");
  return res;
}

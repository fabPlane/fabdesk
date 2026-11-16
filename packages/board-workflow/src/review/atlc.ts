/**
 * Finite-difference transmission-line cross sections through the external `atlc` solver (the toolkit's
 * `review/atlc_section.py`; atlc 4.6.1, GPL, run as a separate program: https://atlc.sourceforge.net/tutorial.html).
 *
 * Input is geometry in mm: `box` [xmin, ymin, xmax, ymax], dielectric bands {y0, y1, er}, optional dielectric polygons
 * {er, points}, and conductor polygons {potential: -1 | 0 | 1, points}. The section is drawn as atlc's bitmap the way the
 * toolkit draws it with Pillow 10.2 (same scan-line polygon fill, same 24-bit BMP bytes, so the bitmap's sha256 equals
 * the toolkit's) and atlc reads it with the same flags, so the impedances equal the toolkit's. Box edges are a distant
 * ground; convergence against the boundary distance and the pixel size is the caller's to check (run two pixel sizes).
 * No board is edited.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SectionSpec {
  box: [number, number, number, number];
  dielectrics?: Array<{ y0: number; y1: number; er: number }>;
  dielectric_polygons?: Array<{ er: number; points: Array<[number, number]> }>;
  conductors: Array<{ potential: -1 | 0 | 1; points: Array<[number, number]> }>;
}

export interface SectionResult {
  pixel_mm: number;
  grid: [number, number];
  seconds: number;
  command: string[];
  metrics: Record<string, number>;
  spec: SectionSpec;
  bitmap_sha256: string;
  solver_sha256: string;
}

/** Python's round(x) (half to even) for the pixel coordinates. */
function pyRound0(x: number): number {
  const fl = Math.floor(x);
  const d = x - fl;
  if (d > 0.5) return fl + 1;
  if (d < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

/** Python's str(float). */
export function pyFloat(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`;
  const a = Math.abs(x);
  if (a >= 1e-4 && a < 1e16) return String(x);
  return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
}

type Rgb = [number, number, number];

/** An RGB canvas with the Pillow drawing primitives the section needs. */
class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: Rgb) {
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  point(x: number, y: number, c: Rgb) {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.px.set(c, (y * this.w + x) * 3);
  }
  /** hline32: inclusive, clipped. */
  hline(x0: number, y: number, x1: number, c: Rgb) {
    if (y < 0 || y >= this.h) return;
    if (x0 < 0) x0 = 0;
    else if (x0 >= this.w) return;
    if (x1 < 0) return;
    if (x1 >= this.w) x1 = this.w - 1;
    for (let x = x0; x <= x1; x++) this.px.set(c, (y * this.w + x) * 3);
  }
  /** line32 for the axis-parallel case (end point excluded). */
  vline(x: number, y0: number, y1: number, c: Rgb) {
    const ys = y1 >= y0 ? 1 : -1;
    for (let i = 0, n = Math.abs(y1 - y0); i < n; i++, y0 += ys) this.point(x, y0, c);
  }
  /** ImagingDrawRectangle, filled. */
  fillRect(x0: number, y0: number, x1: number, y1: number, c: Rgb) {
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (y0 < 0) y0 = 0;
    else if (y0 >= this.h) return;
    if (y1 < 0) return;
    if (y1 > this.h) y1 = this.h;
    for (let y = y0; y <= y1; y++) this.hline(x0, y, x1, c);
  }
  /** ImagingDrawRectangle, 1-pixel outline. */
  outlineRect(x0: number, y0: number, x1: number, y1: number, c: Rgb) {
    if (y0 > y1) [y0, y1] = [y1, y0];
    this.hline(x0, y0, x1, c);
    this.hline(x0, y1, x1, c);
    this.vline(x1, y0 + 1, y1, c);
    this.vline(x0, y0 + 1, y1, c);
  }
  /** ImagingDrawPolygon (filled) through polygon_generic, Pillow 10.2, in 32-bit float like the C code. */
  fillPolygon(xy: Array<[number, number]>, c: Rgb) {
    const fr = Math.fround;
    type Edge = { x0: number; y0: number; xmin: number; ymin: number; xmax: number; ymax: number; dx: number };
    const edges: Edge[] = [];
    const add = (x0: number, y0: number, x1: number, y1: number) => {
      edges.push({
        x0,
        y0,
        xmin: Math.min(x0, x1),
        xmax: Math.max(x0, x1),
        ymin: Math.min(y0, y1),
        ymax: Math.max(y0, y1),
        dx: y0 === y1 ? 0 : fr(fr(x1 - x0) / (y1 - y0)),
      });
    };
    const n = xy.length;
    let i = 0;
    for (; i < n - 1; i++) {
      const [x0, y0] = xy[i]!, [x1, y1] = xy[i + 1]!;
      if (y0 === y1 && i !== 0 && y0 === xy[i - 1]![1]) {
        const last = edges[edges.length - 1]!;
        if (x1 > x0 && x0 > xy[i - 1]![0]) {
          last.xmax = x1;
          continue;
        } else if (x1 < x0 && x0 < xy[i - 1]![0]) {
          last.xmin = x1;
          continue;
        }
      }
      add(x0, y0, x1, y1);
    }
    if (xy[i]![0] !== xy[0]![0] || xy[i]![1] !== xy[0]![1]) add(xy[i]![0], xy[i]![1], xy[0]![0], xy[0]![1]);
    if (!edges.length) return;
    let ymin = this.h - 1, ymax = 0;
    const table: Edge[] = [];
    for (const e of edges) {
      if (ymin > e.ymin) ymin = e.ymin;
      if (ymax < e.ymax) ymax = e.ymax;
      if (e.ymin === e.ymax) {
        this.hline(e.xmin, e.ymin, e.xmax, c);
        continue;
      }
      table.push(e);
    }
    if (ymin < 0) ymin = 0;
    if (ymax > this.h) ymax = this.h;
    const xx = new Float32Array(table.length * 2);
    const at = (e: Edge, y: number) => fr(fr(fr(y - e.y0) * e.dx) + e.x0);
    const roundUp = (f: number) => (f >= 0 ? Math.floor(fr(f + 0.5)) : -Math.floor(Math.abs(f) + 0.5));
    const roundDown = (f: number) => (f >= 0 ? Math.ceil(fr(f - 0.5)) : -Math.ceil(Math.abs(f) - 0.5));
    for (; ymin <= ymax; ymin++) {
      let j = 0;
      for (let k = 0; k < table.length; k++) {
        const cur = table[k]!;
        if (!(ymin >= cur.ymin && ymin <= cur.ymax)) continue;
        xx[j++] = at(cur, ymin);
        if (ymin === cur.ymax && ymin < ymax) {
          xx[j] = xx[j - 1]!;
          j++;
        } else if (cur.dx !== 0 && fr(Math.round(xx[j - 1]!)) === xx[j - 1]) {
          for (let m = 0; m < k; m++) {
            const other = table[m]!;
            if ((cur.dx > 0 && other.dx <= 0) || (cur.dx < 0 && other.dx >= 0)) continue;
            if (((ymin === cur.ymin && ymin === other.ymin) || (ymin === cur.ymax && ymin === other.ymax)) && xx[j - 1] === at(other, ymin)) {
              const offset = ymin === ymax ? -1 : 1;
              const a = at(cur, ymin + offset), b = at(other, ymin + offset);
              if (ymin === cur.ymax) xx[m] = cur.dx > 0 ? Math.max(a, b) + 1 : Math.min(a, b) - 1;
              else xx[m] = cur.dx > 0 ? Math.min(a, b) : Math.max(a, b) + 1;
              break;
            }
          }
        }
      }
      const row = Array.from(xx.subarray(0, j)).sort((p, q) => p - q);
      for (let k = 1; k < j; k += 2) this.hline(roundUp(row[k - 1]!), ymin, roundDown(row[k]!), c);
    }
  }
  /** Pillow's 24-bit BMP (BITMAPINFOHEADER, 96 dpi, bottom-up BGR rows padded to 4 bytes). */
  bmp(): Uint8Array {
    const stride = (this.w * 3 + 3) & ~3;
    const image = stride * this.h;
    const out = new Uint8Array(54 + image);
    const dv = new DataView(out.buffer);
    out[0] = 0x42;
    out[1] = 0x4d;
    dv.setUint32(2, 54 + image, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setUint32(18, this.w, true);
    dv.setUint32(22, this.h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, image, true);
    dv.setUint32(38, 3780, true);
    dv.setUint32(42, 3780, true);
    for (let y = 0; y < this.h; y++) {
      const row = 54 + (this.h - 1 - y) * stride;
      for (let x = 0; x < this.w; x++) {
        const s = (y * this.w + x) * 3;
        out[row + x * 3] = this.px[s + 2]!;
        out[row + x * 3 + 1] = this.px[s + 1]!;
        out[row + x * 3 + 2] = this.px[s]!;
      }
    }
    return out;
  }
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** The atlc bitmap of a section and the dielectric colours it uses (atlc's red +1 V / green 0 V / blue -1 V convention). */
export function sectionBitmap(spec: SectionSpec, pixelMm: number): { bmp: Uint8Array; grid: [number, number]; ers: Array<[string, number]> } {
  const [xmin, ymin, xmax, ymax] = spec.box;
  const nx = pyRound0((xmax - xmin) / pixelMm) + 1, ny = pyRound0((ymax - ymin) / pixelMm) + 1;
  const img = new Canvas(nx, ny, [255, 255, 255]);
  const xy = (p: readonly [number, number]): [number, number] => [pyRound0((p[0] - xmin) / pixelMm), pyRound0((p[1] - ymin) / pixelMm)];
  const ers = new Map<string, number>();
  (spec.dielectrics ?? []).forEach((b, i) => {
    const col: Rgb = [32 + i, 64, 128];
    ers.set(col.map(hex2).join(""), b.er);
    const [x0, y0] = xy([xmin, b.y0]), [x1, y1] = xy([xmax, b.y1]);
    if (x1 < x0 || y1 < y0) throw new Error("dielectric band: y1 must not be below y0");
    img.fillRect(x0, y0, x1, y1, col);
  });
  for (const p of spec.dielectric_polygons ?? []) {
    const col: Rgb = [32 + ers.size, 64, 128];
    ers.set(col.map(hex2).join(""), p.er);
    img.fillPolygon(p.points.map(xy), col);
  }
  // box edges are distant ground
  img.outlineRect(0, 0, nx - 1, ny - 1, [0, 255, 0]);
  const cols: Record<string, Rgb> = { "1": [255, 0, 0], "0": [0, 255, 0], "-1": [0, 0, 255] };
  for (const c of spec.conductors) img.fillPolygon(c.points.map(xy), cols[String(c.potential)]!);
  return { bmp: img.bmp(), grid: [nx, ny], ers: [...ers] };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Solve a section: writes `<out>.bmp`, `<out>.log` and `<out>.json` (the toolkit's record) and returns the record.
 * `atlc` is the solver binary (the board engines' atlc, or one on PATH).
 */
export async function solveSection(spec: SectionSpec, out: string, atlc: string, opts: { pixelMm?: number; cutoff?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SectionResult> {
  const pixelMm = opts.pixelMm ?? 0.004, cutoff = opts.cutoff ?? 1e-5;
  const stem = out.replace(/\.[^./\\]*$/, "");
  await mkdir(dirname(stem), { recursive: true });
  const { bmp, grid, ers } = sectionBitmap(spec, pixelMm);
  const bmpPath = `${stem}.bmp`;
  await writeFile(bmpPath, bmp);
  const cmd = [atlc, "-s", "-S", "-c", pyFloat(cutoff)];
  for (const [col, er] of ers) cmd.push("-d", `${col}=${pyFloat(er)}`);
  cmd.push(bmpPath);
  const t = performance.now();
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? 600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  const [so, se, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const raw = `${so}\n${se}`;
  await writeFile(`${stem}.log`, raw);
  if (code) throw new Error(`atlc exited ${code}: ${raw.trim().slice(-400)}`);
  const metrics: Record<string, number> = {};
  for (const m of raw.matchAll(/\b([A-Za-z_]+)\s*=\s*([-+0-9.eE]+)/g)) if (m[1] !== "VERSION") metrics[m[1]!] = Number(m[2]);
  const result: SectionResult = {
    pixel_mm: pixelMm,
    grid,
    seconds: (performance.now() - t) / 1000,
    command: cmd,
    metrics,
    spec,
    bitmap_sha256: sha256(bmp),
    solver_sha256: sha256(new Uint8Array(await readFile(atlc))),
  };
  await writeFile(`${stem}.json`, JSON.stringify(result, null, 2) + "\n");
  return result;
}

/**
 * A pair above a plane (microstrip; `hfar` adds the second plane for stripline). `width` is the base width; the top is
 * narrowed by the stated etch allowance (JLC's 0.7 mil). Microstrip has air above and optionally the published nominal
 * soldermask (30.48 um over the plane, 15.24 um conformal over the copper, er 3.8).
 */
export function pairSection(p: { width: number; gap: number; thickness: number; hnear: number; hfar?: number | null; er?: number; top_etch?: number; margin?: number; mask?: boolean }): SectionSpec {
  const er = p.er ?? 4.17, topEtch = p.top_etch ?? 0.01778, margin = p.margin ?? 1.2, mask = p.mask ?? false;
  const hfar = p.hfar ?? null;
  const { width, gap, thickness, hnear } = p;
  const topWidth = width - topEtch;
  if (topWidth <= 0) throw new Error("etch removes the whole conductor");
  const y0 = hnear, y1 = hnear + thickness;
  const ymax = y1 + (hfar !== null ? hfar : margin);
  const s: SectionSpec = { box: [-margin, 0, margin, ymax], dielectrics: [], conductors: [] };
  if (hfar !== null) s.dielectrics = [{ y0: 0, y1: ymax, er }];
  else {
    s.dielectrics = [{ y0: 0, y1: y0, er }];
    if (mask) s.dielectrics.push({ y0, y1: y0 + 0.03048, er: 3.8 });
  }
  for (const [sign, cx] of [
    [1, -(gap + width) / 2],
    [-1, (gap + width) / 2],
  ] as Array<[1 | -1, number]>) {
    const poly: Array<[number, number]> = [
      [cx - width / 2, y0],
      [cx + width / 2, y0],
      [cx + topWidth / 2, y1],
      [cx - topWidth / 2, y1],
    ];
    if (mask && hfar === null)
      (s.dielectric_polygons ??= []).push({
        er: 3.8,
        points: [
          [cx - width / 2 - 0.01524, y0],
          [cx + width / 2 + 0.01524, y0],
          [cx + topWidth / 2 + 0.01524, y1 + 0.01524],
          [cx - topWidth / 2 - 0.01524, y1 + 0.01524],
        ],
      });
    s.conductors.push({ potential: sign, points: poly });
  }
  return s;
}

/**
 * An independent RS-274X (Gerber X2) reader for the release checks: apertures and macros, flashes, draws, arcs, regions
 * with their object attributes (`%TO.P,ref,pad%` ground truth for pad positions), and an SVG writer so a layer can be
 * compared with KiCad's own plot. Coordinates are millimetres in the Gerber frame (Y up). Reads what KiCad writes (and
 * the common rest); step-and-repeat and block apertures are not supported and are reported.
 */

export interface Aperture {
  code: number;
  kind: "C" | "R" | "O" | "P" | "macro";
  params: number[];
  macro?: string;
  /** `%TA.AperFunction` in force when the aperture was defined (SMDPad, ViaPad, Conductor ...). */
  fn?: string;
}

export interface ObjAttrs {
  /** `%TO.P`: component reference and pad number. */
  pad?: [string, string];
  net?: string;
  comp?: string;
}

export type Seg = { x: number; y: number } | { x: number; y: number; cx: number; cy: number; cw: boolean };

export type GerberObject =
  | { kind: "flash"; dark: boolean; ap: number; x: number; y: number; attrs: ObjAttrs }
  | { kind: "draw"; dark: boolean; ap: number; a: [number, number]; b: [number, number]; arc?: { cx: number; cy: number; cw: boolean }; attrs: ObjAttrs }
  | { kind: "region"; dark: boolean; start: [number, number]; segs: Seg[]; attrs: ObjAttrs };

export interface GerberFile {
  unit: "mm" | "in";
  apertures: Map<number, Aperture>;
  macros: Map<string, string[]>;
  objects: GerberObject[];
  fileFunction: string | null;
  unsupported: string[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

// ---- macro expressions ($1+$1, 0.5x$2, ...)
function evalExpr(src: string, vars: Map<number, number>): number {
  const s = src.replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    if (peek() === "(") {
      i++;
      const v = add();
      i++; // )
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    if (peek() === "+") {
      i++;
      return num();
    }
    if (peek() === "$") {
      i++;
      let j = i;
      while (j < s.length && /\d/.test(s[j]!)) j++;
      const n = Number(s.slice(i, j));
      i = j;
      return vars.get(n) ?? 0;
    }
    let j = i;
    while (j < s.length && /[\d.]/.test(s[j]!)) j++;
    const v = Number(s.slice(i, j));
    i = j;
    return v;
  };
  const mul = (): number => {
    let v = num();
    while (peek() === "x" || peek() === "X" || peek() === "/") {
      const op = s[i++];
      const r = num();
      v = op === "/" ? v / r : v * r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = mul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  return add();
}

const rot = (x: number, y: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};
const f = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

export type Prim =
  | { t: "circle"; cx: number; cy: number; r: number }
  | { t: "poly"; pts: Array<[number, number]> }
  | { t: "obround"; w: number; h: number };

/** Shapes of one aperture at the origin (mm). */
export function aperturePrims(ap: Aperture, macros: Map<string, string[]>, unit: number): Prim[] {
  const p = ap.params.map((v) => v * unit);
  if (ap.kind === "C") return [{ t: "circle", cx: 0, cy: 0, r: p[0]! / 2 }];
  if (ap.kind === "R") {
    const [w, h] = [p[0]! / 2, p[1]! / 2];
    return [{ t: "poly", pts: [[-w, -h], [w, -h], [w, h], [-w, h]] }];
  }
  if (ap.kind === "O") return [{ t: "obround", w: p[0]!, h: p[1]! }];
  if (ap.kind === "P") {
    const [d, n, r0] = [p[0]!, Math.round(ap.params[1]!), ap.params[2] ?? 0];
    return [{ t: "poly", pts: Array.from({ length: n }, (_, k) => rot(d / 2, 0, r0 + (360 * k) / n)) }];
  }
  const out: Prim[] = [];
  const vars = new Map<number, number>();
  ap.params.forEach((v, i) => vars.set(i + 1, v));
  for (const raw of macros.get(ap.macro ?? "") ?? []) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("0 ") || ln === "0") continue;
    const asg = /^\$(\d+)\s*=(.*)$/.exec(ln);
    if (asg) {
      vars.set(Number(asg[1]), evalExpr(asg[2]!, vars));
      continue;
    }
    const a = ln.split(",").map((t) => evalExpr(t, vars));
    const code = Math.round(a[0]!);
    if (a[1] === 0 && code !== 0) continue; // exposure off (clear inside a macro): not drawn
    const U = unit;
    if (code === 1) {
      const [x, y] = rot(a[3]! * U, a[4]! * U, a[5] ?? 0);
      out.push({ t: "circle", cx: x, cy: y, r: (a[2]! * U) / 2 });
    } else if (code === 4) {
      const n = Math.round(a[2]!);
      const r = a[3 + 2 * (n + 1)] ?? 0;
      const pts: Array<[number, number]> = [];
      for (let k = 0; k <= n; k++) pts.push(rot(a[3 + 2 * k]! * U, a[4 + 2 * k]! * U, r));
      out.push({ t: "poly", pts });
    } else if (code === 5) {
      const n = Math.round(a[2]!);
      const [cx, cy, d, r] = [a[3]! * U, a[4]! * U, a[5]! * U, a[6] ?? 0];
      out.push({ t: "poly", pts: Array.from({ length: n }, (_, k) => rot(cx + (d / 2) * Math.cos((2 * Math.PI * k) / n), cy + (d / 2) * Math.sin((2 * Math.PI * k) / n), r)) });
    } else if (code === 20 || code === 21 || code === 22) {
      let x0: number, y0: number, x1: number, y1: number, w: number, r: number;
      if (code === 20) [w, x0, y0, x1, y1, r] = [a[2]! * U, a[3]! * U, a[4]! * U, a[5]! * U, a[6]! * U, a[7] ?? 0];
      else if (code === 21) {
        const [ww, hh, cx, cy] = [a[2]! * U, a[3]! * U, a[4]! * U, a[5]! * U];
        [w, x0, y0, x1, y1, r] = [hh, cx - ww / 2, cy, cx + ww / 2, cy, a[6] ?? 0];
      } else {
        const [ww, hh, lx, ly] = [a[2]! * U, a[3]! * U, a[4]! * U, a[5]! * U];
        [w, x0, y0, x1, y1, r] = [hh, lx, ly + hh / 2, lx + ww, ly + hh / 2, a[6] ?? 0];
      }
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2);
      out.push({ t: "poly", pts: ([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]] as Array<[number, number]>).map(([x, y]) => rot(x, y, r)) });
    }
  }
  return out;
}

function apertureSvg(ap: Aperture, macros: Map<string, string[]>, unit: number): string {
  return aperturePrims(ap, macros, unit)
    .map((q) => {
      if (q.t === "circle") return `<circle cx="${f(q.cx)}" cy="${f(q.cy)}" r="${f(q.r)}"/>`;
      if (q.t === "poly") return `<polygon points="${q.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`;
      const r = Math.min(q.w, q.h) / 2;
      return `<rect x="${f(-q.w / 2)}" y="${f(-q.h / 2)}" width="${f(q.w)}" height="${f(q.h)}" rx="${f(r)}" ry="${f(r)}"/>`;
    })
    .join("");
}

export function parseGerber(text: string): GerberFile {
  const g: GerberFile = { unit: "mm", apertures: new Map(), macros: new Map(), objects: [], fileFunction: null, unsupported: [], bbox: null };
  let dec = 6;
  let dark = true;
  let cur = 0;
  let mode: "G01" | "G02" | "G03" = "G01";
  let region: { start: [number, number]; segs: Seg[]; dark: boolean; attrs: ObjAttrs } | null = null;
  let x = 0, y = 0;
  const attrs: ObjAttrs = {};
  let apFn: string | undefined;
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const touch = (px: number, py: number) => {
    bb.minX = Math.min(bb.minX, px);
    bb.minY = Math.min(bb.minY, py);
    bb.maxX = Math.max(bb.maxX, px);
    bb.maxY = Math.max(bb.maxY, py);
  };
  const snap = (): ObjAttrs => ({ ...attrs });
  const handleExt = (cmd: string) => {
    let m: RegExpExecArray | null;
    if ((m = /^FSLAX(\d)(\d)Y(\d)(\d)/.exec(cmd))) dec = Number(m[2]);
    else if (cmd.startsWith("MOIN")) g.unit = "in";
    else if (cmd.startsWith("MOMM")) g.unit = "mm";
    else if (cmd.startsWith("LPD")) dark = true;
    else if (cmd.startsWith("LPC")) dark = false;
    else if ((m = /^ADD(\d+)([A-Za-z_.$][\w.$]*)(?:,(.*))?$/s.exec(cmd))) {
      const name = m[2]!;
      const params = m[3] ? m[3].split("X").map(Number) : [];
      const std = name === "C" || name === "R" || name === "O" || name === "P";
      g.apertures.set(Number(m[1]), { code: Number(m[1]), kind: std ? (name as "C") : "macro", params, ...(std ? {} : { macro: name }), ...(apFn ? { fn: apFn } : {}) });
    } else if (/^SR[XY]/.test(cmd) || cmd.startsWith("AB")) g.unsupported.push(cmd.slice(0, 12));
    else if (cmd.startsWith("TA.AperFunction,")) apFn = cmd.slice(16);
    else if (cmd.startsWith("TF.FileFunction,")) g.fileFunction = cmd.slice(16);
    else if (cmd.startsWith("TO.P,")) {
      const p = cmd.slice(5).split(",");
      attrs.pad = [p[0]!, p[1] ?? ""];
    } else if (cmd.startsWith("TO.N,")) attrs.net = cmd.slice(5);
    else if (cmd.startsWith("TO.C,")) attrs.comp = cmd.slice(5);
    else if (cmd === "TD" || cmd === "TD.P" || cmd === "TD.N" || cmd === "TD.C") {
      if (cmd === "TD") {
        delete attrs.pad, delete attrs.net, delete attrs.comp;
        apFn = undefined;
      }
      else if (cmd === "TD.P") delete attrs.pad;
      else if (cmd === "TD.N") delete attrs.net;
      else delete attrs.comp;
    }
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === "%") {
      const j = text.indexOf("%", i + 1);
      const block = text.slice(i + 1, j < 0 ? n : j);
      i = j < 0 ? n : j + 1;
      if (block.startsWith("AM")) {
        const parts = block.split("*").map((s) => s.trim()).filter(Boolean);
        g.macros.set(parts[0]!.slice(2), parts.slice(1));
      } else for (const cmd of block.split("*")) if (cmd.trim()) handleExt(cmd.trim());
      continue;
    }
    if (c === "\n" || c === "\r" || c === " ") {
      i++;
      continue;
    }
    const j = text.indexOf("*", i);
    const cmd = text.slice(i, j < 0 ? n : j).trim();
    i = j < 0 ? n : j + 1;
    if (!cmd || cmd.startsWith("G04")) continue;
    if (cmd.startsWith("M02") || cmd === "M00") break;
    const m = /^(?:G(\d+))?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?(?:D(\d+))?$/.exec(cmd);
    if (!m) continue;
    const gc = m[1] ? Number(m[1]) : null;
    if (gc === 1 || gc === 2 || gc === 3) mode = `G0${gc}` as typeof mode;
    else if (gc === 36) {
      region = { start: [x, y], segs: [], dark, attrs: snap() };
      continue;
    } else if (gc === 37) {
      if (region && region.segs.length) g.objects.push({ kind: "region", dark: region.dark, start: region.start, segs: region.segs, attrs: region.attrs });
      region = null;
      continue;
    }
    const scale = 10 ** -dec * (g.unit === "in" ? 25.4 : 1);
    const nx = m[2] !== undefined ? Number(m[2]) * scale : x;
    const ny = m[3] !== undefined ? Number(m[3]) * scale : y;
    const di = m[4] !== undefined ? Number(m[4]) * scale : 0;
    const dj = m[5] !== undefined ? Number(m[5]) * scale : 0;
    const d = m[6] !== undefined ? Number(m[6]) : null;
    if (d !== null && d >= 10) {
      cur = d;
      continue;
    }
    if (d === null && m[2] === undefined && m[3] === undefined) continue;
    const op = d ?? 1; // an omitted D repeats the last operation; KiCad always writes it
    if (op === 2) {
      if (region) {
        // a move inside a region opens its next contour: close the one drawn so far as its own polygon
        if (region.segs.length) {
          g.objects.push({ kind: "region", dark: region.dark, start: region.start, segs: region.segs, attrs: region.attrs });
          region = { start: [nx, ny], segs: [], dark: region.dark, attrs: region.attrs };
        } else region.start = [nx, ny];
      }
      x = nx;
      y = ny;
    } else if (op === 1) {
      const arc = mode === "G01" ? undefined : { cx: x + di, cy: y + dj, cw: mode === "G02" };
      if (region) region.segs.push(arc ? { x: nx, y: ny, ...arc } : { x: nx, y: ny });
      else {
        g.objects.push({ kind: "draw", dark, ap: cur, a: [x, y], b: [nx, ny], ...(arc ? { arc } : {}), attrs: snap() });
        const ap = g.apertures.get(cur);
        const r = ap && (ap.kind === "C" || ap.kind === "R" || ap.kind === "O") ? (ap.params[0] ?? 0) / 2 : 0;
        touch(x - r, y - r), touch(x + r, y + r), touch(nx - r, ny - r), touch(nx + r, ny + r);
      }
      x = nx;
      y = ny;
    } else if (op === 3) {
      x = nx;
      y = ny;
      if (!region) {
        g.objects.push({ kind: "flash", dark, ap: cur, x, y, attrs: snap() });
        const ap = g.apertures.get(cur);
        const r = ap ? Math.max(...(ap.kind === "macro" ? [1] : ap.params.slice(0, 2).map((v) => v ?? 0))) / 2 : 0;
        touch(x - r, y - r), touch(x + r, y + r);
      }
    }
    if (region) touch(x, y);
  }
  g.bbox = Number.isFinite(bb.minX) ? bb : null;
  return g;
}

/** (ref, pad) -> absolute pad positions (Y up) from X2 pad attributes: flashes, and the box centre of regions. */
export function gerberPads(g: GerberFile): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  const add = (ref: string, pad: string, p: [number, number]) => {
    const k = `${ref}\u0000${pad}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(p);
  };
  for (const o of g.objects) {
    if (!o.attrs.pad) continue;
    const [ref, pad] = o.attrs.pad;
    if (o.kind === "flash") add(ref, pad, [o.x, o.y]);
    else if (o.kind === "region") {
      const xs = [o.start[0], ...o.segs.map((s) => s.x)];
      const ys = [o.start[1], ...o.segs.map((s) => s.y)];
      add(ref, pad, [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
    }
  }
  return out;
}

/**
 * The layer as SVG in board coordinates (mm, Y down, i.e. the Gerber Y flipped), black on white, cut to `box`
 * ({x0,y0,x1,y1} in board coordinates). Clear polarity paints white.
 */
export function gerberToSvg(g: GerberFile, box: { x0: number; y0: number; x1: number; y1: number }): string {
  const unit = g.unit === "in" ? 25.4 : 1;
  const defs: string[] = [];
  for (const ap of g.apertures.values()) defs.push(`<g id="a${ap.code}">${apertureSvg(ap, g.macros, unit)}</g>`);
  const body: string[] = [];
  let run: { ap: number; dark: boolean; d: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    const w = (g.apertures.get(run.ap)?.params[0] ?? 0) * unit;
    body.push(`<path d="${run.d.join("")}" fill="none" stroke="${run.dark ? "#000" : "#fff"}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    run = null;
  };
  const arcPath = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, cw: boolean): string => {
    const r = Math.hypot(ax - cx, ay - cy);
    const ta = Math.atan2(ay - cy, ax - cx);
    const tb = Math.atan2(by - cy, bx - cx);
    let sweep = cw ? ta - tb : tb - ta;
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const full = Math.hypot(ax - bx, ay - by) < 1e-9;
    const sf = cw ? 0 : 1;
    if (full) {
      const mx = 2 * cx - ax, my = 2 * cy - ay;
      return `A${f(r)} ${f(r)} 0 0 ${sf} ${f(mx)} ${f(my)}A${f(r)} ${f(r)} 0 0 ${sf} ${f(bx)} ${f(by)}`;
    }
    return `A${f(r)} ${f(r)} 0 ${sweep > Math.PI ? 1 : 0} ${sf} ${f(bx)} ${f(by)}`;
  };
  for (const o of g.objects) {
    if (o.kind === "draw") {
      if (!run || run.ap !== o.ap || run.dark !== o.dark) {
        flush();
        run = { ap: o.ap, dark: o.dark, d: [] };
      }
      run.d.push(`M${f(o.a[0])} ${f(o.a[1])}` + (o.arc ? arcPath(o.a[0], o.a[1], o.b[0], o.b[1], o.arc.cx, o.arc.cy, o.arc.cw) : `L${f(o.b[0])} ${f(o.b[1])}`));
    } else {
      flush();
      if (o.kind === "flash") body.push(`<use href="#a${o.ap}" x="${f(o.x)}" y="${f(o.y)}" fill="${o.dark ? "#000" : "#fff"}"/>`);
      else {
        let d = `M${f(o.start[0])} ${f(o.start[1])}`;
        let px = o.start[0], py = o.start[1];
        for (const s of o.segs) {
          d += "cx" in s ? arcPath(px, py, s.x, s.y, s.cx, s.cy, s.cw) : `L${f(s.x)} ${f(s.y)}`;
          px = s.x;
          py = s.y;
        }
        body.push(`<path d="${d}Z" fill="${o.dark ? "#000" : "#fff"}"/>`);
      }
    }
  }
  flush();
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  // Gerber Y is up: flip, so that board y = -gerber y
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(w)}mm" height="${f(h)}mm" viewBox="${f(box.x0)} ${f(box.y0)} ${f(w)} ${f(h)}">` +
    `<rect x="${f(box.x0)}" y="${f(box.y0)}" width="${f(w)}" height="${f(h)}" fill="#fff"/>` +
    `<defs>${defs.join("")}</defs><g transform="scale(1,-1)">${body.join("")}</g></svg>`
  );
}

/** Excellon: holes per tool (`T1C0.300` then coordinate lines), slots counted (`G85`) as one. */
export function parseExcellon(text: string): { tools: Record<string, number>; holes: number; slots: number; unit: "mm" | "in" } {
  const tools: Record<string, number> = {};
  let cur = "";
  let holes = 0;
  let slots = 0;
  let unit: "mm" | "in" = "mm";
  for (const ln of text.split(/\r?\n/)) {
    if (/^(METRIC|M71)/.test(ln)) unit = "mm";
    else if (/^(INCH|M72)/.test(ln)) unit = "in";
    let m: RegExpExecArray | null;
    if ((m = /^T(\d+)C([\d.]+)/.exec(ln))) tools[m[1]!] = Number(m[2]);
    else if ((m = /^T(\d+)\s*$/.exec(ln))) cur = m[1]!;
    else if (/^X[-\d.]+Y[-\d.]+G85/.test(ln)) slots++;
    else if (/^X[-\d.]+Y[-\d.]+/.test(ln) && cur) holes++;
  }
  return { tools, holes, slots, unit };
}

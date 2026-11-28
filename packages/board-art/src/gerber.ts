import type { GerberFile, Primitive, ResolvedArtOptions } from "./types";

const SCALE = 1_000_000;

export type GerberAperture =
  | { id: number; kind: "C"; d: number }
  | { id: number; kind: "R"; w: number; h: number }
  | { id: number; kind: "O"; w: number; h: number };

export type GerberOp =
  | { op: "flash"; x: number; y: number; aperture: number }
  | { op: "draw"; x1: number; y1: number; x2: number; y2: number; aperture: number }
  | { op: "region"; points: Array<{ x: number; y: number }> };

export type GerberFormat = { int: number; frac: number };

export type ParsedGerber = {
  comments: string[];
  unit: "mm" | "in" | null;
  polarity: "dark" | "clear" | null;
  /** `%TF.FileFunction,...*%` or KiCad `G04 #@! TF.FileFunction` comment. */
  fileFunction: string | null;
  format: GerberFormat | null;
  apertures: GerberAperture[];
  ops: GerberOp[];
  /** Aperture codes that were not C/R/O (macros, polygons). */
  skippedApertures: number[];
};

export function writeGerberLayer(opts: {
  functionComment: string;
  fileFunction: string;
  primitives: readonly Primitive[];
  polarity?: "dark" | "clear";
}): string {
  const lines: string[] = [
    `G04 ${opts.functionComment}*`,
    "%TF.GenerationSoftware,fabPlane,board-art,0.1*%",
    `%TF.FileFunction,${opts.fileFunction}*%`,
    "%TF.FilePolarity,Positive*%",
    "%FSLAX46Y46*%",
    "%MOMM*%",
    opts.polarity === "clear" ? "%LPC*%" : "%LPD*%",
    "G01*",
  ];
  const apertures = new Map<string, number>();
  const add = (key: string, def: string): number => {
    const existing = apertures.get(key);
    if (existing) return existing;
    const id = 10 + apertures.size;
    apertures.set(key, id);
    lines.push(`%ADD${id}${def}*%`);
    return id;
  };
  const cmds: string[] = [];
  let current = 0;
  const use = (id: number) => {
    if (current !== id) {
      cmds.push(`D${id}*`);
      current = id;
    }
  };
  for (const p of opts.primitives) {
    if (p.kind === "circle") {
      const id = add(`C:${fmt(p.d)}`, `C,${fmt(p.d)}`);
      use(id);
      cmds.push(`${xy(p.x, p.y)}D03*`);
    } else if (p.kind === "line") {
      const id = add(`C:${fmt(p.w)}`, `C,${fmt(p.w)}`);
      use(id);
      cmds.push(`${xy(p.x1, p.y1)}D02*`);
      cmds.push(`${xy(p.x2, p.y2)}D01*`);
    } else {
      const id = add(`R:${fmt(p.w)}x${fmt(p.h)}`, `R,${fmt(p.w)}X${fmt(p.h)}`);
      use(id);
      cmds.push(`${xy(p.x + p.w / 2, p.y + p.h / 2)}D03*`);
    }
  }
  lines.push(...cmds, "M02*");
  return `${lines.join("\n")}\n`;
}

export function outlinePrimitives(o: ResolvedArtOptions, width = 0.15): Primitive[] {
  if (o.outline === "circle") {
    const cx = o.widthMm / 2;
    const cy = o.heightMm / 2;
    const r = Math.min(o.widthMm, o.heightMm) / 2;
    return circlePolyline(cx, cy, r, 72, width);
  }
  if (o.outline === "rounded") {
    const rad = Math.min(o.widthMm, o.heightMm) * 0.08;
    return roundedRectPolyline(o.widthMm, o.heightMm, rad, width);
  }
  return [
    { kind: "line", x1: 0, y1: 0, x2: o.widthMm, y2: 0, w: width },
    { kind: "line", x1: o.widthMm, y1: 0, x2: o.widthMm, y2: o.heightMm, w: width },
    { kind: "line", x1: o.widthMm, y1: o.heightMm, x2: 0, y2: o.heightMm, w: width },
    { kind: "line", x1: 0, y1: o.heightMm, x2: 0, y2: 0, w: width },
  ];
}

export function filledBoardRect(o: ResolvedArtOptions): Primitive[] {
  if (o.outline === "circle") {
    const d = Math.min(o.widthMm, o.heightMm);
    return [{ kind: "circle", x: o.widthMm / 2, y: o.heightMm / 2, d }];
  }
  return [{ kind: "rect", x: 0, y: 0, w: o.widthMm, h: o.heightMm }];
}

export function buildGerberSet(
  o: ResolvedArtOptions,
  art: readonly Primitive[],
): GerberFile[] {
  const files: GerberFile[] = [
    {
      name: "board-Edge_Cuts.gbr",
      body: writeGerberLayer({
        functionComment: "Edge.Cuts",
        fileFunction: "Profile,NP",
        primitives: outlinePrimitives(o),
      }),
    },
  ];
  const copperArt = o.layers.includes("copper");
  const maskArt = o.layers.includes("mask");
  const silkArt = o.layers.includes("silk");
  const copper = copperArt ? art : o.fillCopper ? filledBoardRect(o) : [];
  files.push({
    name: "board-F_Cu.gbr",
    body: writeGerberLayer({
      functionComment: "F.Cu",
      fileFunction: "Copper,L1,Top",
      primitives: copper,
    }),
  });
  files.push({
    name: "board-B_Cu.gbr",
    body: writeGerberLayer({
      functionComment: "B.Cu",
      fileFunction: "Copper,L2,Bot",
      primitives: o.fillCopper && !copperArt ? filledBoardRect(o) : [],
    }),
  });
  files.push({
    name: "board-F_Mask.gbr",
    body: writeGerberLayer({
      functionComment: "F.Mask",
      fileFunction: "Soldermask,Top",
      primitives: maskArt ? art : [],
    }),
  });
  files.push({
    name: "board-B_Mask.gbr",
    body: writeGerberLayer({
      functionComment: "B.Mask",
      fileFunction: "Soldermask,Bot",
      primitives: [],
    }),
  });
  files.push({
    name: "board-F_Silkscreen.gbr",
    body: writeGerberLayer({
      functionComment: "F.SilkS",
      fileFunction: "Legend,Top",
      primitives: silkArt ? art : [],
    }),
  });
  files.push({
    name: "board-B_Silkscreen.gbr",
    body: writeGerberLayer({
      functionComment: "B.SilkS",
      fileFunction: "Legend,Bot",
      primitives: [],
    }),
  });
  return files;
}

/** Parse enough RS-274X to count flashes, draws and apertures, and to recover FileFunction/format. */
export function parseGerber(text: string): ParsedGerber {
  const comments: string[] = [];
  const apertures: GerberAperture[] = [];
  const skippedApertures: number[] = [];
  const ops: GerberOp[] = [];
  let unit: ParsedGerber["unit"] = null;
  let polarity: ParsedGerber["polarity"] = null;
  let fileFunction: string | null = null;
  let format: GerberFormat | null = null;
  let current = 0;
  let x = 0;
  let y = 0;
  let px = 0;
  let py = 0;
  let region = false;
  let regionPts: Array<{ x: number; y: number }> = [];
  const digits = { int: 4, frac: 6 };

  const applyCoord = (token: string) => {
    const xm = /X(-?\d+(?:\.\d+)?)/.exec(token);
    const ym = /Y(-?\d+(?:\.\d+)?)/.exec(token);
    if (xm) x = parseCoord(xm[1] ?? "0", digits);
    if (ym) y = parseCoord(ym[1] ?? "0", digits);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("G04")) {
      const comment = line.replace(/^G04\s*/, "").replace(/\*$/, "").trim();
      comments.push(comment);
      const tf = /TF\.FileFunction,([^*%]+)/.exec(comment);
      if (tf) fileFunction = (tf[1] ?? "").trim();
      continue;
    }
    const fileFn = /%TF\.FileFunction,([^*%]+)\*%/.exec(line);
    if (fileFn) fileFunction = (fileFn[1] ?? "").trim();
    if (line.startsWith("%MOMM")) unit = "mm";
    if (line.startsWith("%MOIN")) unit = "in";
    if (line.startsWith("%LPD")) polarity = "dark";
    if (line.startsWith("%LPC")) polarity = "clear";
    const fs = /%FSLAX(\d)(\d)Y/.exec(line);
    if (fs) {
      digits.int = Number(fs[1]);
      digits.frac = Number(fs[2]);
      format = { int: digits.int, frac: digits.frac };
    }
    const add = /%ADD(\d+)([A-Z]+)(?:,([0-9.]+)(?:X([0-9.]+))?)?/.exec(line);
    if (add) {
      const id = Number(add[1]);
      const kind = add[2] ?? "";
      if (kind === "C") apertures.push({ id, kind: "C", d: Number(add[3]) });
      else if (kind === "R") apertures.push({ id, kind: "R", w: Number(add[3]), h: Number(add[4] ?? add[3]) });
      else if (kind === "O") apertures.push({ id, kind: "O", w: Number(add[3]), h: Number(add[4] ?? add[3]) });
      else skippedApertures.push(id);
      continue;
    }
    if (line.includes("G36")) {
      region = true;
      regionPts = [];
      continue;
    }
    if (line.includes("G37")) {
      if (regionPts.length) ops.push({ op: "region", points: regionPts });
      region = false;
      regionPts = [];
      continue;
    }
    const dSel = /(?:^|[^*])D(\d+)\*$/.exec(line) ?? /^D(\d+)\*$/.exec(line);
    if (dSel && Number(dSel[1]) >= 10 && !/[XY]/.test(line)) {
      current = Number(dSel[1]);
      continue;
    }
    const opm = /(D0[123])\*$/.exec(line);
    if (!opm) continue;
    applyCoord(line);
    const code = opm[1];
    if (region) {
      regionPts.push({ x, y });
      px = x;
      py = y;
      continue;
    }
    if (code === "D03") ops.push({ op: "flash", x, y, aperture: current });
    else if (code === "D01") ops.push({ op: "draw", x1: px, y1: py, x2: x, y2: y, aperture: current });
    px = x;
    py = y;
  }
  return { comments, unit, polarity, fileFunction, format, apertures, ops, skippedApertures };
}

function parseCoord(raw: string, digits: { int: number; frac: number }): number {
  const neg = raw.startsWith("-");
  const digitsOnly = neg ? raw.slice(1) : raw;
  if (digitsOnly.includes(".")) {
    const n = Number(digitsOnly);
    return neg ? -n : n;
  }
  const n = Number(digitsOnly) / 10 ** digits.frac;
  return neg ? -n : n;
}

function xy(x: number, y: number): string {
  return `X${coord(x)}Y${coord(y)}`;
}

function coord(n: number): string {
  return Math.round(n * SCALE).toString();
}

function fmt(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

function circlePolyline(cx: number, cy: number, r: number, steps: number, w: number): Primitive[] {
  const out: Primitive[] = [];
  let px = cx + r;
  let py = cy;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    out.push({ kind: "line", x1: px, y1: py, x2: x, y2: y, w });
    px = x;
    py = y;
  }
  return out;
}

function roundedRectPolyline(width: number, height: number, r: number, w: number): Primitive[] {
  const rad = Math.min(r, width / 2, height / 2);
  const pts: Array<[number, number]> = [];
  const corner = (cx: number, cy: number, a0: number, a1: number) => {
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
  };
  corner(width - rad, rad, -Math.PI / 2, 0);
  corner(width - rad, height - rad, 0, Math.PI / 2);
  corner(rad, height - rad, Math.PI / 2, Math.PI);
  corner(rad, rad, Math.PI, (3 * Math.PI) / 2);
  const out: Primitive[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push({ kind: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w });
  }
  return out;
}

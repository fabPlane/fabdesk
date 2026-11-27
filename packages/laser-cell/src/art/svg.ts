/**
 * SVG → ArtGeometry: a small XML reader, the CSS cascade for paint, the SVG viewport and units model, and
 * every path command flattened to the chord tolerance in final millimetres.
 *
 * Filled shapes are resolved per element with that element's fill rule, then unioned: on a laser every fill
 * is "marked", whatever its colour, so overlapping fills merge (a white shape on top does not knock out the
 * one below). Shapes with a stroke but no fill become lines; stroke width is ignored.
 */
import type { ArtGeometry, Vec } from "./index";
import {
  ArtImportError,
  IDENTITY,
  PointBudget,
  apply,
  arcSteps,
  count,
  finish,
  flattenCubic,
  flattenQuad,
  maxScale,
  mul,
  rotate,
  scale,
  toleranceOf,
  translate,
  type FillGroup,
  type Mat,
} from "./geometry";

const SVG_NS = "http://www.w3.org/2000/svg";
/** mm per CSS px: SVG user units default to px at 96 per inch. */
const PX_MM = 25.4 / 96;
/** CSS units in px. */
const UNIT_PX: Record<string, number> = { "": 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, q: 96 / 101.6, in: 96, pt: 96 / 72, pc: 16, em: 16, ex: 8 };
const MAX_DEPTH = 256;

// ---------------------------------------------------------------- XML

type El = { name: string; attrs: Map<string, string>; children: El[]; text: string };

const XML_ENTITIES: Array<[string, string]> = [["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", '"'], ["apos", "'"]];
const NAME_RE = /[A-Za-z_:][\w.:-]*/y;
const ATTR_RE = /[^\s=/>]+/y;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * A small non-validating XML reader: elements, attributes, text and CDATA. Comments, processing
 * instructions and the DOCTYPE are skipped, but internal ENTITY declarations are kept because Illustrator
 * writes `xmlns="&ns_svg;"`. Entities are expanded once (never recursively).
 */
function parseXml(src: string): El {
  const entities = new Map(XML_ENTITIES);
  const err = (msg: string, at: number) => new ArtImportError(`not a valid SVG file: ${msg} (line ${src.slice(0, at).split("\n").length})`);
  const decode = (s: string) =>
    s.indexOf("&") < 0
      ? s
      : s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (whole, ref: string) => {
          if (ref[0] !== "#") return entities.get(ref) ?? whole;
          const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        });
  const stack: El[] = [];
  let root: El | undefined;
  const text = (s: string, at: number) => {
    const top = stack.at(-1);
    if (top) top.text += s;
    else if (s.trim()) throw err(root ? "text after the end of the document" : "this is not XML", at);
  };

  const doctype = (lt: number): number => {
    let j = lt + 2, depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '"' || c === "'") {
        const end = src.indexOf(c, j + 1);
        if (end < 0) break;
        j = end;
      } else if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) {
        for (const m of src.slice(lt, j).matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')/g)) {
          entities.set(m[1]!, m[2] ?? m[3] ?? "");
        }
        return j + 1;
      }
    }
    throw err("a <!DOCTYPE> is never closed", lt);
  };

  const openTag = (lt: number): number => {
    NAME_RE.lastIndex = lt + 1;
    const name = NAME_RE.exec(src)?.[0];
    if (!name) throw err("unexpected '<'", lt);
    const el: El = { name, attrs: new Map(), children: [], text: "" };
    let j = NAME_RE.lastIndex;
    for (;;) {
      while (j < src.length && isSpace(src.charCodeAt(j))) j++;
      const c = src[j];
      if (c === undefined) throw err(`<${name}> is never finished`, lt);
      const selfClosing = c === "/" && src[j + 1] === ">";
      if (c === ">" || selfClosing) {
        const parent = stack.at(-1);
        if (parent) parent.children.push(el);
        else if (root) throw err("more than one root element", lt);
        else root = el;
        if (!selfClosing) stack.push(el);
        return j + (selfClosing ? 2 : 1);
      }
      ATTR_RE.lastIndex = j;
      const attr = ATTR_RE.exec(src)?.[0];
      if (!attr) throw err(`unexpected "${c}" in <${name}>`, j);
      j = ATTR_RE.lastIndex;
      while (j < src.length && isSpace(src.charCodeAt(j))) j++;
      if (src[j] !== "=") {
        el.attrs.set(attr, ""); // lenient: an attribute without a value
        continue;
      }
      j++;
      while (j < src.length && isSpace(src.charCodeAt(j))) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") throw err(`the value of ${attr} on <${name}> is not in quotes`, j);
      const end = src.indexOf(q, j + 1);
      if (end < 0) throw err(`the value of ${attr} on <${name}> is never closed`, j);
      el.attrs.set(attr, decode(src.slice(j + 1, end)));
      j = end + 1;
    }
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      text(decode(src.slice(i)), i);
      break;
    }
    if (lt > i) text(decode(src.slice(i, lt)), i);
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw err("a comment is never closed", lt);
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw err("a CDATA section is never closed", lt);
      text(src.slice(lt + 9, end), lt);
      i = end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw err("a <?…?> instruction is never closed", lt);
      i = end + 2;
    } else if (src.startsWith("<!", lt)) {
      i = doctype(lt);
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end < 0) throw err("a closing tag is never finished", lt);
      const name = src.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open) throw err(`</${name}> has no opening tag`, lt);
      if (open.name !== name) throw err(`</${name}> closes <${open.name}>`, lt);
      i = end + 1;
    } else {
      i = openTag(lt);
    }
  }
  if (stack.length) throw err(`<${stack.at(-1)!.name}> is never closed`, src.length);
  if (!root) throw err("there are no elements", 0);
  return root;
}

// ---------------------------------------------------------------- numbers, lengths, transforms

const NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
const NUM_RE = new RegExp(NUM, "y");
const NUMS_RE = new RegExp(NUM, "g");
const LENGTH_RE = new RegExp(`^(${NUM})\\s*([a-zA-Z]*|%)$`);

const numbers = (s: string) => (s.match(NUMS_RE) ?? []).map(Number).filter(Number.isFinite);

/** A length in user units (px); percentages are of `ref`. undefined when missing or invalid. */
function parseLength(v: string | undefined, ref: number): number | undefined {
  if (v === undefined) return undefined;
  const m = LENGTH_RE.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  if (m[2] === "%") return (n / 100) * ref;
  const k = UNIT_PX[m[2]!.toLowerCase()];
  return k === undefined ? undefined : n * k;
}

/** The outer <svg>'s width/height in mm; percentages and non-positive sizes count as missing. */
function rootLengthMm(v: string | undefined): number | undefined {
  if (v === undefined || v.trim().endsWith("%")) return undefined;
  const px = parseLength(v, 0);
  return px !== undefined && px > 0 ? px * PX_MM : undefined;
}

type ViewBox = { x: number; y: number; w: number; h: number };

function parseViewBox(v: string | undefined): ViewBox | null {
  const n = numbers(v ?? "");
  return n.length === 4 && n[2]! > 0 && n[3]! > 0 ? { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! } : null;
}

/** Maps a viewBox onto a w × h viewport honouring preserveAspectRatio (no clipping for "slice"). */
function viewBoxTransform(vb: ViewBox, w: number, h: number, par: string | undefined): Mat {
  const words = (par ?? "").trim().split(/\s+/).filter(Boolean);
  if (words[0] === "defer") words.shift();
  const align = words[0] ?? "xMidYMid";
  let sx = w / vb.w, sy = h / vb.h;
  if (align !== "none") sx = sy = words[1] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  let tx = -vb.x * sx, ty = -vb.y * sy;
  if (align.includes("xMid")) tx += (w - vb.w * sx) / 2;
  else if (align.includes("xMax")) tx += w - vb.w * sx;
  if (align.includes("YMid")) ty += (h - vb.h * sy) / 2;
  else if (align.includes("YMax")) ty += h - vb.h * sy;
  return [sx, 0, 0, sy, tx, ty];
}

const TRANSFORM_RE = /\s*,?\s*([A-Za-z]+)\s*\(([^)]*)\)/y;

/** A transform list as one matrix; null when it is invalid (browsers then ignore the attribute). */
function parseTransform(s: string | undefined): Mat | null {
  if (!s?.trim()) return IDENTITY;
  const src = s.trim();
  let m = IDENTITY;
  let i = 0;
  while (i < src.length) {
    TRANSFORM_RE.lastIndex = i;
    const t = TRANSFORM_RE.exec(src);
    if (!t) return null;
    i = TRANSFORM_RE.lastIndex;
    const a = numbers(t[2]!);
    const [p = 0, q, r] = a;
    let next: Mat;
    switch (t[1]) {
      case "matrix":
        if (a.length !== 6) return null;
        next = a as unknown as Mat;
        break;
      case "translate":
        if (a.length < 1 || a.length > 2) return null;
        next = translate(p, q ?? 0);
        break;
      case "scale":
        if (a.length < 1 || a.length > 2) return null;
        next = scale(p, q ?? p);
        break;
      case "rotate":
        if (a.length === 1) next = rotate(p);
        else if (a.length === 3) next = mul(translate(q!, r!), mul(rotate(p), translate(-q!, -r!)));
        else return null;
        break;
      case "skewX":
        if (a.length !== 1) return null;
        next = [1, 0, Math.tan((p * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        if (a.length !== 1) return null;
        next = [1, Math.tan((p * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        return null;
    }
    m = mul(m, next);
  }
  return m;
}

// ---------------------------------------------------------------- paths

type Subpath = { pts: Vec[]; closed: boolean };

/** Collects subpaths in final mm; takes user-space points and flattens curves after transforming them. */
class PathBuilder {
  readonly subpaths: Subpath[] = [];
  private sub: Subpath | null = null;
  /** Current point and subpath start, in user units. */
  private at: Vec = [0, 0];
  private start: Vec = [0, 0];
  private readonly stretch: number;

  constructor(private readonly m: Mat, private readonly tol: number, private readonly budget: PointBudget) {
    this.stretch = maxScale(m);
  }

  /** The open subpath; a drawing command right after Z starts a new one at the old start point. */
  private out(): Vec[] {
    if (!this.sub) {
      this.sub = { pts: [apply(this.m, this.at)], closed: false };
      this.subpaths.push(this.sub);
    }
    return this.sub.pts;
  }

  moveTo(p: Vec) {
    this.sub = null;
    this.at = this.start = p;
    this.out();
  }

  lineTo(p: Vec) {
    const pts = this.out();
    const q = apply(this.m, p);
    const last = pts.at(-1)!;
    if (q[0] !== last[0] || q[1] !== last[1]) pts.push(q);
    this.budget.take(1);
    this.at = p;
  }

  cubicTo(c1: Vec, c2: Vec, p: Vec) {
    const pts = this.out();
    flattenCubic(pts, pts.at(-1)!, apply(this.m, c1), apply(this.m, c2), apply(this.m, p), this.tol, this.budget);
    this.at = p;
  }

  quadTo(c: Vec, p: Vec) {
    const pts = this.out();
    flattenQuad(pts, pts.at(-1)!, apply(this.m, c), apply(this.m, p), this.tol, this.budget);
    this.at = p;
  }

  /** Elliptical arc in endpoint form (SVG implementation notes, F.6.5–F.6.6). */
  arcTo(rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, p: Vec) {
    const [x1, y1] = this.at, [x2, y2] = p;
    if (x1 === x2 && y1 === y2) return; // same end points: the arc is omitted
    let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
    if (rx === 0 || ry === 0) return this.lineTo(p);
    const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    // Radii too small to reach the end point are scaled up just enough.
    const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const den = rx * rx * yp * yp + ry * ry * xp * xp;
    const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = arcSteps(this.stretch * Math.max(rx, ry), dt, this.tol);
    this.budget.take(n);
    const pts = this.out();
    for (let i = 1; i < n; i++) {
      const t = t1 + (dt * i) / n;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      pts.push(apply(this.m, [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]));
    }
    pts.push(apply(this.m, p));
    this.at = p;
  }

  /** A whole ellipse as one closed subpath. */
  ellipse(cx: number, cy: number, rx: number, ry: number) {
    const n = arcSteps(this.stretch * Math.max(rx, ry), 2 * Math.PI, this.tol);
    this.budget.take(n);
    const pts: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      pts.push(apply(this.m, [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]));
    }
    this.subpaths.push({ pts, closed: true });
    this.sub = null;
    this.at = this.start = [cx + rx, cy];
  }

  close() {
    if (this.sub) {
      const { pts } = this.sub;
      const a = pts[0]!, b = pts.at(-1)!;
      if (pts.length > 1 && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
      this.sub.closed = true;
    }
    this.sub = null;
    this.at = this.start;
  }
}

const PATH_ERROR = new Error("bad path data");
const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";
const reflect = (c: Vec, about: Vec): Vec => [2 * about[0] - c[0], 2 * about[1] - c[1]];

/**
 * Feeds path data to the builder. Returns false on an error; like browsers, everything up to the error is
 * kept. Numbers may be packed ("1.5.5" is 1.5 then .5, "-1-2" is -1 then -2) and arc flags are single
 * digits that need no separator ("a1 1 0 00 1 1").
 */
function tracePath(d: string, b: PathBuilder): boolean {
  let i = 0;
  const skip = () => {
    while (i < d.length) {
      const c = d.charCodeAt(i);
      if (isSpace(c) || c === 44 || c === 12) i++;
      else break;
    }
  };
  const num = (): number => {
    skip();
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m) throw PATH_ERROR;
    i = NUM_RE.lastIndex;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) throw PATH_ERROR;
    return v;
  };
  const flag = (): boolean => {
    skip();
    const c = d[i++];
    if (c !== "0" && c !== "1") throw PATH_ERROR;
    return c === "1";
  };
  let cmd = "";
  let cur: Vec = [0, 0], start: Vec = [0, 0];
  let lastCubic: Vec | null = null, lastQuad: Vec | null = null;
  try {
    for (;;) {
      skip();
      if (i >= d.length) return true;
      const c = d[i]!;
      if (/[A-Za-z]/.test(c)) {
        if (!COMMANDS.includes(c) || (!cmd && c !== "M" && c !== "m")) throw PATH_ERROR;
        cmd = c;
        i++;
      } else if (cmd === "M") cmd = "L"; // extra pairs after a moveto are linetos
      else if (cmd === "m") cmd = "l";
      else if (!cmd || cmd === "Z" || cmd === "z") throw PATH_ERROR;
      const rel = cmd >= "a";
      const at = (x: number, y: number): Vec => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
      const pair = () => at(num(), num());
      let nextCubic: Vec | null = null, nextQuad: Vec | null = null;
      switch (cmd.toUpperCase()) {
        case "M":
          cur = start = pair();
          b.moveTo(cur);
          break;
        case "L":
          cur = pair();
          b.lineTo(cur);
          break;
        case "H": {
          const x = num();
          cur = [rel ? cur[0] + x : x, cur[1]];
          b.lineTo(cur);
          break;
        }
        case "V": {
          const y = num();
          cur = [cur[0], rel ? cur[1] + y : y];
          b.lineTo(cur);
          break;
        }
        case "C": {
          const c1 = pair(), c2 = pair(), p = pair();
          b.cubicTo(c1, c2, p);
          [nextCubic, cur] = [c2, p];
          break;
        }
        case "S": {
          const c1: Vec = lastCubic ? reflect(lastCubic, cur) : cur;
          const c2 = pair(), p = pair();
          b.cubicTo(c1, c2, p);
          [nextCubic, cur] = [c2, p];
          break;
        }
        case "Q": {
          const c1 = pair(), p = pair();
          b.quadTo(c1, p);
          [nextQuad, cur] = [c1, p];
          break;
        }
        case "T": {
          const c1: Vec = lastQuad ? reflect(lastQuad, cur) : cur;
          const p = pair();
          b.quadTo(c1, p);
          [nextQuad, cur] = [c1, p];
          break;
        }
        case "A": {
          const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
          const p = pair();
          b.arcTo(rx, ry, rot, large, sweep, p);
          cur = p;
          break;
        }
        case "Z":
          b.close();
          cur = start;
          break;
      }
      lastCubic = nextCubic;
      lastQuad = nextQuad;
    }
  } catch (error) {
    if (error === PATH_ERROR) return false;
    throw error;
  }
}

// ---------------------------------------------------------------- styles

type Style = { fill: string; stroke: string; fillRule: string; fillOpacity: string; strokeOpacity: string; visibility: string };

const INITIAL: Style = { fill: "black", stroke: "none", fillRule: "nonzero", fillOpacity: "1", strokeOpacity: "1", visibility: "visible" };
const INHERITED: Array<[keyof Style, string]> = [
  ["fill", "fill"],
  ["stroke", "stroke"],
  ["fillRule", "fill-rule"],
  ["fillOpacity", "fill-opacity"],
  ["strokeOpacity", "stroke-opacity"],
  ["visibility", "visibility"],
];
/** The only properties that change what gets marked. */
const PROPS = new Set(["fill", "stroke", "fill-rule", "fill-opacity", "stroke-opacity", "visibility", "display", "opacity", "clip-path", "mask"]);

type Rule = { tag: string | undefined; ids: string[]; classes: string[]; specificity: number; order: number; decls: Map<string, string> };

function parseDecls(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of s.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!\s*important/i, "").trim().toLowerCase();
    if (PROPS.has(key) && value) out.set(key, value);
  }
  return out;
}

const SELECTOR_RE = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/;

/** Rules of a stylesheet with simple selectors (element, .class, #id, compounds of those); returns the count of selectors it could not use. */
function parseCss(css: string, rules: Rule[]): number {
  let unsupported = 0;
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    // Statements without a block (@import …;) end at ';', so the selector is what follows the last one.
    const prelude = src.slice(i, open).split(";").at(-1)!.trim();
    let depth = 1, j = open + 1;
    for (; j < src.length && depth; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
    }
    const body = src.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith("@")) continue; // @media, @font-face…: not applied
    const decls = parseDecls(body);
    for (const sel of prelude.split(",")) {
      const m = SELECTOR_RE.exec(sel.trim());
      if (!m || !sel.trim()) {
        unsupported++;
        continue;
      }
      const parts = m[2]!.match(/[.#][\w-]+/g) ?? [];
      const ids = parts.filter(p => p[0] === "#").map(p => p.slice(1));
      const classes = parts.filter(p => p[0] === ".").map(p => p.slice(1));
      const tag = m[1] && m[1] !== "*" ? m[1] : undefined;
      rules.push({ tag, ids, classes, specificity: ids.length * 10000 + classes.length * 100 + (tag ? 1 : 0), order: rules.length, decls });
    }
  }
  return unsupported;
}

const isPaint = (v: string) => v !== "none" && v !== "transparent" && v !== "";
const isZero = (v: string | undefined) => v !== undefined && parseFloat(v) === 0;

// ---------------------------------------------------------------- rendering

/** Containers and shapes that are drawn; everything else (defs, clipPath, mask, symbol, marker, pattern, title, desc, metadata, style…) is not. */
const DRAWN = new Set(["svg", "g", "a", "switch", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const SKIPPED_CONTENT = new Set(["text", "image", "foreignObject", "video"]);

type Ctx = { m: Mat; style: Style; vw: number; vh: number; depth: number; chain: El[] };

class SvgReader {
  readonly groups: FillGroup[] = [];
  readonly lines: Vec[][] = [];
  private readonly ids = new Map<string, El>();
  private readonly rules: Rule[] = [];
  private readonly svgPrefixes = new Set<string>();
  private readonly budget = new PointBudget();
  private readonly n = {
    text: 0, image: 0, foreignObject: 0, video: 0, badPath: 0, badTransform: 0, noPaint: 0,
    clipped: 0, missingUse: 0, externalUse: 0, loopUse: 0, badCss: 0,
  };

  constructor(private readonly root: El, private readonly tol: number) {
    // Index every element first: ids and stylesheets apply wherever they appear (often inside <defs>).
    const all: El[] = [];
    for (const stack = [root]; stack.length; ) {
      const el = stack.pop()!;
      all.push(el);
      for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]!);
    }
    for (const el of all) for (const [k, v] of el.attrs) if (k.startsWith("xmlns:") && v === SVG_NS) this.svgPrefixes.add(k.slice(6));
    for (const el of all) {
      const id = el.attrs.get("id");
      if (id !== undefined && !this.ids.has(id)) this.ids.set(id, el);
      const type = el.attrs.get("type");
      if (this.svgName(el) === "style" && (!type || type === "text/css")) this.n.badCss += parseCss(el.text, this.rules);
    }
    this.rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  }

  /** The SVG element name, or undefined for elements of other namespaces (sodipodi:, inkscape:…). */
  private svgName(el: El): string | undefined {
    const colon = el.name.indexOf(":");
    if (colon < 0) return el.name;
    return this.svgPrefixes.has(el.name.slice(0, colon)) ? el.name.slice(colon + 1) : undefined;
  }

  /** Presentation attributes, then stylesheet rules by specificity, then the style attribute. */
  private decls(el: El, name: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of el.attrs) if (PROPS.has(k) && v.trim()) out.set(k, v.trim().toLowerCase());
    if (this.rules.length) {
      const id = el.attrs.get("id");
      const classes = (el.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
      for (const r of this.rules) {
        if (r.tag !== undefined && r.tag !== name) continue;
        if (!r.ids.every(x => x === id) || !r.classes.every(c => classes.includes(c))) continue;
        for (const [k, v] of r.decls) out.set(k, v);
      }
    }
    const style = el.attrs.get("style");
    if (style) for (const [k, v] of parseDecls(style)) out.set(k, v);
    return out;
  }

  private computed(el: El, name: string, parent: Style) {
    const decls = this.decls(el, name);
    const style = { ...parent };
    for (const [key, prop] of INHERITED) {
      const v = decls.get(prop);
      if (v !== undefined && v !== "inherit") style[key] = v;
    }
    const hidden = decls.get("display") === "none" || isZero(decls.get("opacity"));
    return { style, decls, hidden };
  }

  run() {
    const root = this.root;
    if (this.svgName(root) !== "svg") throw new ArtImportError(`not an SVG file: the document is <${root.name}>, not <svg>`);
    const vb = parseViewBox(root.attrs.get("viewBox"));
    const wMm = rootLengthMm(root.attrs.get("width")), hMm = rootLengthMm(root.attrs.get("height"));
    let m: Mat, vw: number, vh: number;
    if (vb) {
      // A missing size follows the viewBox's aspect ratio; with neither, viewBox units are px.
      const w = wMm ?? (hMm !== undefined ? (hMm * vb.w) / vb.h : vb.w * PX_MM);
      const h = hMm ?? (wMm !== undefined ? (wMm * vb.h) / vb.w : vb.h * PX_MM);
      m = viewBoxTransform(vb, w, h, root.attrs.get("preserveAspectRatio"));
      [vw, vh] = [vb.w, vb.h];
    } else {
      m = scale(PX_MM);
      [vw, vh] = [(wMm ?? 0) / PX_MM, (hMm ?? 0) / PX_MM];
    }
    m = mul([1, 0, 0, -1, 0, 0], m); // SVG is y-down; ArtGeometry is y-up
    const { style, hidden } = this.computed(root, "svg", INITIAL);
    if (!hidden) this.children(root, { m, style, vw, vh, depth: 0, chain: [] });
  }

  private children(el: El, ctx: Ctx) {
    for (const c of el.children) this.render(c, ctx);
  }

  private render(el: El, ctx: Ctx) {
    const name = this.svgName(el);
    if (name === undefined || (!DRAWN.has(name) && !SKIPPED_CONTENT.has(name))) return;
    if (ctx.depth > MAX_DEPTH) throw new ArtImportError(`the drawing is nested too deeply (more than ${MAX_DEPTH} levels)`);
    const { style, decls, hidden } = this.computed(el, name, ctx.style);
    if (hidden) return;
    if (SKIPPED_CONTENT.has(name)) {
      this.n[name as "text" | "image" | "foreignObject" | "video"]++;
      return;
    }
    const t = parseTransform(el.attrs.get("transform"));
    if (!t) this.n.badTransform++;
    const m = t ? mul(ctx.m, t) : ctx.m;
    const clip = decls.get("clip-path"), mask = decls.get("mask");
    if ((clip && clip !== "none") || (mask && mask !== "none")) this.n.clipped++;
    const inner: Ctx = { ...ctx, m, style, depth: ctx.depth + 1 };
    switch (name) {
      case "g":
      case "a":
        return this.children(el, inner);
      case "switch": {
        // The first child whose conditions hold; we support no extensions (Illustrator puts a
        // foreignObject with requiredExtensions first and the real artwork after it).
        const pick = el.children.find(c => {
          const n = this.svgName(c);
          return n !== undefined && n !== "foreignObject" && !c.attrs.has("requiredExtensions") && (DRAWN.has(n) || SKIPPED_CONTENT.has(n));
        });
        if (pick) this.render(pick, inner);
        return;
      }
      case "svg":
        return this.nestedSvg(el, inner);
      case "use":
        return this.use(el, inner);
      default:
        return this.shape(el, name, inner);
    }
  }

  /** A nested viewport: x/y/width/height in the parent's units, with its own viewBox. */
  private nestedSvg(el: El, ctx: Ctx) {
    const x = parseLength(el.attrs.get("x"), ctx.vw) ?? 0, y = parseLength(el.attrs.get("y"), ctx.vh) ?? 0;
    const w = parseLength(el.attrs.get("width"), ctx.vw) ?? ctx.vw, h = parseLength(el.attrs.get("height"), ctx.vh) ?? ctx.vh;
    this.viewport(el, el.attrs.get("viewBox"), el.attrs.get("preserveAspectRatio"), mul(ctx.m, translate(x, y)), w, h, ctx);
  }

  private viewport(el: El, viewBox: string | undefined, par: string | undefined, m: Mat, w: number, h: number, ctx: Ctx) {
    const vb = parseViewBox(viewBox);
    if (vb && w > 0 && h > 0) this.children(el, { ...ctx, m: mul(m, viewBoxTransform(vb, w, h, par)), vw: vb.w, vh: vb.h });
    else this.children(el, { ...ctx, m, vw: w, vh: h });
  }

  private use(el: El, ctx: Ctx) {
    let href = el.attrs.get("href") ?? el.attrs.get("xlink:href");
    if (href === undefined) for (const [k, v] of el.attrs) if (k.endsWith(":href")) href = v;
    if (!href) return;
    if (!href.startsWith("#")) {
      this.n.externalUse++;
      return;
    }
    const target = this.ids.get(href.slice(1));
    if (!target) {
      this.n.missingUse++;
      return;
    }
    if (ctx.chain.includes(target) || ctx.chain.length > 64) {
      this.n.loopUse++;
      return;
    }
    const m = mul(ctx.m, translate(parseLength(el.attrs.get("x"), ctx.vw) ?? 0, parseLength(el.attrs.get("y"), ctx.vh) ?? 0));
    // The copy inherits paint from the <use>, not from where the original sits.
    const inner: Ctx = { ...ctx, m, chain: [...ctx.chain, target] };
    if (this.svgName(target) === "symbol") {
      const { style } = this.computed(target, "symbol", ctx.style);
      const w = parseLength(el.attrs.get("width") ?? target.attrs.get("width"), ctx.vw) ?? ctx.vw;
      const h = parseLength(el.attrs.get("height") ?? target.attrs.get("height"), ctx.vh) ?? ctx.vh;
      this.viewport(target, target.attrs.get("viewBox"), target.attrs.get("preserveAspectRatio"), m, w, h, { ...inner, style });
    } else this.render(target, inner);
  }

  private shape(el: El, name: string, ctx: Ctx) {
    if (ctx.style.visibility === "hidden" || ctx.style.visibility === "collapse") return;
    const b = new PathBuilder(ctx.m, this.tol, this.budget);
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    const len = (attr: string, ref: number) => parseLength(el.attrs.get(attr), ref);
    switch (name) {
      case "path":
        if (!tracePath(el.attrs.get("d") ?? "", b)) this.n.badPath++;
        break;
      case "rect": {
        const x = len("x", ctx.vw) ?? 0, y = len("y", ctx.vh) ?? 0, w = len("width", ctx.vw) ?? 0, h = len("height", ctx.vh) ?? 0;
        if (!(w > 0 && h > 0)) return;
        // A missing (or negative) corner radius copies the other one; both stop at half the side.
        let rx = len("rx", ctx.vw), ry = len("ry", ctx.vh);
        if (rx !== undefined && rx < 0) rx = undefined;
        if (ry !== undefined && ry < 0) ry = undefined;
        const rxc = Math.min(rx ?? ry ?? 0, w / 2), ryc = Math.min(ry ?? rx ?? 0, h / 2);
        if (rxc > 0 && ryc > 0) {
          b.moveTo([x + rxc, y]);
          b.lineTo([x + w - rxc, y]);
          b.arcTo(rxc, ryc, 0, false, true, [x + w, y + ryc]);
          b.lineTo([x + w, y + h - ryc]);
          b.arcTo(rxc, ryc, 0, false, true, [x + w - rxc, y + h]);
          b.lineTo([x + rxc, y + h]);
          b.arcTo(rxc, ryc, 0, false, true, [x, y + h - ryc]);
          b.lineTo([x, y + ryc]);
          b.arcTo(rxc, ryc, 0, false, true, [x + rxc, y]);
        } else {
          b.moveTo([x, y]);
          b.lineTo([x + w, y]);
          b.lineTo([x + w, y + h]);
          b.lineTo([x, y + h]);
        }
        b.close();
        break;
      }
      case "circle": {
        const r = len("r", diag) ?? 0;
        if (!(r > 0)) return;
        b.ellipse(len("cx", ctx.vw) ?? 0, len("cy", ctx.vh) ?? 0, r, r);
        break;
      }
      case "ellipse": {
        const rxa = len("rx", ctx.vw), rya = len("ry", ctx.vh);
        const rx = rxa ?? rya ?? 0, ry = rya ?? rxa ?? 0; // SVG 2: a missing radius copies the other
        if (!(rx > 0 && ry > 0)) return;
        b.ellipse(len("cx", ctx.vw) ?? 0, len("cy", ctx.vh) ?? 0, rx, ry);
        break;
      }
      case "line":
        b.moveTo([len("x1", ctx.vw) ?? 0, len("y1", ctx.vh) ?? 0]);
        b.lineTo([len("x2", ctx.vw) ?? 0, len("y2", ctx.vh) ?? 0]);
        break;
      case "polyline":
      case "polygon": {
        const v = numbers(el.attrs.get("points") ?? "");
        if (v.length < 4) return;
        b.moveTo([v[0]!, v[1]!]);
        for (let k = 2; k + 1 < v.length; k += 2) b.lineTo([v[k]!, v[k + 1]!]); // an odd last number is dropped
        if (name === "polygon") b.close();
        break;
      }
    }
    this.paint(b.subpaths, ctx.style, name !== "line");
  }

  private paint(subpaths: Subpath[], st: Style, canFill: boolean) {
    const fill = canFill && isPaint(st.fill) && !isZero(st.fillOpacity);
    const stroke = isPaint(st.stroke) && !isZero(st.strokeOpacity);
    const asLine = (s: Subpath) => {
      if (s.pts.length >= 2) this.lines.push(s.closed ? [...s.pts, s.pts[0]!] : s.pts);
    };
    if (fill) {
      const rings: Vec[][] = [];
      for (const s of subpaths) {
        // A fill-and-stroke subpath with no area (a straight line) is only visible as its stroke.
        if (Math.abs(ringArea(s.pts)) > 1e-9) rings.push(s.pts);
        else if (stroke) asLine(s);
      }
      if (rings.length) this.groups.push({ rings, rule: st.fillRule === "evenodd" ? "EvenOdd" : "NonZero" });
    } else if (stroke) subpaths.forEach(asLine);
    else if (subpaths.length) this.n.noPaint++;
  }

  warnings(): string[] {
    const n = this.n, out: string[] = [];
    if (n.text) out.push(`${count(n.text, "text element")} skipped: convert text to paths first`);
    if (n.image) out.push(`${count(n.image, "image")} skipped: bitmap images cannot be marked as vectors`);
    if (n.foreignObject) out.push(`${count(n.foreignObject, "embedded HTML block (foreignObject)", "embedded HTML blocks (foreignObject)")} skipped`);
    if (n.video) out.push(`${count(n.video, "video")} skipped`);
    if (n.badPath) out.push(`${count(n.badPath, "path")} drawn only up to an error in the path data`);
    if (n.badTransform) out.push(`${count(n.badTransform, "invalid transform")} ignored`);
    if (n.clipped) out.push(`${count(n.clipped, "clipping path or mask", "clipping paths or masks")} ignored: the shapes are marked in full`);
    if (n.noPaint) out.push(`${count(n.noPaint, "shape")} skipped: no fill and no stroke`);
    if (n.missingUse) out.push(`${count(n.missingUse, "<use> element")} skipped: the shape it copies is missing`);
    if (n.externalUse) out.push(`${count(n.externalUse, "<use> element")} skipped: it copies from another file`);
    if (n.loopUse) out.push(`${count(n.loopUse, "<use> element")} skipped: it copies itself`);
    if (n.badCss) out.push(`${count(n.badCss, "CSS selector")} ignored: only element, .class and #id selectors are supported`);
    return out;
  }
}

/** Signed shoelace area. */
function ringArea(r: Vec[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
}

/**
 * Reads SVG text. Units come from the root width/height (mm, cm, in, pt, pc, px or none = px at 96 dpi) and
 * viewBox; without a size, viewBox units are px. Throws {@link ArtImportError} for text that is not SVG.
 */
export async function importSvg(text: string, opts?: { toleranceMm?: number }): Promise<ArtGeometry> {
  const tol = toleranceOf(opts);
  const src = text.replace(/^﻿/, "");
  if (!src.trim()) return finish([], [], ["The file is empty."]);
  const root = parseXml(src);
  const reader = new SvgReader(root, tol);
  reader.run();
  return finish(reader.groups, reader.lines, reader.warnings());
}

/**
 * DRC / ERC reports as the phone shows them, and where a violation sits on the top render.
 *
 * Two report shapes reach `reports/drc.json`: what fabdesk's `verify_drc` writes (a wrapper with
 * `violations`/`unconnected`/`schematicParity`, each violation carrying `rule`, plus the KiCad
 * output under `raw`) and, for boards checked outside fabdesk, KiCad's own
 * `kicad-cli pcb drc --format json` (`type`, `unconnected_items`, `schematic_parity`; ERC nests
 * everything under `sheets`). The desktop's DrcTab reads only the KiCad shape and so shows
 * fabdesk's own reports as type "unknown" with no unconnected items; this parser takes both.
 */

export interface ViolationItem {
  description: string;
  /** Board coordinates in mm (KiCad's frame: origin top-left of the sheet, y down). */
  pos?: { x: number; y: number };
}

export interface Violation {
  source: "drc" | "erc";
  /** `rule` in fabdesk reports, `type` in KiCad's. */
  type: string;
  severity: string;
  description: string;
  items: ViolationItem[];
  excluded?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeItem(v: unknown): ViolationItem {
  const r = asRecord(v);
  if (!r) return { description: String(v) };
  const pos = asRecord(r["pos"]);
  const x = pos?.["x"];
  const y = pos?.["y"];
  return {
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    ...(typeof x === "number" && typeof y === "number" ? { pos: { x, y } } : {}),
  };
}

function normalizeViolation(
  v: unknown,
  source: "drc" | "erc",
  fallbackType?: string,
): Violation | null {
  const r = asRecord(v);
  if (!r) return null;
  const type =
    typeof r["type"] === "string" ? r["type"] : typeof r["rule"] === "string" ? r["rule"] : null;
  return {
    source,
    type: type ?? fallbackType ?? "unknown",
    severity: typeof r["severity"] === "string" ? r["severity"] : "error",
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    items: Array.isArray(r["items"]) ? r["items"].map(normalizeItem) : [],
    ...(r["excluded"] === true ? { excluded: true } : {}),
  };
}

function pushAll(out: Violation[], arr: unknown, source: "drc" | "erc", fallbackType?: string) {
  if (!Array.isArray(arr)) return;
  for (const v of arr) {
    const n = normalizeViolation(v, source, fallbackType);
    if (n) out.push(n);
  }
}

/** Flattens either report shape (or a plain array) into one list. `null`/`undefined` → empty. */
export function normalizeReport(json: unknown, source: "drc" | "erc"): Violation[] {
  if (!json) return [];
  const out: Violation[] = [];
  if (Array.isArray(json)) {
    pushAll(out, json, source);
    return out;
  }
  const r = asRecord(json);
  if (!r) return [];
  if ("counts" in r || "raw" in r) {
    // fabdesk's wrapper: its lists are derived from `raw`, so `raw` is not read again.
    pushAll(out, r["violations"], source);
    pushAll(out, r["unconnected"], source, "unconnected");
    pushAll(out, r["schematicParity"], source);
    return out;
  }
  pushAll(out, r["violations"], source);
  pushAll(out, r["unconnected_items"], source, "unconnected");
  pushAll(out, r["schematic_parity"], source);
  const sheets = r["sheets"];
  if (Array.isArray(sheets))
    for (const sheet of sheets) out.push(...normalizeReport(sheet, source));
  return out;
}

export const SEVERITY_ORDER = ["error", "warning", "exclusion"] as const;

export interface SeveritySection {
  severity: string;
  violations: Violation[];
}

/** Errors first, then warnings, exclusions, anything else; excluded violations sink to the end. */
export function groupBySeverity(violations: Violation[]): SeveritySection[] {
  const rank = (s: string) => {
    const i = (SEVERITY_ORDER as readonly string[]).indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
  };
  const buckets = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = v.excluded ? "excluded" : v.severity;
    const list = buckets.get(key) ?? [];
    list.push(v);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .sort(
      ([a], [b]) =>
        (a === "excluded" ? 1 : b === "excluded" ? -1 : rank(a) - rank(b)) || a.localeCompare(b),
    )
    .map(([severity, list]) => ({ severity, violations: list }));
}

export interface ReportSummary {
  total: number;
  errors: number;
  warnings: number;
  /** Excluded violations do not count towards `total`. */
  excluded: number;
}

export function summarize(violations: Violation[]): ReportSummary {
  let errors = 0;
  let warnings = 0;
  let excluded = 0;
  for (const v of violations) {
    if (v.excluded) excluded += 1;
    else if (v.severity === "error") errors += 1;
    else if (v.severity === "warning") warnings += 1;
  }
  return { total: violations.length - excluded, errors, warnings, excluded };
}

/* ---------- board outline → render coordinates ---------- */

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box of the board outline (`Edge.Cuts`) in a `.kicad_pcb`, from a plain scan of the
 * text: every `gr_*` / `fp_*` graphic on that layer contributes its `start`/`end`/`mid`/`center`/
 * `xy` points, and a circle its centre ± radius. Arcs contribute their three points only, which
 * can under-read a bulge by a fraction of a millimetre — fine for placing a marker.
 * Null when the file has no outline.
 */
export function boardOutlineBbox(pcb: string): Bbox | null {
  let bbox: Bbox | null = null;
  const extend = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bbox = bbox
      ? {
          minX: Math.min(bbox.minX, x),
          minY: Math.min(bbox.minY, y),
          maxX: Math.max(bbox.maxX, x),
          maxY: Math.max(bbox.maxY, y),
        }
      : { minX: x, minY: y, maxX: x, maxY: y };
  };
  const head =
    /\((gr_line|gr_rect|gr_arc|gr_circle|gr_poly|gr_curve|fp_line|fp_rect|fp_arc|fp_circle|fp_poly)\b/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(pcb))) {
    const end = closingParen(pcb, m.index);
    if (end === -1) break;
    const body = pcb.slice(m.index, end + 1);
    head.lastIndex = m.index + 1;
    if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(body)) continue;
    const kind = m[1]!;
    const points: Array<[number, number]> = [];
    const pt = /\((start|end|mid|center|xy)\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
    let p: RegExpExecArray | null;
    let center: [number, number] | null = null;
    while ((p = pt.exec(body))) {
      const xy: [number, number] = [Number(p[2]), Number(p[3])];
      if (p[1] === "center") center = xy;
      points.push(xy);
    }
    if ((kind === "gr_circle" || kind === "fp_circle") && center) {
      const endPt = points.find((q) => q !== center);
      if (endPt) {
        const r = Math.hypot(endPt[0] - center[0], endPt[1] - center[1]);
        extend(center[0] - r, center[1] - r);
        extend(center[0] + r, center[1] + r);
        continue;
      }
    }
    for (const [x, y] of points) extend(x, y);
  }
  return bbox;
}

/** Index of the paren that closes the list opening at `open`, or -1. Quoted strings are skipped. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * How `kicad-cli pcb render --side top|bottom` frames a board, measured on KiCad 10.0.4 over
 * several board aspect ratios and image sizes: the board's larger outline dimension always spans
 * this fraction of the image *height* (KiCad normalises the board's larger side to 8 units and
 * the orthographic camera's vertical extent is fixed at ~8.31), and the outline's centre sits at
 * the image centre, give or take ~1% of the image size. `renderPoint` maps a board coordinate to
 * a fraction of the image on that basis; a phone-sized marker hides the 1%.
 */
export const RENDER_FILL_OF_HEIGHT = 0.9625;

export interface ImageSize {
  width: number;
  height: number;
}

export interface RenderFraction {
  /** 0..1 of the image width, left to right. */
  fx: number;
  /** 0..1 of the image height, top to bottom. */
  fy: number;
}

/** A board position (mm) as a fraction of a top or bottom render; `null` when off the picture. */
export function renderPoint(
  pos: { x: number; y: number },
  outline: Bbox,
  image: ImageSize,
  view: "top" | "bottom" = "top",
): RenderFraction | null {
  const w = outline.maxX - outline.minX;
  const h = outline.maxY - outline.minY;
  const maxDim = Math.max(w, h);
  if (!(maxDim > 0) || !(image.width > 0) || !(image.height > 0)) return null;
  const pxPerMm = (RENDER_FILL_OF_HEIGHT * image.height) / maxDim;
  const cx = (outline.minX + outline.maxX) / 2;
  const cy = (outline.minY + outline.maxY) / 2;
  const dx = (pos.x - cx) * pxPerMm * (view === "bottom" ? -1 : 1);
  const dy = (pos.y - cy) * pxPerMm;
  const fx = 0.5 + dx / image.width;
  const fy = 0.5 + dy / image.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { fx, fy };
}

/**
 * Where an image with `contentFit: "contain"` actually paints inside a box: the picture is
 * centred and letterboxed, so a fraction of the image is not a fraction of the box.
 */
export function containedRect(
  image: ImageSize,
  box: ImageSize,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

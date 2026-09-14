/**
 * Layer toggles and sizing for the daemon's kicad-cli SVG renders.
 *
 * kicad-cli's single-file `pcb export svg` has no layer groups: it is one root `<g>` whose children
 * carry the layer colour in a `style` attribute (`fill:#C83434` for F.Cu, and so on), so colour is
 * the only handle a client has. The colours of the default KiCad theme for the layers
 * `render_pcb_svg` plots are named here; any other colour is listed by its hex so nothing is
 * un-hideable. Hiding a layer rewrites that colour to `none` in the XML, which is cheap and needs
 * nothing from the renderer beyond re-parsing the string.
 */

export interface SvgLayer {
  /** Upper-case `#RRGGBB`; the stable key for toggling. */
  color: string;
  /** KiCad layer name when the colour is a default-theme one, else the hex. */
  name: string;
  /** Number of `fill:`/`stroke:` uses, a proxy for how much of the drawing it is. */
  count: number;
}

/** Default-theme plot colours for the layers `render_pcb_svg` asks kicad-cli for, in stack order. */
const KICAD_LAYER_COLORS: ReadonlyArray<readonly [color: string, name: string]> = [
  ["#D0D2CD", "Edge.Cuts"],
  ["#C83434", "F.Cu"],
  ["#4D7FC4", "B.Cu"],
  ["#F2EDA1", "F.SilkS"],
  ["#E8B2A7", "B.SilkS"],
  ["#FFFFFF", "Holes"],
];

/** Above this many characters `SvgXml` re-parses too slowly to pan; the WebView takes over. */
export const SVG_NATIVE_MAX_CHARS = 2_000_000;

export type SvgRenderPath = "native" | "webview";

export function svgRenderPath(svg: string): SvgRenderPath {
  return svg.length > SVG_NATIVE_MAX_CHARS ? "webview" : "native";
}

const COLOR_USE = /(?:fill|stroke)\s*(?::|=\s*")\s*(#[0-9a-f]{6})\b/gi;

/**
 * The colours drawn in `svg`, named where KiCad's default theme says what they are. Black is
 * skipped: it is the root group's default fill/stroke, which every element overrides.
 */
export function parseSvgLayers(svg: string): SvgLayer[] {
  const counts = new Map<string, number>();
  for (const m of svg.matchAll(COLOR_USE)) {
    const color = (m[1] ?? "").toUpperCase();
    if (color === "#000000") continue;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const named: SvgLayer[] = [];
  for (const [color, name] of KICAD_LAYER_COLORS) {
    const count = counts.get(color);
    if (count) {
      named.push({ color, name, count });
      counts.delete(color);
    }
  }
  const rest = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([color, count]) => ({ color, name: color, count }));
  return [...named, ...rest];
}

const COLOR_DECL = /(fill|stroke)(\s*:\s*|\s*=\s*")(#[0-9a-f]{6})\b/gi;

/** `svg` with every use of a hidden colour turned into `none`. Returns the input untouched when nothing is hidden. */
export function applySvgLayers(svg: string, hidden: ReadonlySet<string>): string {
  if (hidden.size === 0) return svg;
  return svg.replace(COLOR_DECL, (all, prop: string, sep: string, color: string) =>
    hidden.has(color.toUpperCase()) ? `${prop}${sep}none` : all,
  );
}

export interface SvgSize {
  width: number;
  height: number;
}

const NUM = "([0-9.eE+-]+)";

/** Drawing size in user units from `viewBox`, else from `width`/`height` (units stripped); null when neither parses. */
export function svgSize(svg: string): SvgSize | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!open) return null;
  const vb = new RegExp(
    `viewBox\\s*=\\s*"\\s*${NUM}[\\s,]+${NUM}[\\s,]+${NUM}[\\s,]+${NUM}\\s*"`,
    "i",
  ).exec(open);
  if (vb) {
    const width = Number(vb[3]);
    const height = Number(vb[4]);
    if (width > 0 && height > 0) return { width, height };
  }
  const w = new RegExp(`\\swidth\\s*=\\s*"${NUM}`, "i").exec(open);
  const h = new RegExp(`\\sheight\\s*=\\s*"${NUM}`, "i").exec(open);
  const width = Number(w?.[1]);
  const height = Number(h?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * An `<svg>` with `width`/`height` but no `viewBox` does not scale: drawn smaller than its
 * declared size it is clipped, not shrunk (tscircuit-era schematics are like this). Give it the
 * viewBox its own size implies so a viewer can fit it.
 */
export function ensureViewBox(svg: string): string {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open || /viewBox\s*=/i.test(open[0])) return svg;
  const size = svgSize(svg);
  if (!size) return svg;
  const tag = open[0].replace(/<svg\b/i, `<svg viewBox="0 0 ${size.width} ${size.height}"`);
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length);
}

/** Largest box of `size`'s aspect that fits `box`, centred — the "contain" fit for a viewer. */
export function fitSize(size: SvgSize, box: SvgSize): SvgSize {
  const scale = Math.min(box.width / size.width, box.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

/**
 * The prolog and metadata kicad-cli emits are noise to `SvgXml` (its parser tolerates the DOCTYPE
 * but warns on `<title>`/`<desc>`), so they go, along with the `<text>` elements KiCad writes
 * invisible (`opacity="0"`) next to its stroked glyph outlines.
 */
export function prepareSvgForNative(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/i, "")
    .replace(/<!DOCTYPE[^>]*>/i, "")
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<desc>[\s\S]*?<\/desc>/gi, "")
    .replace(/<text\b[^>]*\bopacity="0"[^>]*>[\s\S]*?<\/text>/gi, "")
    .trim();
}

/** A page that shows `svg` full-bleed and lets the WebView's own pinch-zoom do the rest. */
export function svgWebViewHtml(svg: string, background: string): string {
  const body = svg.replace(/<\?xml[^>]*\?>/i, "").replace(/<!DOCTYPE[^>]*>/i, "");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=12, user-scalable=yes">
<style>html,body{margin:0;height:100%;background:${background}}svg{width:100%;height:100%;display:block}</style>
</head><body>${body}</body></html>`;
}

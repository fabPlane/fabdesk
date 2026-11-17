/**
 * Text boxes without a CAD kernel. KiCad's stroke-font text extent is linear in the glyph advances and the stroke
 * thickness, measured against KiCad's own `PCB_TEXT::GetBoundingBox()` (stable 10.0, `pcbnew`) for every printable
 * ASCII character at size 1.0 / thickness 0.1:
 *
 *   width  = h * (sum of the advances of all but the last character + the last character's ink width) + 3 t
 *   height = 1.17 h + 3.51 t
 *
 * Vertical anchors: bottom-justified text spans [-(h + 3t), 0.17h + 0.51t] about the anchor, top-justified the mirror
 * image; horizontally left/right put the box on one side of the anchor, centre splits it; mirroring swaps left and
 * right. A non-zero angle rotates the box about the anchor (counter-clockwise on screen, Y down). Characters outside
 * ASCII use the average advance. The table and formula agree with KiCad to 1e-5 mm on every sample measured
 * (`test/silk.test.ts`), not on arbitrary glyph bounds: this is an extent, not an outline.
 */
const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const ADV = [0.761905, 0.47619, 0.761905, 1, 0.952381, 1.14286, 1.23809, 0.47619, 0.666667, 0.666667, 0.761905, 1.23809, 0.47619, 1.23809, 0.47619, 1.04762, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.952381, 0.47619, 0.47619, 1.23809, 1.23809, 1.23809, 0.857143, 1.28571, 0.857143, 1, 1, 1, 0.904762, 0.857143, 1, 1.04762, 0.47619, 0.761905, 1, 0.809524, 1.14286, 1.04762, 1.04762, 1, 1.04762, 1, 0.952381, 0.761905, 1.04762, 0.857143, 1.14286, 0.952381, 0.857143, 0.952381, 0.666667, 0.666667, 0.666667, 0.571429, 0.761905, 0.380952, 0.904762, 0.904762, 0.857143, 0.904762, 0.857143, 0.571429, 0.904762, 0.904762, 0.47619, 0.47619, 0.809524, 0.52381, 1.33333, 0.904762, 0.904762, 0.904762, 0.904762, 0.619048, 0.809524, 0.571429, 0.904762, 0.761905, 1.04762, 0.809524, 0.761905, 0.809524, 0.666667, 0.952381, 0.666667, 0.714286];
const INK = [0.561905, 0.27619, 0.561905, 0.8, 0.752381, 0.942857, 1.03809, 0.27619, 0.466667, 0.466667, 0.561905, 1.03809, 0.27619, 1.03809, 0.27619, 0.847619, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.752381, 0.27619, 0.27619, 1.03809, 1.03809, 1.03809, 0.657143, 1.08571, 0.657143, 0.8, 0.8, 0.8, 0.704762, 0.657143, 0.8, 0.847619, 0.27619, 0.561905, 0.8, 0.609524, 0.942857, 0.847619, 0.847619, 0.8, 0.847619, 0.8, 0.752381, 0.561905, 0.847619, 0.657143, 0.942857, 0.752381, 0.657143, 0.752381, 0.466667, 0.466667, 0.466667, 0.371429, 0.561905, 0.180952, 0.704762, 0.704762, 0.657143, 0.704762, 0.657143, 0.371429, 0.704762, 0.704762, 0.27619, 0.27619, 0.609524, 0.32381, 1.13333, 0.704762, 0.704762, 0.704762, 0.704762, 0.419048, 0.609524, 0.371429, 0.704762, 0.561905, 0.847619, 0.609524, 0.561905, 0.609524, 0.466667, 0.752381, 0.466667, 0.514286];

export interface TextStyle {
  /** Glyph height in mm. */
  h: number;
  /** Stroke thickness in mm. */
  t: number;
  hjust?: "left" | "center" | "right";
  vjust?: "top" | "center" | "bottom";
  mirror?: boolean;
  /** Degrees, counter-clockwise on screen. */
  angle?: number;
}

const AVG_ADV = ADV.reduce((s, v) => s + v, 0) / ADV.length;

function glyph(c: string): { adv: number; ink: number } {
  const i = CHARS.indexOf(c);
  return i < 0 ? { adv: AVG_ADV, ink: AVG_ADV - 0.2 } : { adv: ADV[i]!, ink: INK[i]! };
}

/** Width and height of an unrotated text (one line). */
/** KiCad's effective pen: none stated (0) means an eighth of the glyph height; never more than a quarter of it. */
export const effectivePen = (h: number, t: number) => Math.min(t > 0 ? t : h / 8, h / 4);

export function textSize(text: string, h: number, t0: number): { w: number; h: number } {
  const t = effectivePen(h, t0);
  const lines = text.split("\n");
  let w = 0;
  for (const ln of lines) {
    const cs = [...ln];
    let sum = 0;
    cs.forEach((c, i) => (sum += i < cs.length - 1 ? glyph(c).adv : glyph(c).ink));
    w = Math.max(w, sum * h + 3 * t);
  }
  const one = 1.17 * h + 3.51 * t;
  return { w, h: one + (lines.length - 1) * 1.62 * h };
}

/**
 * KiCad keeps footprint field text upright (unless the field is `(unlocked yes)`): an angle outside (-90, 90] is turned by 180 degrees (the justification is not
 * mirrored, so the box falls on the other side of the anchor). Returns the style actually drawn.
 */
export function uprightStyle(s: TextStyle): TextStyle {
  const a = (((s.angle ?? 0) % 360) + 360) % 360;
  let n = a > 180 ? a - 360 : a;
  while (n <= -90) n += 180;
  while (n > 90) n -= 180;
  if (Math.abs(n - (a > 180 ? a - 360 : a)) < 1e-9) return s;
  return { ...s, angle: n };
}

/** The text's box about its anchor `(0,0)`: [x0, y0, x1, y1] (Y down). */
export function textBoxAt(text: string, s: TextStyle): [number, number, number, number] {
  const { w, h } = textSize(text, s.h, s.t);
  s = { ...s, t: effectivePen(s.h, s.t) };
  let hj = s.hjust ?? "center";
  if (s.mirror) hj = hj === "left" ? "right" : hj === "right" ? "left" : "center";
  const x0 = hj === "left" ? 0 : hj === "right" ? -w : -w / 2;
  const vj = s.vjust ?? "center";
  const below = 0.17 * s.h + 0.51 * s.t;
  const above = s.h + 3 * s.t;
  const [y0, y1] = vj === "bottom" ? [-above, below] : vj === "top" ? [-below, above] : [-h / 2, h / 2];
  const a = (((s.angle ?? 0) % 360) + 360) % 360;
  if (a === 0) return [x0, y0, x0 + w, y1];
  const c = Math.cos(a * (Math.PI / 180));
  const sn = Math.sin(a * (Math.PI / 180));
  const pts = [[x0, y0], [x0 + w, y0], [x0 + w, y1], [x0, y1]].map(([x, y]) => [x! * c + y! * sn, -x! * sn + y! * c] as const);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

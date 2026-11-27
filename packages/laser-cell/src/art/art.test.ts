import { describe, expect, test } from "bun:test";
import { hatch } from "../lmc/job";
import { ArtImportError, importArt, importDxf, importSvg, type ArtGeometry, type Vec } from "./index";

// ---------------------------------------------------------------- helpers

const signedArea = (r: Vec[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
};

const inside = ([x, y]: Vec, r: Vec[]) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!, [xj, yj] = r[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/**
 * Area of rings filled with the even-odd rule, for rings that do not cross: each ring counts +|A| or −|A| by
 * how many other rings contain it. The test point sits just inside the ring's first edge, so the result does
 * not depend on ring orientation.
 */
function evenOddArea(rings: Vec[][]): number {
  let total = 0;
  for (const r of rings) {
    const a = signedArea(r);
    const [p, q] = [r[0]!, r[1]!];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const side = a > 0 ? 1 : -1; // interior is left of the edges for counter-clockwise rings
    const probe: Vec = [(p[0] + q[0]) / 2 - (side * (q[1] - p[1]) * 1e-6) / len, (p[1] + q[1]) / 2 + (side * (q[0] - p[0]) * 1e-6) / len];
    const depth = rings.filter(o => o !== r && inside(probe, o)).length;
    total += (depth % 2 ? -1 : 1) * Math.abs(a);
  }
  return total;
}

const area = (g: ArtGeometry) => evenOddArea(g.fills);

/** Every vertex, for bbox checks independent of the reported size. */
const extent = (g: ArtGeometry) => {
  const pts = [...g.fills, ...g.lines].flat();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

const segDistance = (p: Vec, a: Vec, b: Vec) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Largest distance from the true curve (densely sampled) to the polyline: the chord error. */
function chordError(poly: Vec[], curve: (t: number) => Vec, samples = 4000): number {
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const p = curve(i / samples);
    let best = Infinity;
    for (let k = 0; k + 1 < poly.length; k++) best = Math.min(best, segDistance(p, poly[k]!, poly[k + 1]!));
    worst = Math.max(worst, best);
  }
  return worst;
}

/** |actual − exact| ≤ slack. A flattened curve loses up to about (2/3)·arc length·tol of area and up to tol of extent. */
const near = (actual: number, exact: number, slack: number) => expect(Math.abs(actual - exact)).toBeLessThanOrEqual(slack);

const expectSamePolylines = (a: Vec[][], b: Vec[][]) => {
  expect(a.length).toBe(b.length);
  a.forEach((line, i) => {
    expect(line.length).toBe(b[i]!.length);
    line.forEach((p, k) => {
      expect(p[0]).toBeCloseTo(b[i]![k]![0], 6);
      expect(p[1]).toBeCloseTo(b[i]![k]![1], 6);
    });
  });
};

/** A document where one user unit is one millimetre. */
const MM = 'width="100mm" height="100mm" viewBox="0 0 100 100"';
const svg = (body: string, attrs = MM) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

// ---------------------------------------------------------------- SVG: units and viewport

describe("SVG units and viewport", () => {
  test("Inkscape-style mm document: the viewBox scale applies, foreign elements are ignored", async () => {
    const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg width="100mm" height="50mm" viewBox="0 0 200 100" version="1.1" id="svg1"
   inkscape:version="1.3 (0e150ed6c4, 2023-07-21)" sodipodi:docname="logo.svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" inkscape:document-units="mm">
    <inkscape:page x="0" y="0" width="200" height="100" id="page1" />
  </sodipodi:namedview>
  <defs id="defs1" />
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(-10,-20)">
    <rect style="fill:#000000;stroke:none;stroke-width:0.264583" id="rect1" width="40" height="20" x="30" y="40" />
    <svg:circle style="fill:#1a1a1a" cx="130" cy="70" r="10" />
  </g>
</svg>`;
    const g = await importSvg(text, { toleranceMm: 0.001 });
    expect(g.warnings).toEqual([]);
    expect(g.fills).toHaveLength(2);
    // Rect 40×20 user units at 0.5 mm per unit: 20×10 mm. Circle r = 5 mm.
    expect(area(g)).toBeCloseTo(200 + 25 * Math.PI, 1);
    // Rect at x 10..30, y 10..20 mm; circle at x 55..65, y 20..30 mm (before the flip and the move).
    expect(g.widthMm).toBeCloseTo(55, 2);
    expect(g.heightMm).toBeCloseTo(20, 2);
  });

  test.each([
    ["10mm", 10],
    ["1cm", 10],
    ["1in", 25.4],
    ["72pt", 25.4],
    ["6pc", 25.4],
    ["96px", 25.4],
    ["96", 25.4],
  ])("root width %s → %d mm", async (w, mm) => {
    const g = await importSvg(svg('<rect width="10" height="10"/>', `width="${w}" height="${w}" viewBox="0 0 10 10"`));
    expect(g.widthMm).toBeCloseTo(mm, 6);
    expect(g.heightMm).toBeCloseTo(mm, 6);
  });

  test("no width/height: viewBox units are px at 96 dpi", async () => {
    const g = await importSvg(svg('<rect width="96" height="48"/>', 'viewBox="0 0 96 96"'));
    expect(g.widthMm).toBeCloseTo(25.4, 6);
    expect(g.heightMm).toBeCloseTo(12.7, 6);
  });

  test("no viewBox and no size: user units are px", async () => {
    const g = await importSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="96" height="192"/></svg>');
    expect(g.widthMm).toBeCloseTo(25.4, 6);
    expect(g.heightMm).toBeCloseTo(50.8, 6);
  });

  test("only a width: the height follows the viewBox aspect ratio", async () => {
    const g = await importSvg(svg('<rect width="100" height="50"/>', 'width="50mm" viewBox="0 0 100 50"'));
    expect(g.widthMm).toBeCloseTo(50, 6);
    expect(g.heightMm).toBeCloseTo(25, 6);
  });

  test("preserveAspectRatio: default meet scales uniformly, none stretches", async () => {
    const meet = await importSvg(svg('<rect width="10" height="10"/>', 'width="100mm" height="50mm" viewBox="0 0 10 10"'));
    expect([meet.widthMm, meet.heightMm].map(v => +v.toFixed(6))).toEqual([50, 50]);
    const none = await importSvg(svg('<rect width="10" height="10"/>', 'width="100mm" height="50mm" viewBox="0 0 10 10" preserveAspectRatio="none"'));
    expect([none.widthMm, none.heightMm].map(v => +v.toFixed(6))).toEqual([100, 50]);
  });

  test("lengths with units on shapes are converted from user units (px)", async () => {
    const g = await importSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10mm" height="1in"/></svg>');
    expect(g.widthMm).toBeCloseTo(10, 6);
    expect(g.heightMm).toBeCloseTo(25.4, 6);
  });

  test("Y is flipped: what is at the top of the SVG has the largest Y", async () => {
    const g = await importSvg(svg('<rect x="0" y="0" width="10" height="10"/><rect x="50" y="90" width="10" height="10" fill="none" stroke="black"/>'));
    expect(g.heightMm).toBeCloseTo(100, 6);
    const top = extent({ ...g, lines: [] }), bottom = extent({ ...g, fills: [] });
    expect([top.minY, top.maxY].map(v => +v.toFixed(6))).toEqual([90, 100]);
    expect([bottom.minY, bottom.maxY].map(v => +v.toFixed(6))).toEqual([0, 10]);
    expect(bottom.minX).toBeCloseTo(50, 6);
  });

  test("nested <svg> with x/y/width/height and its own viewBox", async () => {
    const g = await importSvg(svg('<rect width="1" height="1"/><svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'));
    expect(g.widthMm).toBeCloseTo(30, 6);
    expect(area(g)).toBeCloseTo(1 + 400, 6);
  });
});

// ---------------------------------------------------------------- SVG: transforms

describe("SVG transforms", () => {
  test("rotated rect via transform", async () => {
    const g = await importSvg(svg('<rect x="0" y="0" width="10" height="20" transform="rotate(45)"/>'));
    expect(g.widthMm).toBeCloseTo(30 / Math.SQRT2, 6);
    expect(g.heightMm).toBeCloseTo(30 / Math.SQRT2, 6);
    expect(area(g)).toBeCloseTo(200, 6);
  });

  test("rotate(a cx cy) turns about the given centre", async () => {
    const pin = '<rect x="0" y="-10" width="1" height="1"/>';
    const g = await importSvg(svg(`${pin}<rect x="10" y="0" width="10" height="20" transform="rotate(90 20 0)"/>`));
    // (10..20, 0..20) turned 90° about (20, 0): (x, y) → (20 − y, x − 20), so x 0..20 and y −10..0, around the pin.
    expect(g.widthMm).toBeCloseTo(20, 6);
    expect(g.heightMm).toBeCloseTo(10, 6);
  });

  test("lists apply right to left: translate(10,0) scale(2) puts x = 1 at 12", async () => {
    const g = await importSvg(svg('<rect width="1" height="1"/><rect x="1" width="1" height="1" transform="translate(10,0) scale(2)"/>'));
    expect(g.widthMm).toBeCloseTo(14, 6);
    expect(g.heightMm).toBeCloseTo(2, 6);
  });

  test("matrix, scale(x y), skewX, skewY", async () => {
    const m = await importSvg(svg('<rect width="1" height="1" transform="matrix(2 0 0 3 5 5)"/>'));
    expect([m.widthMm, m.heightMm].map(v => +v.toFixed(6))).toEqual([2, 3]);
    const s = await importSvg(svg('<rect width="1" height="1" transform="scale(4, 0.5)"/>'));
    expect([s.widthMm, s.heightMm].map(v => +v.toFixed(6))).toEqual([4, 0.5]);
    const kx = await importSvg(svg('<rect width="10" height="10" transform="skewX(45)"/>'));
    expect([kx.widthMm, kx.heightMm].map(v => +v.toFixed(6))).toEqual([20, 10]);
    expect(area(kx)).toBeCloseTo(100, 6);
    const ky = await importSvg(svg('<rect width="10" height="10" transform="skewY(45)"/>'));
    expect([ky.widthMm, ky.heightMm].map(v => +v.toFixed(6))).toEqual([10, 20]);
  });

  test("nested groups compose their transforms", async () => {
    const g = await importSvg(svg('<g transform="scale(2)"><g transform="translate(1 0) scale(1.5)"><rect width="2" height="2"/></g></g>'));
    expect(area(g)).toBeCloseTo(36, 6);
    expect(g.widthMm).toBeCloseTo(6, 6);
  });

  test("an invalid transform is ignored with a warning", async () => {
    const g = await importSvg(svg('<rect width="2" height="3" transform="spin(45)"/>'));
    expect([g.widthMm, g.heightMm]).toEqual([2, 3]);
    expect(g.warnings).toEqual(["1 invalid transform was ignored"]);
  });
});

// ---------------------------------------------------------------- SVG: path data

const stroke = (d: string) => svg(`<path fill="none" stroke="black" d="${d}"/>`);

describe("SVG path data", () => {
  test("every command, absolute and relative, packed and spaced, gives the same outline", async () => {
    const abs = "M10 10 L20 10 H30 V20 C30 25 25 30 20 30 S10 25 10 20 Q10 15 15 12 T20 10 A5 5 0 0 1 30 10 Z";
    const rel = "m10 10 l10 0 h10 v10 c0 5 -5 10 -10 10 s-10 -5 -10 -10 q0 -5 5 -8 t5 -2 a5 5 0 0 1 10 0 z";
    const packed = "m10 10l10 0h10v10c0 5-5 10-10 10s-10-5-10-10q0-5 5-8t5-2a5 5 0 0110 0z";
    const a = await importSvg(stroke(abs)), r = await importSvg(stroke(rel)), p = await importSvg(stroke(packed));
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]!.at(-1)).toEqual(a.lines[0]![0]!); // Z: a closed polyline
    expectSamePolylines(r.lines, a.lines);
    expectSamePolylines(p.lines, a.lines);
  });

  test("S reflects the previous cubic control point, T the previous quadratic one", async () => {
    const s = await importSvg(stroke("M0 0 C0 10 10 10 10 0 S20 -10 20 0"));
    const c = await importSvg(stroke("M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0"));
    expectSamePolylines(s.lines, c.lines);
    const t = await importSvg(stroke("M0 0 Q5 10 10 0 T20 0"));
    const q = await importSvg(stroke("M0 0 Q5 10 10 0 Q15 -10 20 0"));
    expectSamePolylines(t.lines, q.lines);
    expect(t.widthMm).toBeCloseTo(20, 6);
    near(t.heightMm, 10, 2 * 0.01); // peaks at ±5, each within the 0.01 mm tolerance
  });

  test("implicit repeated commands: pairs after M are L, after m are l", async () => {
    for (const d of ["M0 0 10 0 10 10 0 10z", "m0 0 10 0 0 10 -10 0z", "M0 0 L10 0 10 10 0 10 Z", "M0,0H10V10H0Z"]) {
      const g = await importSvg(svg(`<path d="${d}"/>`));
      expect(area(g)).toBeCloseTo(100, 6);
    }
  });

  test('compact numbers: "1.5.5" is 1.5 then .5, "-1-2" is -1 then -2, exponents work', async () => {
    const packed = await importSvg(stroke("M0 0L1.5.5-1-2 1e1-.5E1"));
    const spaced = await importSvg(stroke("M 0 0 L 1.5 0.5 L -1 -2 L 10 -5"));
    expectSamePolylines(packed.lines, spaced.lines);
    expect(packed.lines[0]).toHaveLength(4);
  });

  test('compact arc flags: "a1 1 0 00 1 1" and "a5 5 0 1110 0"', async () => {
    const a = await importSvg(stroke("M0 0 a1 1 0 00 1 1"));
    const b = await importSvg(stroke("M0 0 a1 1 0 0 0 1 1"));
    expectSamePolylines(a.lines, b.lines);
    const c = await importSvg(stroke("M0 0 a5 5 0 1110 0"));
    const d = await importSvg(stroke("M0 0 a5,5,0,1,1,10,0"));
    expectSamePolylines(c.lines, d.lines);
    near(c.heightMm, 5, 0.01);
  });

  test("arcs: a circle from two arcs, radii scaled up when too small, a rotated ellipse", async () => {
    const tol = 0.001;
    const circle = await importSvg(svg('<path d="M0 5 A5 5 0 0 0 10 5 A5 5 0 0 0 0 5 Z"/>'), { toleranceMm: tol });
    const a = area(circle);
    expect(a).toBeLessThanOrEqual(25 * Math.PI);
    expect(a).toBeGreaterThan(25 * Math.PI - 10 * Math.PI * tol);
    expect(circle.widthMm).toBeCloseTo(10, 2);
    // Radius 1 cannot span 10 units: scaled to 5, a half circle.
    const half = await importSvg(svg('<path d="M0 0 A1 1 0 0 1 10 0 Z"/>'), { toleranceMm: tol });
    near(area(half), 12.5 * Math.PI, 5 * Math.PI * tol);
    near(half.heightMm, 5, tol);
    // rx 10, ry 5, rotated 30°: half-widths √(a²cos²θ + b²sin²θ) and √(a²sin²θ + b²cos²θ).
    const [ex, ey] = [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)];
    const rot = await importSvg(svg(`<path d="M${50 - ex} ${50 - ey} A10 5 30 1 1 ${50 + ex} ${50 + ey} A10 5 30 1 1 ${50 - ex} ${50 - ey} Z"/>`), { toleranceMm: tol });
    expect(rot.widthMm).toBeCloseTo(2 * Math.sqrt(81.25), 2);
    expect(rot.heightMm).toBeCloseTo(2 * Math.sqrt(43.75), 2);
    expect(area(rot)).toBeCloseTo(50 * Math.PI, 1);
  });

  test("Bézier areas: parabolic segment 2/3·b·h, cubic arch 60", async () => {
    const q = await importSvg(svg('<path d="M0 0 Q5 10 10 0 Z"/>'), { toleranceMm: 0.0005 });
    expect(area(q)).toBeCloseTo((2 / 3) * 10 * 5, 2);
    const c = await importSvg(svg('<path d="M0 0 C0 10 10 10 10 0 Z"/>'), { toleranceMm: 0.0005 });
    expect(area(c)).toBeCloseTo(60, 2);
    expect(c.heightMm).toBeCloseTo(7.5, 3);
  });

  test("curves stay within the tolerance, with no more points than the bound needs", async () => {
    const tol = 0.01;
    const g = await importSvg(stroke("M0 0 C0 10 10 10 10 0"), { toleranceMm: tol });
    const line = g.lines[0]!;
    // Wang's bound: n = ⌈√(3·L / 4·tol)⌉ with L = |(10, −10)| → 33 chords.
    expect(line).toHaveLength(34);
    const cubic = (t: number): Vec => {
      const s = 1 - t;
      return [10 * (3 * s * t * t + t * t * t), -(30 * s * s * t + 30 * s * t * t) + 7.5]; // y flipped, moved to the bbox
    };
    expect(chordError(line, cubic)).toBeLessThanOrEqual(tol);
    expect(chordError(line, cubic)).toBeGreaterThan(tol / 4); // not wildly oversampled
  });

  test("circle point count follows the tolerance and the transform scale", async () => {
    const ring = async (body: string, tol?: number) => (await importSvg(svg(body), tol ? { toleranceMm: tol } : undefined)).lines[0]!;
    // ⌈2π / 2·acos(1 − tol/r)⌉ chords: 71 at r = 10, tol = 0.01; 23 at tol = 0.1. Closed: first point repeated.
    const fine = await ring('<circle cx="20" cy="20" r="10" fill="none" stroke="black"/>');
    expect(fine).toHaveLength(72);
    expect(await ring('<circle cx="20" cy="20" r="10" fill="none" stroke="black"/>', 0.1)).toHaveLength(24);
    // r = 1 scaled ×10 is sampled like r = 10.
    expect(await ring('<g transform="scale(10)"><circle cx="2" cy="2" r="1" fill="none" stroke="black"/></g>')).toHaveLength(72);
    // Vertices on the circle, chord midpoints within 0.01 mm of it. The vertices start at angle 0 and are evenly
    // spaced, so their mean is the centre.
    const vertices = fine.slice(0, -1);
    const c: Vec = [vertices.reduce((s, p) => s + p[0], 0) / vertices.length, vertices.reduce((s, p) => s + p[1], 0) / vertices.length];
    for (let i = 0; i + 1 < fine.length; i++) {
      const [p, q] = [fine[i]!, fine[i + 1]!];
      expect(Math.hypot(p[0] - c[0], p[1] - c[1])).toBeCloseTo(10, 6);
      expect(10 - Math.hypot((p[0] + q[0]) / 2 - c[0], (p[1] + q[1]) / 2 - c[1])).toBeLessThanOrEqual(0.01 + 1e-6);
    }
  });

  test("an error in path data keeps what came before it, with a warning", async () => {
    const g = await importSvg(stroke("M0 0 L10 0 L10 10 X 5 5"));
    expect(g.lines[0]).toHaveLength(3);
    expect(g.warnings).toEqual(["1 path was drawn only up to an error in the path data"]);
  });
});

// ---------------------------------------------------------------- SVG: shapes

describe("SVG shapes", () => {
  test("rect with rx/ry: rounded corners; one radius copies the other; radii clamp to half the side", async () => {
    const tol = 0.0005;
    const r = await importSvg(svg('<rect width="20" height="10" rx="2"/>'), { toleranceMm: tol });
    near(area(r), 200 - (4 - Math.PI) * 4, 2 * Math.PI * 2 * tol);
    const e = await importSvg(svg('<rect width="20" height="10" rx="4" ry="2"/>'), { toleranceMm: tol });
    near(area(e), 200 - (4 - Math.PI) * 8, 2 * Math.PI * 4 * tol);
    const pill = await importSvg(svg('<rect width="20" height="10" ry="50"/>'), { toleranceMm: tol }); // rx = ry, clamped to 10 and 5
    near(area(pill), 200 - (4 - Math.PI) * 50, 2 * Math.PI * 5 * tol);
    expect((await importSvg(svg('<rect width="0" height="10"/>'))).fills).toEqual([]);
  });

  test("circle and ellipse areas", async () => {
    const tol = 0.0005;
    expect(area(await importSvg(svg('<circle cx="10" cy="10" r="10"/>'), { toleranceMm: tol }))).toBeCloseTo(100 * Math.PI, 1);
    const e = await importSvg(svg('<ellipse cx="10" cy="10" rx="10" ry="4"/>'), { toleranceMm: tol });
    expect(area(e)).toBeCloseTo(40 * Math.PI, 1);
    expect([e.widthMm, e.heightMm].map(v => +v.toFixed(3))).toEqual([20, 8]);
  });

  test("line, polyline and polygon", async () => {
    const line = await importSvg(svg('<line x1="0" y1="0" x2="30" y2="40" stroke="black"/>'));
    expect(line.lines).toEqual([[[0, 40], [30, 0]]]);
    expect(line.fills).toEqual([]);
    // A line has no fill even with the default black fill; without a stroke nothing is drawn.
    expect((await importSvg(svg('<line x1="0" y1="0" x2="30" y2="40"/>'))).warnings).toEqual(["1 shape was skipped: no fill and no stroke"]);
    // A filled polyline is closed for filling, a stroked one stays open, a stroked polygon is closed.
    expect(area(await importSvg(svg('<polyline points="0,0 10,0 10,10"/>')))).toBeCloseTo(50, 6);
    const open = await importSvg(svg('<polyline points="0,0 10,0 10,10" fill="none" stroke="red"/>'));
    expect(open.lines[0]).toHaveLength(3);
    const closed = await importSvg(svg('<polygon points="0 0 10 0 10 10" fill="none" stroke="red"/>'));
    expect(closed.lines[0]).toHaveLength(4);
    expect(closed.lines[0]![3]).toEqual(closed.lines[0]![0]!);
  });
});

// ---------------------------------------------------------------- SVG: paint and fill rules

const star = (rule: string) => {
  const p = [0, 2, 4, 1, 3].map(k => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / 5;
    return `${50 + 10 * Math.cos(a)} ${50 + 10 * Math.sin(a)}`;
  });
  return svg(`<path fill-rule="${rule}" d="M${p.join(" L")} Z"/>`);
};

describe("SVG paint and fill rules", () => {
  test("nonzero vs evenodd star", async () => {
    const R = 10, r = (R * Math.cos((2 * Math.PI) / 5)) / Math.cos(Math.PI / 5);
    const whole = 5 * R * r * Math.sin(Math.PI / 5); // ten triangles R, r, 36°
    const pentagon = 2.5 * r * r * Math.sin((2 * Math.PI) / 5);
    expect(area(await importSvg(star("nonzero")))).toBeCloseTo(whole, 6);
    expect(area(await importSvg(star("evenodd")))).toBeCloseTo(whole - pentagon, 6);
  });

  test("letter O: a ring with a hole, by winding (nonzero) or by evenodd, works with the even-odd hatch", async () => {
    const tol = 0.001;
    const outer = "M0 10 A10 10 0 1 1 20 10 A10 10 0 1 1 0 10 Z";
    const reversed = "M4 10 A6 6 0 1 0 16 10 A6 6 0 1 0 4 10 Z"; // opposite direction: a hole under nonzero
    const same = "M4 10 A6 6 0 1 1 16 10 A6 6 0 1 1 4 10 Z";
    const nonzero = await importSvg(svg(`<path d="${outer} ${reversed}"/>`), { toleranceMm: tol });
    const evenodd = await importSvg(svg(`<path fill-rule="evenodd" d="${outer} ${same}"/>`), { toleranceMm: tol });
    const filled = await importSvg(svg(`<path d="${outer} ${same}"/>`), { toleranceMm: tol }); // nonzero, same direction: no hole
    for (const g of [nonzero, evenodd]) {
      expect(g.fills).toHaveLength(2);
      expect(area(g)).toBeCloseTo(64 * Math.PI, 1);
      // The mark job's even-odd hatch leaves the hole out, whatever the ring orientation.
      const length = hatch(g.fills, 0.05, 0).reduce((n, [p, q]) => n + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
      expect(length * 0.05).toBeCloseTo(64 * Math.PI, 0);
    }
    expect(filled.fills).toHaveLength(1);
    expect(area(filled)).toBeCloseTo(100 * Math.PI, 1);
  });

  test("two overlapping filled circles are unioned into one ring", async () => {
    const g = await importSvg(svg('<circle cx="10" cy="10" r="10"/><circle cx="25" cy="10" r="10"/>'), { toleranceMm: 0.0005 });
    expect(g.fills).toHaveLength(1);
    const lens = 2 * 100 * Math.acos(0.75) - 7.5 * Math.sqrt(400 - 225);
    expect(area(g)).toBeCloseTo(200 * Math.PI - lens, 1);
    expect([g.widthMm, g.heightMm].map(v => +v.toFixed(3))).toEqual([35, 20]);
  });

  test("fill defaults to black; stroke-only shapes become lines, closed subpaths stay closed", async () => {
    expect((await importSvg(svg('<rect width="5" height="5"/>'))).fills).toHaveLength(1);
    const g = await importSvg(svg('<path fill="none" stroke="#000" d="M0 0 L10 0 L10 10 Z M20 0 L30 0"/>'));
    expect(g.fills).toEqual([]);
    expect(g.lines.map(l => l.length)).toEqual([4, 2]);
    expect(g.lines[0]![3]).toEqual(g.lines[0]![0]!);
  });

  test("style attribute beats presentation attributes; paint inherits; inherit keyword", async () => {
    expect((await importSvg(svg('<rect width="5" height="5" fill="none" style="fill:red"/>'))).fills).toHaveLength(1);
    const lines = await importSvg(svg('<g fill="none" stroke="black"><rect width="5" height="5"/></g>'));
    expect([lines.fills.length, lines.lines.length]).toEqual([0, 1]);
    const inherit = await importSvg(svg('<g style="fill:none;stroke:blue"><rect width="5" height="5" fill="inherit"/></g>'));
    expect([inherit.fills.length, inherit.lines.length]).toEqual([0, 1]);
  });

  test("<style> rules: element, .class, #id and comma lists, by specificity", async () => {
    const css = `<style>
      /* comment */ rect { fill: none; stroke: black }
      .solid, #big { fill: #123 }
      circle { fill: none; stroke: none }
      .outline.thin { stroke: red; fill: none !important }
    </style>`;
    const g = await importSvg(svg(`${css}
      <rect width="1" height="1"/>
      <rect class="solid" x="10" width="1" height="1"/>
      <rect id="big" x="20" width="1" height="1"/>
      <circle class="other" cx="50" cy="50" r="1"/>
      <path class="outline thin" d="M0 20 L5 20"/>`));
    expect(g.fills).toHaveLength(2); // .solid and #big beat the element rule
    expect(g.lines).toHaveLength(2); // the plain rect and the compound-class path
    expect(g.warnings).toEqual(["1 shape was skipped: no fill and no stroke"]);
  });

  test("Illustrator-style file: entity namespace, CDATA <style> classes in defs, <switch>", async () => {
    const text = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
	<!ENTITY ns_svg "http://www.w3.org/2000/svg">
	<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;"
	 x="0px" y="0px" width="200px" height="100px" viewBox="0 0 200 100" style="enable-background:new 0 0 200 100;" xml:space="preserve">
<defs><style type="text/css"><![CDATA[
	.st0{fill:#231F20;}
	.st1{fill:none;stroke:#000000;stroke-miterlimit:10;}
]]></style></defs>
<switch>
	<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1"><i:aipgfRef xlink:href="#adobe_illustrator_pgf"/></foreignObject>
	<g i:extraneous="self">
		<rect x="0" y="0" class="st0" width="96" height="48"/>
		<polyline class="st1" points="100,0 196,0 196,96"/>
	</g>
</switch>
</svg>`;
    const g = await importSvg(text);
    expect(g.warnings).toEqual([]);
    expect(g.fills).toHaveLength(1);
    expect(g.lines).toHaveLength(1);
    expect(area(g)).toBeCloseTo(25.4 * 12.7, 6);
    expect(g.widthMm).toBeCloseTo(196 * (25.4 / 96), 6);
  });
});

// ---------------------------------------------------------------- SVG: structure

describe("SVG structure", () => {
  test("use with href and xlink:href, offset by x/y; the original in <defs> is not drawn", async () => {
    const g = await importSvg(svg(
      '<defs><rect id="r" width="10" height="10"/></defs><use href="#r" x="20"/><use xlink:href="#r" x="40" y="5"/>',
      `${MM} xmlns:xlink="http://www.w3.org/1999/xlink"`,
    ));
    expect(g.fills).toHaveLength(2);
    expect([g.widthMm, g.heightMm]).toEqual([30, 15]);
  });

  test("use inherits paint from the <use>, and a used <symbol> maps its viewBox", async () => {
    const g = await importSvg(svg(
      '<defs><circle id="c" cx="0" cy="0" r="1"/><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>' +
        '<use href="#c" fill="none" stroke="black"/><use href="#s" x="10" width="20" height="20"/>',
    ));
    expect(g.lines).toHaveLength(1);
    expect(area(g)).toBeCloseTo(400, 6);
    near(g.widthMm, 31, 0.01);
  });

  test("defs, clipPath, mask, unused symbol, marker, pattern, title, desc, metadata are not drawn", async () => {
    const hidden = ["defs", "clipPath", "mask", "symbol", "marker", "pattern", "title", "desc", "metadata"]
      .map(t => `<${t}><rect x="50" y="50" width="40" height="40"/></${t}>`).join("");
    const g = await importSvg(svg(`${hidden}<rect width="2" height="3"/>`));
    expect(g.fills).toHaveLength(1);
    expect([g.widthMm, g.heightMm]).toEqual([2, 3]);
  });

  test("display:none and visibility:hidden are skipped; a visible child of a hidden group is drawn", async () => {
    const g = await importSvg(svg(`<style>.gone{display:none}</style>
      <g style="display:none"><rect width="50" height="50"/></g>
      <rect display="none" width="50" height="50"/>
      <rect class="gone" width="50" height="50"/>
      <rect visibility="hidden" width="50" height="50"/>
      <g visibility="hidden"><rect x="60" width="50" height="50"/><rect visibility="visible" width="2" height="3"/></g>`));
    expect(g.fills).toHaveLength(1);
    expect([g.widthMm, g.heightMm]).toEqual([2, 3]);
  });

  test("text, image and foreignObject are skipped with warnings; clipping is noted", async () => {
    const g = await importSvg(svg(
      '<text x="0" y="10">Hi<tspan>there</tspan></text><text>2</text><image href="a.png" width="5" height="5"/>' +
        '<foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
        '<rect width="1" height="1" clip-path="url(#c)"/>',
    ));
    expect(g.warnings).toEqual([
      "2 text elements were skipped: convert text to paths first",
      "1 image was skipped: bitmap images cannot be marked as vectors",
      "1 embedded HTML block (foreignObject) was skipped",
      "1 clipping path or mask was ignored: the shapes are marked in full",
    ]);
    expect(g.fills).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- SVG: empty and malformed

describe("SVG empty and malformed files", () => {
  test("an empty file is empty geometry with a warning, not an error", async () => {
    for (const text of ["", "  \n", "﻿"]) {
      expect(await importSvg(text)).toEqual({ fills: [], lines: [], widthMm: 0, heightMm: 0, warnings: ["The file is empty."] });
    }
    const blank = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"/>');
    expect(blank.fills).toEqual([]);
    expect(blank.warnings).toEqual(["The file has no shapes that can be marked."]);
  });

  test("malformed input throws a clear ArtImportError", async () => {
    const cases: Array<[string, RegExp]> = [
      ["<svg><rect></svg>", /<\/svg> closes <rect> \(line 1\)/],
      ["<svg>\n<rect width='1'>", /<rect> is never closed/],
      ["this is not a drawing", /this is not XML/],
      ['<svg><rect width="1/></svg>', /never closed/],
      ["<html><body/></html>", /not an SVG file: the document is <html>/],
      ["<svg></svg><svg></svg>", /more than one root element/],
      ["<svg><!-- unfinished", /comment is never closed/],
    ];
    for (const [text, message] of cases) {
      const error = await importSvg(text).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ArtImportError);
      expect((error as Error).message).toMatch(message);
    }
  });

  test("a bad tolerance is a RangeError", async () => {
    await expect(importSvg(svg("<rect/>"), { toleranceMm: 0 })).rejects.toThrow(RangeError);
    await expect(importDxf("", { toleranceMm: Number.NaN })).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- DXF

type Pair = [number, string | number];
const ent = (type: string, ...pairs: Pair[]): Pair[] => [[0, type], [8, "0"], ...pairs];
const line = (x1: number, y1: number, x2: number, y2: number) => ent("LINE", [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]);
const circle = (x: number, y: number, r: number) => ent("CIRCLE", [10, x], [20, y], [30, 0], [40, r]);
const lwpolyline = (verts: Array<[number, number, number?]>, closed: boolean) =>
  ent("LWPOLYLINE", [90, verts.length], [70, closed ? 1 : 0], ...verts.flatMap(([x, y, b]): Pair[] => (b ? [[10, x], [20, y], [42, b]] : [[10, x], [20, y]])));
const spline = (degree: number, knots: number[], ctrl: Vec[], o: { weights?: number[]; flags?: number } = {}) =>
  ent(
    "SPLINE",
    [70, o.flags ?? 8],
    [71, degree],
    [72, knots.length],
    [73, ctrl.length],
    [74, 0],
    ...knots.map((k): Pair => [40, k]),
    ...(o.weights ?? []).map((w): Pair => [41, w]),
    ...ctrl.flatMap(([x, y]): Pair[] => [[10, x], [20, y], [30, 0]]),
  );

function dxf(entities: Pair[][], o: { units?: number; tables?: Pair[]; blocks?: Pair[]; eol?: string; pad?: boolean } = {}): string {
  const pairs: Pair[] = [];
  if (o.units !== undefined) pairs.push([0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1015"], [9, "$INSUNITS"], [70, o.units], [0, "ENDSEC"]);
  if (o.tables) pairs.push([0, "SECTION"], [2, "TABLES"], ...o.tables, [0, "ENDSEC"]);
  if (o.blocks) pairs.push([0, "SECTION"], [2, "BLOCKS"], ...o.blocks, [0, "ENDSEC"]);
  pairs.push([0, "SECTION"], [2, "ENTITIES"], ...entities.flat(), [0, "ENDSEC"], [0, "EOF"]);
  const eol = o.eol ?? "\n";
  return pairs.map(([c, v]) => `${o.pad ? String(c).padStart(3) : c}${eol}${o.pad ? ` ${v}` : v}`).join(eol) + eol;
}

/** A short line far down-left that pins the bounding box minimum at (−50, −50), so final = drawing + 50. */
const PIN = line(-50, -50, -49, -50);

describe("DXF", () => {
  test("lines in any order and direction are chained into a closed square (a fill)", async () => {
    const g = await importDxf(dxf([line(10, 10, 10, 0), line(0, 0, 10, 0), line(0, 10, 0, 0), line(10, 10, 0, 10)]));
    expect(g.fills).toHaveLength(1);
    expect(g.lines).toEqual([]);
    expect(area(g)).toBeCloseTo(100, 6);
    expect([g.widthMm, g.heightMm]).toEqual([10, 10]);
    expect(g.warnings).toEqual([]);
  });

  test("open chains stay lines; ends within 0.001 mm join, wider gaps do not", async () => {
    const u = await importDxf(dxf([line(0, 10, 0, 0), line(0, 0, 10, 0), line(10, 0.0005, 10, 10)]));
    expect(u.fills).toEqual([]);
    expect(u.lines.map(l => l.length)).toEqual([4]);
    const gap = await importDxf(dxf([line(0, 0, 10, 0), line(10, 0.01, 10, 10)]));
    expect(gap.lines).toHaveLength(2);
  });

  test("CRLF line ends and spaces around group codes", async () => {
    const g = await importDxf(dxf([line(0, 0, 5, 0), line(5, 0, 5, 5), line(5, 5, 0, 0)], { eol: "\r\n", pad: true }));
    expect(area(g)).toBeCloseTo(12.5, 6);
  });

  test("LWPOLYLINE: closed flag and bulge arcs (a half disc)", async () => {
    const tol = 0.0005;
    // Bulge 1 from (0,0) to (10,0) is a counter-clockwise half circle, dipping to y = −5.
    const g = await importDxf(dxf([lwpolyline([[0, 0, 1], [10, 0]], true)]), { toleranceMm: tol });
    expect(g.fills).toHaveLength(1);
    near(area(g), 12.5 * Math.PI, 5 * Math.PI * tol);
    expect(g.widthMm).toBeCloseTo(10, 6);
    near(g.heightMm, 5, tol);
    const open = await importDxf(dxf([lwpolyline([[0, 0], [10, 0, -0.5], [20, 0]], false)]));
    expect([open.fills.length, open.lines.length]).toEqual([0, 1]);
    // Bulge −0.5 (clockwise, θ = 4·atan(0.5)): sagitta = chord/2 · bulge = 2.5.
    near(open.heightMm, 2.5, 0.01);
  });

  test("POLYLINE / VERTEX / SEQEND with a bulge", async () => {
    const vertex = (x: number, y: number, bulge = 0): Pair[] => [[0, "VERTEX"], [8, "0"], [10, x], [20, y], [42, bulge]];
    const poly: Pair[] = [
      ...ent("POLYLINE", [66, 1], [70, 1]),
      ...vertex(0, 0), ...vertex(10, 0), ...vertex(10, 10, 1), ...vertex(0, 10),
      [0, "SEQEND"], [8, "0"],
    ];
    const tol = 0.0005;
    const g = await importDxf(dxf([poly]), { toleranceMm: tol });
    near(area(g), 100 + 12.5 * Math.PI, 5 * Math.PI * tol);
    near(g.heightMm, 15, tol);
  });

  test("nested circles: even-odd gives a ring with a hole, and an island inside it", async () => {
    const tol = 0.0005;
    const ring = await importDxf(dxf([circle(0, 0, 10), circle(0, 0, 5)]), { toleranceMm: tol });
    expect(ring.fills).toHaveLength(2);
    expect(area(ring)).toBeCloseTo(75 * Math.PI, 1);
    const island = await importDxf(dxf([circle(0, 0, 10), circle(0, 0, 5), circle(0, 0, 2)]), { toleranceMm: tol });
    expect(area(island)).toBeCloseTo(79 * Math.PI, 1);
    expect([ring.widthMm, ring.heightMm].map(v => +v.toFixed(3))).toEqual([20, 20]);
  });

  test("ARC: degrees, counter-clockwise, across 0°; chained with a line it closes", async () => {
    const tol = 0.0005;
    const arc = (a0: number, a1: number) => ent("ARC", [10, 5], [20, 0], [30, 0], [40, 5], [50, a0], [51, a1]);
    const dome = await importDxf(dxf([arc(0, 180), line(0, 0, 10, 0)]), { toleranceMm: tol });
    expect(dome.fills).toHaveLength(1);
    near(area(dome), 12.5 * Math.PI, 5 * Math.PI * tol);
    near(dome.heightMm, 5, tol);
    const right = await importDxf(dxf([arc(270, 90)]), { toleranceMm: tol }); // the right half
    expect(right.lines).toHaveLength(1);
    expect(right.widthMm).toBeCloseTo(5, 3);
    expect(right.heightMm).toBeCloseTo(10, 6);
  });

  test("ELLIPSE: whole (a fill) and partial (a line)", async () => {
    const tol = 0.0005;
    const ellipse = (t0?: number, t1?: number) =>
      ent("ELLIPSE", [10, 0], [20, 0], [30, 0], [11, 20], [21, 0], [31, 0], [40, 0.5], ...(t0 === undefined ? [] : [[41, t0], [42, t1!]] as Pair[]));
    const whole = await importDxf(dxf([ellipse()]), { toleranceMm: tol });
    expect(whole.fills).toHaveLength(1);
    expect(area(whole)).toBeCloseTo(200 * Math.PI, 1);
    expect([whole.widthMm, whole.heightMm].map(v => +v.toFixed(3))).toEqual([40, 20]);
    const half = await importDxf(dxf([ellipse(0, Math.PI)]), { toleranceMm: tol });
    expect(half.lines).toHaveLength(1);
    expect(half.widthMm).toBeCloseTo(40, 6);
    near(half.heightMm, 10, tol);
  });

  test("SPLINE: a quadratic B-spline is the parabola y = x², within the tolerance", async () => {
    const tol = 0.01;
    const g = await importDxf(dxf([PIN, spline(2, [0, 0, 0, 1, 1, 1], [[-1, 1], [0, -1], [1, 1]])]), { toleranceMm: tol });
    const curve = g.lines.find(l => l.length > 2)!.map(([x, y]) => [x - 50, y - 50] as Vec);
    expect(curve[0]).toEqual([-1, 1]);
    for (const [x, y] of curve) expect(y).toBeCloseTo(x * x, 6);
    expect(chordError(curve, t => [2 * t - 1, (2 * t - 1) ** 2])).toBeLessThanOrEqual(tol);
    // |C''| = 8 over the one span: ⌈√(8 / 8·tol)⌉ = 10 chords.
    expect(curve).toHaveLength(11);
  });

  test("SPLINE: a clamped cubic with one span is the Bézier of its control points", async () => {
    const tol = 0.01;
    const ctrl: Vec[] = [[0, 0], [0, 10], [10, 10], [10, 0]];
    const g = await importDxf(dxf([PIN, spline(3, [0, 0, 0, 0, 1, 1, 1, 1], ctrl)]), { toleranceMm: tol });
    const curve = g.lines.find(l => l.length > 2)!.map(([x, y]) => [x - 50, y - 50] as Vec);
    const bezier = (t: number): Vec => {
      const s = 1 - t;
      return [10 * (3 * s * t * t + t * t * t), 30 * s * s * t + 30 * s * t * t];
    };
    expect(chordError(curve, bezier)).toBeLessThanOrEqual(tol);
    expect(curve.at(-1)).toEqual([10, 0]);
  });

  test("SPLINE: a rational (NURBS) circle closes on itself and stays on the circle", async () => {
    const tol = 0.01, w = Math.SQRT1_2;
    const ctrl: Vec[] = [[10, 0], [10, 10], [0, 10], [-10, 10], [-10, 0], [-10, -10], [0, -10], [10, -10], [10, 0]];
    const knots = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];
    const g = await importDxf(dxf([PIN, spline(2, knots, ctrl, { weights: [1, w, 1, w, 1, w, 1, w, 1], flags: 8 | 4 | 1 })]), { toleranceMm: tol });
    expect(g.fills).toHaveLength(1);
    const ring = g.fills[0]!.map(([x, y]) => [x - 50, y - 50] as Vec);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 6);
      expect(10 - Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)).toBeLessThanOrEqual(tol + 1e-6);
    }
    expect(area(g)).toBeCloseTo(100 * Math.PI, 0);
  });

  test("SPLINE with fit points only passes through them", async () => {
    const fit: Vec[] = [[0, 0], [10, 5], [20, 0], [30, 5]];
    const g = await importDxf(dxf([PIN, ent("SPLINE", [70, 8], [71, 3], [74, fit.length], ...fit.flatMap(([x, y]): Pair[] => [[11, x], [21, y], [31, 0]]))]));
    const curve = g.lines.find(l => l.length > 2)!.map(([x, y]) => [+(x - 50).toFixed(6), +(y - 50).toFixed(6)]);
    for (const p of fit) expect(curve).toContainEqual(p);
  });

  test("INSERT places a block with insert point, scale, rotation and base point", async () => {
    const square = lwpolyline([[0, 0], [10, 0], [10, 10], [0, 10]], true);
    const blocks: Pair[] = [[0, "BLOCK"], [8, "0"], [2, "SQ"], [70, 0], [10, 0], [20, 0], [30, 0], ...square, [0, "ENDBLK"]];
    const insert = (x: number, y: number, s: number, rot: number) => ent("INSERT", [2, "SQ"], [10, x], [20, y], [30, 0], [41, s], [42, s], [50, rot]);
    // (x, y) → (100 − 2y, 2x): x 80..100, y 0..20.
    const g = await importDxf(dxf([insert(0, 0, 1, 0), insert(100, 0, 2, 90)], { blocks }));
    expect(g.fills).toHaveLength(2);
    expect(area(g)).toBeCloseTo(500, 6);
    expect(g.widthMm).toBeCloseTo(100, 6);
    expect(g.heightMm).toBeCloseTo(20, 6);
    const based: Pair[] = [[0, "BLOCK"], [8, "0"], [2, "SQ"], [70, 0], [10, 10], [20, 0], [30, 0], ...square, [0, "ENDBLK"]];
    const b = await importDxf(dxf([insert(0, 0, 1, 0), circle(0, 0, 1)], { blocks: based }));
    expect(b.widthMm).toBeCloseTo(11, 3); // block square moved to x −10..0, circle to +1
  });

  test.each([
    [1, 25.4],
    [4, 1],
    [5, 10],
    [6, 1000],
    [0, 1],
    [undefined, 1],
  ])("$INSUNITS %p scales a unit square to %d mm", async (units, mm) => {
    const g = await importDxf(dxf([lwpolyline([[0, 0], [1, 0], [1, 1], [0, 1]], true)], units === undefined ? {} : { units }));
    expect(g.widthMm).toBeCloseTo(mm, 6);
    expect(area(g)).toBeCloseTo(mm * mm, 6);
  });

  test("unknown entities are counted in a warning; POINT is ignored", async () => {
    const g = await importDxf(dxf([
      line(0, 0, 1, 0),
      ent("TEXT", [10, 0], [20, 0], [40, 2], [1, "hello"]),
      ent("TEXT", [10, 0], [20, 0], [40, 2], [1, "world"]),
      ent("MTEXT", [10, 0], [20, 0], [1, "x"]),
      ent("HATCH", [2, "SOLID"]),
      ent("DIMENSION", [2, "*D1"]),
      ent("3DFACE", [10, 0], [20, 0]),
      ent("POINT", [10, 5], [20, 5]),
    ]));
    expect(g.lines).toHaveLength(1);
    expect(g.warnings).toEqual([
      "6 entities were skipped (2 TEXT, 1 MTEXT, 1 HATCH, 1 DIMENSION, 1 3DFACE): only lines, arcs, circles, ellipses, polylines and splines can be marked; explode text, hatches and dimensions into outlines first",
    ]);
  });

  test("entities on hidden layers are skipped", async () => {
    const tables: Pair[] = [[0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "Hidden"], [70, 0], [62, -7], [0, "ENDTAB"]];
    const g = await importDxf(dxf([circle(0, 0, 1), [...line(0, 0, 50, 0).map((p): Pair => (p[0] === 8 ? [8, "Hidden"] : p))]], { tables }));
    expect(g.lines).toEqual([]);
    expect(g.warnings).toEqual(["1 entity was skipped: on a hidden or frozen layer"]);
  });

  test("an empty file is empty geometry with a warning, not an error", async () => {
    expect(await importDxf("")).toEqual({ fills: [], lines: [], widthMm: 0, heightMm: 0, warnings: ["The file is empty."] });
    const none = await importDxf(dxf([]));
    expect(none.fills).toEqual([]);
    expect(none.warnings).toEqual(["The file has no shapes that can be marked."]);
  });

  test("malformed input throws a clear ArtImportError", async () => {
    const cases: Array<[string, RegExp]> = [
      ["hello\nworld\n", /line 1 should be a group code/],
      ["0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nabc\n20\n0\n0\nENDSEC\n0\nEOF\n", /line 8 should be a number \(group code 10\) but reads "abc"/],
      ["0\nSECTION\n2\n", /ends in the middle of a group/],
      ["999\njust a comment\n", /has no SECTION/],
      ["AutoCAD Binary DXF\r\n\u001a\u0000", /binary DXF is not supported/],
    ];
    for (const [text, message] of cases) {
      const error = await importDxf(text).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ArtImportError);
      expect((error as Error).message).toMatch(message);
    }
  });

  test("far-away coordinates (survey style) are moved to the origin without losing precision", async () => {
    const x = 4.5e6, y = 5.6e6; // metres-scale coordinates written in mm
    const g = await importDxf(dxf([line(x, y, x + 10, y), line(x + 10, y, x + 10, y + 10), line(x + 10, y + 10, x, y + 10), line(x, y + 10, x, y)]));
    expect(area(g)).toBeCloseTo(100, 6);
    expect([g.widthMm, g.heightMm]).toEqual([10, 10]);
  });
});

describe("importArt", () => {
  test("dispatches on the format", async () => {
    expect((await importArt(svg('<rect width="3" height="4"/>'), "svg")).widthMm).toBe(3);
    expect((await importArt(dxf([line(0, 0, 7, 0)]), "dxf")).widthMm).toBe(7);
    await expect(importArt("", "pdf" as "svg")).rejects.toThrow(ArtImportError);
  });

  test("a tighter tolerance gives more points", async () => {
    const text = svg('<circle cx="50" cy="50" r="40" fill="none" stroke="black"/>');
    const coarse = (await importArt(text, "svg", { toleranceMm: 0.1 })).lines[0]!.length;
    const fine = (await importArt(text, "svg", { toleranceMm: 0.001 })).lines[0]!.length;
    expect(fine).toBeGreaterThan(coarse * 5);
  });
});

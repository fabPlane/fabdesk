/**
 * Turns a copper-removal job (polygons in mm) into LMC list packets: hatch fill (serpentine scan lines,
 * cross-hatch per pass), optional outlines, and a red-light frame for previewing the position.
 *
 * Coordinates: the job is in mm with the origin at the board's bottom-left corner, Y up (as
 * export_laser_copper writes it). The board is placed so its centre lands on `field.centerMm` (mm from the
 * lens field centre), then mapped to galvo units (0..0xFFFF across `field.sizeMm`).
 */
import { GALVO_CENTER, GALVO_MAX, List, ListPackets, signedDelay } from "./protocol";

export type Vec = [number, number];
export type Ring = Vec[];
/** Polygons as rings; filled with the even-odd rule (holes are just more rings). */
export type Shape = Ring[];

export type FieldMap = {
  /** Lens field width/height in mm (70 or 150 on the Omni X). */
  sizeMm: number;
  /** Where the board centre sits, in mm from the field centre (the jig position). */
  centerMm: Vec;
  /** Board size in mm, to find its centre. */
  boardMm: { width: number; height: number };
  /** Galvo axis conventions; unverified on the Omni X, so they are settings. */
  flipX?: boolean;
  flipY?: boolean;
  swapXY?: boolean;
};

export type MarkSettings = {
  powerPct: number;
  speedMmPerS: number;
  travelMmPerS: number;
  frequencyKhz: number;
  passes: number;
  /** Hatch spacing; 0 = outline only. */
  intervalMm: number;
  angleDeg: number;
  /** Added to the angle each pass (90 = cross-hatch). */
  angleStepDeg: number;
  laserOnDelayUs: number;
  laserOffDelayUs: number;
  polygonDelayUs: number;
  jumpDelayUs: number;
};

/** How the board takes power and frequency. Unverified for the Omni X UV source. */
export type SourceMode = "co2" | "fiber";

export type Pins = { laser: number; light: number };

export const galvosPerMm = (field: FieldMap) => GALVO_MAX / field.sizeMm;

/** mm in job coordinates → galvo units; throws when outside the lens field. */
export function toGalvo(field: FieldMap, [x, y]: Vec): Vec {
  const k = galvosPerMm(field);
  let fx = x - field.boardMm.width / 2 + field.centerMm[0];
  let fy = y - field.boardMm.height / 2 + field.centerMm[1];
  if (field.swapXY) [fx, fy] = [fy, fx];
  if (field.flipX) fx = -fx;
  if (field.flipY) fy = -fy;
  const gx = Math.round(GALVO_CENTER + fx * k);
  const gy = Math.round(GALVO_CENTER + fy * k);
  if (gx < 0 || gx > GALVO_MAX || gy < 0 || gy > GALVO_MAX) {
    throw new RangeError(`point (${x.toFixed(2)}, ${y.toFixed(2)}) mm is outside the ${field.sizeMm} mm lens field`);
  }
  return [gx, gy];
}

// ---------------------------------------------------------------- hatch geometry (mm)

export type Segment = [Vec, Vec];

const rotate = ([x, y]: Vec, a: number): Vec => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/**
 * Even-odd scan lines through `shape` every `intervalMm`, at `angleDeg`, alternating direction
 * (serpentine) so the galvo never jumps back across the field.
 */
export function hatch(shape: Shape, intervalMm: number, angleDeg: number): Segment[] {
  return [...hatchLines(shape, intervalMm, angleDeg)];
}

/** {@link hatch} as a generator, so huge jobs never hold every line in memory. */
export function* hatchLines(shape: Shape, intervalMm: number, angleDeg: number): Generator<Segment> {
  if (!(intervalMm > 0)) return;
  const a = (angleDeg * Math.PI) / 180;
  const rings = shape.filter(r => r.length >= 3).map(r => r.map(p => rotate(p, -a)));
  if (!rings.length) return;
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const [, y] of r) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  // Edges sorted by their lowest y: each scan line only looks at the edges it can cross.
  const edges: Array<[number, number, number, number]> = [];
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [x1, y1] = r[j]!, [x2, y2] = r[i]!;
    if (y1 !== y2) edges.push(y1 < y2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1]);
  }
  edges.sort((a, b) => a[1] - b[1]);
  let active: Array<[number, number, number, number]> = [];
  let nextEdge = 0;
  let forward = true;
  const lines = Math.max(0, Math.ceil((maxY - minY) / intervalMm));
  for (let n = 0; n < lines; n++) {
    const y = minY + intervalMm / 2 + n * intervalMm;
    if (y >= maxY) break;
    while (nextEdge < edges.length && edges[nextEdge]![1] <= y) active.push(edges[nextEdge++]!);
    active = active.filter(e => e[3] > y);
    // Half-open rule (lower end included, upper end excluded): a vertex on the scan line is counted once.
    const xs: number[] = [];
    for (const [x1, y1, x2, y2] of active) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row: Segment[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > 1e-4) row.push([[xs[k]!, y], [xs[k + 1]!, y]]);
    if (!forward) { row.reverse(); for (const s of row) s.reverse(); }
    forward = !forward;
    for (const [p, q] of row) yield [rotate(p, a), rotate(q, a)];
  }
}

/**
 * Hatch angles of one pass. A 90° step is cross-hatch: every pass fills both directions, as LightBurn's
 * "Crosshatch" and Studio's "Cross fill" do, so a job does the same work on every laser route.
 */
export function passAngles(s: Pick<MarkSettings, "angleDeg" | "angleStepDeg">, pass: number): number[] {
  return s.angleStepDeg === 90 ? [s.angleDeg, s.angleDeg + 90] : [s.angleDeg + pass * s.angleStepDeg];
}

/** Closed outlines as segments. */
export function outlines(shape: Shape): Segment[] {
  const out: Segment[] = [];
  for (const r of shape) for (let i = 0; i < r.length; i++) out.push([r[i]!, r[(i + 1) % r.length]!]);
  return out;
}

/** Open polylines as segments. */
export function polylines(lines: Ring[]): Segment[] {
  const out: Segment[] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) out.push([l[i - 1]!, l[i]!]);
  return out;
}

const dist2 = (a: Vec, b: Vec) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/**
 * Paths in a short travel order: serpentine strips across the job by path centre, then each closed ring is
 * started at its vertex nearest the pen and each open line is drawn from its nearer end. Cuts the jumps of
 * outline passes on boards with hundreds of pads from criss-crossing the board to short hops.
 */
export function orderPaths(paths: Ring[], closed: boolean, from: Vec | null): Ring[] {
  const usable = paths.filter(p => p.length >= (closed ? 3 : 2));
  const centres = usable.map(p => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of p) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return [(minX + maxX) / 2, (minY + maxY) / 2] as Vec;
  });
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const [x, y] of centres) { if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const strip = Math.max(1e-6, Math.sqrt(((maxX - minX + 1) * (maxY - minY + 1)) / Math.max(1, usable.length)) * 2);
  const order = usable.map((_, i) => i).sort((a, b) => {
    const sa = Math.floor((centres[a]![1] - minY) / strip), sb = Math.floor((centres[b]![1] - minY) / strip);
    if (sa !== sb) return sa - sb;
    return sa % 2 === 0 ? centres[a]![0] - centres[b]![0] : centres[b]![0] - centres[a]![0];
  });
  const out: Ring[] = [];
  let pen = from;
  for (const i of order) {
    const p = usable[i]!;
    if (closed) {
      let best = 0;
      if (pen) { let d = Infinity; for (let k = 0; k < p.length; k++) { const dk = dist2(p[k]!, pen); if (dk < d) { d = dk; best = k; } } }
      const r = best ? [...p.slice(best), ...p.slice(0, best)] : p;
      out.push(r);
      pen = r[0]!;
    } else {
      const flip = pen !== null && dist2(p.at(-1)!, pen) < dist2(p[0]!, pen);
      const l = flip ? [...p].reverse() : p;
      out.push(l);
      pen = l.at(-1)!;
    }
  }
  return out;
}

const length = ([p, q]: Segment) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Rough marking time: marked length at mark speed + travel at jump speed, per pass. */
export function estimateSeconds(segmentsPerPass: Segment[][], s: Pick<MarkSettings, "speedMmPerS" | "travelMmPerS">): number {
  let t = 0;
  let last: Vec | null = null; // segments are in mm: the pen's start is not known here
  for (const segs of segmentsPerPass) {
    for (const seg of segs) {
      if (last) t += Math.hypot(seg[0][0] - last[0], seg[0][1] - last[1]) / s.travelMmPerS;
      t += length(seg) / s.speedMmPerS;
      last = seg[1];
    }
  }
  return t;
}

// ---------------------------------------------------------------- list building

/**
 * Range check for marking settings. Out-of-range values are refused, never wrapped or clamped: a wrapped
 * frequency period or a zero speed silently becomes a far higher dose of UV on the board.
 */
export function validateSettings(s: MarkSettings): void {
  const bad = (what: string) => { throw new RangeError(`laser setting out of range: ${what}`); };
  if (!(s.powerPct >= 0 && s.powerPct <= 100)) bad(`power ${s.powerPct} % (0–100)`);
  if (!(s.frequencyKhz >= 1 && s.frequencyKhz <= 1000)) bad(`frequency ${s.frequencyKhz} kHz (1–1000)`);
  if (!(s.speedMmPerS >= 1 && s.speedMmPerS <= 20000)) bad(`speed ${s.speedMmPerS} mm/s (1–20000)`);
  if (!(s.travelMmPerS >= 1 && s.travelMmPerS <= 20000)) bad(`travel speed ${s.travelMmPerS} mm/s (1–20000)`);
  if (!(Number.isInteger(s.passes) && s.passes >= 1 && s.passes <= 200)) bad(`passes ${s.passes} (1–200)`);
  if (!(s.intervalMm === 0 || (s.intervalMm >= 0.001 && s.intervalMm <= 10))) bad(`line spacing ${s.intervalMm} mm (0, or 0.001–10)`);
  for (const [k, v] of [["laser-on delay", s.laserOnDelayUs], ["laser-off delay", s.laserOffDelayUs], ["polygon delay", s.polygonDelayUs], ["jump delay", s.jumpDelayUs]] as const) {
    if (!(Math.abs(v) <= 0xffff)) bad(`${k} ${v} µs`);
  }
}

const speedUnits = (field: FieldMap, mmPerS: number) => {
  const units = Math.round((mmPerS * galvosPerMm(field)) / 1000);
  // Refused, not clamped: a clamped speed is a slower speed, i.e. more UV on the board.
  if (units > 0xffff) throw new RangeError(`laser setting out of range: speed ${mmPerS} mm/s is too fast for a ${field.sizeMm} mm lens field`);
  return Math.max(1, units);
};

function writeSettings(list: ListPackets, field: FieldMap, s: MarkSettings, source: SourceMode) {
  list.add(List.JumpSpeed, speedUnits(field, s.travelMmPerS));
  const power = Math.max(0, Math.min(100, s.powerPct));
  if (source === "fiber") {
    list.add(List.QSwitchPeriod, Math.round(20000 / s.frequencyKhz) & 0xffff);
    list.add(List.MarkCurrent, Math.round((power * 0xfff) / 100));
  } else {
    list.add(List.MarkFreq, Math.round(10000 / s.frequencyKhz) & 0xffff);
    list.add(List.MarkPowerRatio, Math.min(0xffff, Math.round((200 * power) / s.frequencyKhz)));
  }
  list.add(List.MarkSpeed, speedUnits(field, s.speedMmPerS));
  list.add(List.LaserOnDelay, ...signedDelay(s.laserOnDelayUs));
  list.add(List.LaserOffDelay, ...signedDelay(s.laserOffDelayUs));
  list.add(List.PolygonDelay, ...signedDelay(s.polygonDelayUs));
  list.add(List.JumpDelay, ...signedDelay(s.jumpDelayUs));
}

function addMoves(list: ListPackets, field: FieldMap, segs: Segment[], mark: boolean, from: Vec | null): Vec | null {
  let last = from;
  for (const [p, q] of segs) {
    const a = toGalvo(field, p), b = toGalvo(field, q);
    if (!last || last[0] !== a[0] || last[1] !== a[1]) {
      list.add(List.JumpTo, a[0], a[1], 0, Math.min(0xffff, last ? Math.round(Math.hypot(a[0] - last[0], a[1] - last[1])) : 0));
    }
    list.add(mark ? List.MarkTo : List.JumpTo, b[0], b[1], 0, Math.min(0xffff, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]))));
    last = b;
  }
  return last;
}

/** Throws before anything is sent when part of the job falls outside the lens field. */
export function assertInField(shape: Shape, field: FieldMap): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of shape) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!Number.isFinite(minX)) throw new RangeError("the job is empty");
  for (const p of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as Vec[]) toGalvo(field, p);
}

/**
 * The marking list as a stream of 3072-byte packets, built while it is sent: a large board (over a million
 * commands) starts marking at once instead of after the whole list has been built in memory.
 */
/** Extra parts of a job beyond the fill: lines (drawings) and outline passes with their own settings (edges). */
export type MarkExtras = { outline?: boolean; lines?: Ring[]; edge?: { settings: MarkSettings; passes: number } };

/** Pen position in mm, for travel ordering, from the last galvo position. */
const penMm = (field: FieldMap, g: Vec | null): Vec | null => {
  if (!g) return null;
  const k = galvosPerMm(field);
  let fx = (g[0] - GALVO_CENTER) / k, fy = (g[1] - GALVO_CENTER) / k;
  if (field.flipX) fx = -fx;
  if (field.flipY) fy = -fy;
  if (field.swapXY) [fx, fy] = [fy, fx];
  return [fx + field.boardMm.width / 2 - field.centerMm[0], fy + field.boardMm.height / 2 - field.centerMm[1]];
};

const ringSegments = (rings: Ring[], closed: boolean): Segment[] => (closed ? outlines(rings) : polylines(rings));

export function* markPackets(shape: Shape, field: FieldMap, s: MarkSettings, opts: { source: SourceMode; pins: Pins } & MarkExtras): Generator<Uint8Array> {
  validateSettings(s);
  if (opts.edge) validateSettings(opts.edge.settings);
  const lines = (opts.lines ?? []).filter(l => l.length >= 2);
  assertInField([...shape, ...lines], field);
  const list = new ListPackets();
  list.add(List.ReadyMark);
  list.add(List.WritePort, 1 << opts.pins.laser);
  writeSettings(list, field, s, opts.source);
  let last: Vec | null = [GALVO_CENTER, GALVO_CENTER];
  const trace = (paths: Ring[], closed: boolean) => {
    for (const p of orderPaths(paths, closed, penMm(field, last))) last = addMoves(list, field, ringSegments([p], closed), true, last);
  };
  for (let pass = 0; pass < s.passes; pass++) {
    for (const angle of passAngles(s, pass)) {
      for (const seg of hatchLines(shape, s.intervalMm, angle)) {
        last = addMoves(list, field, [seg], true, last);
        yield* list.takeFull();
      }
    }
    if ((opts.outline || s.intervalMm <= 0) && !opts.edge) { trace(shape, true); yield* list.takeFull(); }
    if (lines.length) { trace(lines, false); yield* list.takeFull(); }
  }
  if (opts.edge && opts.edge.passes > 0) {
    writeSettings(list, field, opts.edge.settings, opts.source);
    for (let pass = 0; pass < opts.edge.passes; pass++) { trace(shape, true); yield* list.takeFull(); }
  }
  list.add(List.WritePort, 0);
  yield* list.finish();
}

export type MarkJob = {
  packets: Uint8Array[];
  /** Commands including the end-of-list. */
  commands: number;
  segments: number;
  estimatedSeconds: number;
};

/** The marking list: settings, then hatch (and outlines) per pass, laser pin on for the whole list. */
export function buildMarkJob(shape: Shape, field: FieldMap, s: MarkSettings, opts: { source: SourceMode; pins: Pins; outline?: boolean }): MarkJob {
  validateSettings(s);
  const list = new ListPackets();
  list.add(List.ReadyMark);
  list.add(List.WritePort, 1 << opts.pins.laser);
  writeSettings(list, field, s, opts.source);
  const perPass: Segment[][] = [];
  let last: Vec | null = [GALVO_CENTER, GALVO_CENTER];
  for (let pass = 0; pass < s.passes; pass++) {
    const segs = [...passAngles(s, pass).flatMap(angle => hatch(shape, s.intervalMm, angle)), ...(opts.outline || s.intervalMm <= 0 ? outlines(shape) : [])];
    perPass.push(segs);
    last = addMoves(list, field, segs, true, last);
  }
  list.add(List.WritePort, 0);
  const packets = list.finish();
  return { packets, commands: list.commandCount, segments: perPass.reduce((n, p) => n + p.length, 0), estimatedSeconds: estimateSeconds(perPass, s) };
}

/** Red-light frame around the job's bounds, traced `loops` times; the laser pin stays off. */
export function buildLightFrame(shape: Shape, field: FieldMap, opts: { pins: Pins; travelMmPerS: number; loops: number }): MarkJob {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of shape) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!Number.isFinite(minX)) throw new RangeError("nothing to frame");
  const box: Ring = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  const list = new ListPackets();
  list.add(List.ReadyMark);
  list.add(List.WritePort, 1 << opts.pins.light);
  list.add(List.JumpSpeed, speedUnits(field, opts.travelMmPerS));
  list.add(List.JumpDelay, ...signedDelay(8));
  let last: Vec | null = [GALVO_CENTER, GALVO_CENTER];
  const segs = outlines([box]);
  for (let i = 0; i < Math.max(1, opts.loops); i++) last = addMoves(list, field, segs, false, last);
  list.add(List.WritePort, 0);
  const packets = list.finish();
  return { packets, commands: list.commandCount, segments: segs.length * opts.loops, estimatedSeconds: estimateSeconds([segs], { speedMmPerS: opts.travelMmPerS, travelMmPerS: opts.travelMmPerS }) * opts.loops };
}

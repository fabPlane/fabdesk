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
  if (!(intervalMm > 0)) return [];
  const a = (angleDeg * Math.PI) / 180;
  const rings = shape.filter(r => r.length >= 3).map(r => r.map(p => rotate(p, -a)));
  if (!rings.length) return [];
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const [, y] of r) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const out: Segment[] = [];
  let forward = true;
  for (let y = minY + intervalMm / 2; y < maxY; y += intervalMm) {
    const xs: number[] = [];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, y1] = r[j]!, [x2, y2] = r[i]!;
        // Half-open rule: a vertex on the scan line is counted once.
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row: Segment[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > 1e-4) row.push([[xs[k]!, y], [xs[k + 1]!, y]]);
    if (!forward) { row.reverse(); for (const s of row) s.reverse(); }
    forward = !forward;
    for (const [p, q] of row) out.push([rotate(p, a), rotate(q, a)]);
  }
  return out;
}

/** Closed outlines as segments. */
export function outlines(shape: Shape): Segment[] {
  const out: Segment[] = [];
  for (const r of shape) for (let i = 0; i < r.length; i++) out.push([r[i]!, r[(i + 1) % r.length]!]);
  return out;
}

const length = ([p, q]: Segment) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Rough marking time: marked length at mark speed + travel at jump speed, per pass. */
export function estimateSeconds(segmentsPerPass: Segment[][], s: Pick<MarkSettings, "speedMmPerS" | "travelMmPerS">): number {
  let t = 0;
  for (const segs of segmentsPerPass) {
    let last: Vec | null = null;
    for (const seg of segs) {
      if (last) t += Math.hypot(seg[0][0] - last[0], seg[0][1] - last[1]) / s.travelMmPerS;
      t += length(seg) / s.speedMmPerS;
      last = seg[1];
    }
  }
  return t;
}

// ---------------------------------------------------------------- list building

const speedUnits = (field: FieldMap, mmPerS: number) => Math.min(0xffff, Math.max(1, Math.round((mmPerS * galvosPerMm(field)) / 1000)));

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

export type MarkJob = {
  packets: Uint8Array[];
  /** Commands including the end-of-list. */
  commands: number;
  segments: number;
  estimatedSeconds: number;
};

/** The marking list: settings, then hatch (and outlines) per pass, laser pin on for the whole list. */
export function buildMarkJob(shape: Shape, field: FieldMap, s: MarkSettings, opts: { source: SourceMode; pins: Pins; outline?: boolean }): MarkJob {
  if (!(s.passes >= 1)) throw new RangeError("passes must be at least 1");
  const list = new ListPackets();
  list.add(List.ReadyMark);
  list.add(List.WritePort, 1 << opts.pins.laser);
  writeSettings(list, field, s, opts.source);
  const perPass: Segment[][] = [];
  let last: Vec | null = null;
  for (let pass = 0; pass < s.passes; pass++) {
    const segs = [...hatch(shape, s.intervalMm, s.angleDeg + pass * s.angleStepDeg), ...(opts.outline || s.intervalMm <= 0 ? outlines(shape) : [])];
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
  let last: Vec | null = null;
  const segs = outlines([box]);
  for (let i = 0; i < Math.max(1, opts.loops); i++) last = addMoves(list, field, segs, false, last);
  list.add(List.WritePort, 0);
  const packets = list.finish();
  return { packets, commands: list.commandCount, segments: segs.length * opts.loops, estimatedSeconds: estimateSeconds([segs], { speedMmPerS: opts.travelMmPerS, travelMmPerS: opts.travelMmPerS }) * opts.loops };
}

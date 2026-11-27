/**
 * fabPlane laser job files (`<stem>.lmc.json`): what the USB / Wi-Fi driver marks.
 *
 * A job is either a board side (written by export_laser_copper: copper to remove + edge clean-up passes) or
 * an imported drawing (SVG / DXF: filled shapes + lines). Coordinates are mm with the origin at the job's
 * bottom-left corner, Y up; the job's centre is placed at `positionMm` on the lens field (mm from the
 * field centre), or at the cell's board centre when the job does not say.
 *
 * This module only reads, checks, changes and previews job files; ./job.ts turns them into laser commands.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { hatchLines, passAngles, type Ring, type Vec } from "./job";

/** Delays and jump speed the driver uses; also what the time estimate assumes. */
export const DEFAULT_TIMING = { travelMmPerS: 2000, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };

const num = z.number().refine(Number.isFinite, "must be a number");
const vec = z.tuple([num, num]);

export const JobSettingsSchema = z.object({
  powerPct: num.min(0).max(100),
  speedMmPerS: num.min(1).max(20000),
  frequencyKhz: num.min(1).max(1000),
  passes: z.number().int().min(1).max(200),
  /** Fill line spacing; 0 = no fill (outlines only). */
  intervalMm: num.min(0).max(10),
  angleDeg: num.min(-360).max(360),
  /** Added to the angle each pass; 90 = cross-hatch (both directions every pass). */
  angleStepDeg: num.min(-360).max(360),
});
export type JobSettings = z.infer<typeof JobSettingsSchema>;

/** Outline passes after the fill (clean copper edges; the outline of a drawing). */
export const EdgeSettingsSchema = z.object({
  powerPct: num.min(0).max(100),
  speedMmPerS: num.min(1).max(20000),
  frequencyKhz: num.min(1).max(1000),
  passes: z.number().int().min(0).max(200),
});
export type EdgeSettings = z.infer<typeof EdgeSettingsSchema>;

export const LmcJobFileSchema = z.object({
  name: z.string().max(200).optional(),
  source: z.enum(["board", "file"]).optional(),
  boardMm: z.object({ width: num.positive(), height: num.positive() }),
  /** Shapes to fill (rings, even-odd: holes are just more rings). */
  ablate: z.array(z.array(vec)),
  /** Lines to mark (open or closed polylines); never filled. */
  lines: z.array(z.array(vec)).optional(),
  settings: JobSettingsSchema,
  edge: EdgeSettingsSchema.optional(),
  /** Job centre on the lens field, mm from the field centre. */
  positionMm: z.object({ x: num, y: num }).optional(),
});
export type LmcJob = z.infer<typeof LmcJobFileSchema>;

export class LaserJobError extends Error {
  override name = "LaserJobError";
}

/** Reads and checks a job file; the message says what to do when it is not a usable job. */
export async function readJob(path: string): Promise<LmcJob> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LaserJobError(`the laser job ${path} does not exist: make the laser job again`);
    throw new LaserJobError(`${path} is not a fabPlane laser job (${error instanceof Error ? error.message : String(error)}); make the laser job again`);
  }
  const parsed = LmcJobFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new LaserJobError(`${path} is not a usable laser job (${first ? `${first.path.join(".")}: ${first.message}` : "invalid"}); make the laser job again`);
  }
  if (!parsed.data.ablate.some(r => r.length >= 3) && !(parsed.data.lines ?? []).some(l => l.length >= 2)) throw new LaserJobError(`the laser job ${path} is empty`);
  return parsed.data;
}

/** Writes a job file whole or not at all (a crash mid-write never leaves half a job). */
export async function writeJob(path: string, job: LmcJob): Promise<void> {
  const checked = LmcJobFileSchema.parse(job);
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(checked));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------- geometry helpers

type Box = { minX: number; minY: number; maxX: number; maxY: number };

export function jobBounds(job: Pick<LmcJob, "ablate" | "lines">): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of [...job.ablate, ...(job.lines ?? [])]) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

const polyLength = (pts: Vec[], closed: boolean) => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed && pts.length > 2) len += Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]);
  return len;
};

/**
 * Marking time: fill lines and outlines at mark speed, jumps at travel speed, plus the board's fixed delays
 * per line (laser on/off, jump settle, corner). Walks the fill lines without building any commands.
 */
export function estimateJobSeconds(job: Pick<LmcJob, "ablate" | "lines" | "settings" | "edge">, timing = DEFAULT_TIMING): number {
  const s = job.settings;
  const perLine = (timing.laserOnDelayUs + timing.laserOffDelayUs + timing.jumpDelayUs) / 1e6;
  let t = 0;
  let last: Vec | null = null;
  const jump = (to: Vec) => { if (last) t += Math.hypot(to[0] - last[0], to[1] - last[1]) / timing.travelMmPerS; };
  const rings = job.ablate.filter(r => r.length >= 3);
  const lines = (job.lines ?? []).filter(l => l.length >= 2);
  const outlinePass = (speed: number) => {
    for (const r of rings) { jump(r[0]!); t += polyLength(r, true) / speed + perLine + (r.length * timing.polygonDelayUs) / 1e6; last = r[0]!; }
  };
  for (let pass = 0; pass < s.passes; pass++) {
    for (const angle of passAngles(s, pass)) {
      for (const [p, q] of hatchLines(rings, s.intervalMm, angle)) { jump(p); t += Math.hypot(q[0] - p[0], q[1] - p[1]) / s.speedMmPerS + perLine; last = q; }
    }
    if (s.intervalMm <= 0 && !job.edge) outlinePass(s.speedMmPerS);
    for (const l of lines) { jump(l[0]!); t += polyLength(l, false) / s.speedMmPerS + perLine + (l.length * timing.polygonDelayUs) / 1e6; last = l.at(-1)!; }
  }
  if (job.edge) for (let pass = 0; pass < job.edge.passes; pass++) outlinePass(job.edge.speedMmPerS);
  return t;
}

/** Douglas–Peucker on an open polyline. */
function simplifyLine(pts: Vec[], tol: number): Vec[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = len > 0 ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > far) { far = d; worst = i; }
    }
    if (worst >= 0 && far > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring: Ring, tol: number): Ring | null {
  if (ring.length < 3) return null;
  // Split at the point farthest from the first one, so both halves keep the ring's extent.
  let far = 0, split = 0;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]); if (d > far) { far = d; split = i; } }
  if (far <= tol) return null;
  const a = simplifyLine(ring.slice(0, split + 1), tol);
  const b = simplifyLine([...ring.slice(split), ring[0]!], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : null;
}

/** Preview geometry: simplified until it is small enough to draw quickly (about `maxPoints` points). */
export function previewGeometry(job: Pick<LmcJob, "ablate" | "lines">, maxPoints = 40_000): { fills: Ring[]; lines: Vec[][]; toleranceMm: number } {
  const box = jobBounds(job);
  const size = box ? Math.max(box.maxX - box.minX, box.maxY - box.minY) : 1;
  const round = (p: Vec): Vec => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
  for (let tol = Math.max(0.005, size / 4000); ; tol *= 2) {
    const fills = job.ablate.map(r => simplifyRing(r, tol)).filter((r): r is Ring => r !== null);
    const lines = (job.lines ?? []).map(l => simplifyLine(l, tol)).filter(l => l.length >= 2);
    const points = fills.reduce((n, r) => n + r.length, 0) + lines.reduce((n, l) => n + l.length, 0);
    if (points <= maxPoints || tol > size) return { fills: fills.map(r => r.map(round)), lines: lines.map(l => l.map(round)), toleranceMm: tol };
  }
}

export type JobView = {
  name: string;
  source: "board" | "file";
  boardMm: { width: number; height: number };
  /** Where the job centre is on the lens field (mm from the field centre) and whether that came from the job. */
  positionMm: { x: number; y: number };
  positionFromJob: boolean;
  fieldMm: number;
  settings: JobSettings;
  edge: EdgeSettings | null;
  estimatedSeconds: number;
  preview: { fills: Ring[]; lines: Vec[][] };
  warnings: string[];
};

/** Everything the controller window shows about a job: size, place on the lens, settings, time, preview. */
export function jobView(job: LmcJob, path: string, opts: { fieldMm: number; defaultCenterMm: { x: number; y: number }; maxPowerPct: number }): JobView {
  const positionMm = job.positionMm ?? opts.defaultCenterMm;
  const warnings: string[] = [];
  const half = opts.fieldMm / 2;
  const { width, height } = job.boardMm;
  if (Math.abs(positionMm.x) + width / 2 > half + 1e-9 || Math.abs(positionMm.y) + height / 2 > half + 1e-9) {
    warnings.push(`The job (${width.toFixed(1)} × ${height.toFixed(1)} mm) does not fit the ${opts.fieldMm} mm lens field at this position.`);
  }
  if (job.settings.powerPct > opts.maxPowerPct) warnings.push(`Power is capped at ${opts.maxPowerPct} % in Settings (the job asks for ${job.settings.powerPct} %).`);
  const name = job.name ?? (path.split(/[\\/]/).pop() ?? path).replace(/\.lmc\.json$/i, "");
  return {
    name,
    source: job.source ?? "board",
    boardMm: job.boardMm,
    positionMm,
    positionFromJob: job.positionMm !== undefined,
    fieldMm: opts.fieldMm,
    settings: job.settings,
    edge: job.edge ?? null,
    estimatedSeconds: estimateJobSeconds({ ...job, settings: { ...job.settings, powerPct: Math.min(job.settings.powerPct, opts.maxPowerPct) } }),
    preview: previewGeometry(job),
    warnings,
  };
}

// ---------------------------------------------------------------- imported drawings

export type ArtGeometry = { fills: Vec[][]; lines: Vec[][]; widthMm: number; heightMm: number; warnings: string[] };

/** Size, turn and mirror options for an imported drawing. */
export type ArtPlacement = { widthMm?: number; heightMm?: number; rotateDeg?: number; mirror?: boolean };

/**
 * An imported drawing as a job: optionally mirrored, turned about its centre, then scaled (keeping its
 * proportions) so the result is `widthMm` wide (or `heightMm` high), and moved so its bottom-left corner is
 * at 0,0. The size is the size after turning: what the person sees on the lens field.
 */
export function artToJob(art: ArtGeometry, place: ArtPlacement, base: { name: string; settings: JobSettings; edge?: EdgeSettings; positionMm?: { x: number; y: number } }): LmcJob {
  if (!art.fills.length && !art.lines.length) throw new LaserJobError("the drawing has nothing to mark (no filled shapes or lines)");
  const a = ((place.rotateDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = art.widthMm / 2, cy = art.heightMm / 2;
  const turn = ([x, y]: Vec): Vec => {
    let px = x - cx;
    const py = y - cy;
    if (place.mirror) px = -px;
    return [px * cos - py * sin, px * sin + py * cos];
  };
  const turnedFills = art.fills.map(r => r.map(turn));
  const turnedLines = art.lines.map(l => l.map(turn));
  const turned = jobBounds({ ablate: turnedFills, lines: turnedLines })!;
  const w = turned.maxX - turned.minX, h = turned.maxY - turned.minY;
  const scale = place.widthMm !== undefined && w > 0 ? place.widthMm / w : place.heightMm !== undefined && h > 0 ? place.heightMm / h : 1;
  if (!(scale > 0 && Number.isFinite(scale))) throw new LaserJobError("the size must be more than 0 mm");
  const fills = turnedFills.map(r => r.map(([x, y]): Vec => [x * scale, y * scale]));
  const lines = turnedLines.map(l => l.map(([x, y]): Vec => [x * scale, y * scale]));
  const box = { minX: turned.minX * scale, minY: turned.minY * scale, maxX: turned.maxX * scale, maxY: turned.maxY * scale };
  const shift = (p: Vec): Vec => [p[0] - box.minX, p[1] - box.minY];
  return {
    name: base.name,
    source: "file",
    boardMm: { width: Math.max(0.001, box.maxX - box.minX), height: Math.max(0.001, box.maxY - box.minY) },
    ablate: fills.map(r => r.map(shift)),
    lines: lines.map(l => l.map(shift)),
    settings: base.settings,
    ...(base.edge ? { edge: base.edge } : {}),
    ...(base.positionMm ? { positionMm: base.positionMm } : {}),
  };
}

/** A safe file stem from a user's file name ("My Logo (v2).svg" → "My-Logo-v2"). */
export function jobStem(fileName: string): string {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.(svg|dxf)$/i, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return stem || "drawing";
}

/**
 * Starting points for common materials on a 6 W UV (355 nm) galvo laser. Always test on a scrap piece at the
 * power cap first; the cap in Settings limits every job whatever the preset says.
 */
export const MATERIAL_PRESETS: ReadonlyArray<{ id: string; label: string; settings: JobSettings; edge?: EdgeSettings }> = [
  { id: "copper-70", label: "Remove copper (PCB, 70 mm lens)", settings: { powerPct: 100, speedMmPerS: 500, frequencyKhz: 40, passes: 8, intervalMm: 0.015, angleDeg: 0, angleStepDeg: 90 }, edge: { powerPct: 100, speedMmPerS: 300, frequencyKhz: 40, passes: 3 } },
  { id: "soldermask", label: "Open solder mask", settings: { powerPct: 40, speedMmPerS: 1000, frequencyKhz: 40, passes: 2, intervalMm: 0.02, angleDeg: 0, angleStepDeg: 90 } },
  { id: "fr4-mark", label: "Mark FR4 / silkscreen", settings: { powerPct: 30, speedMmPerS: 1200, frequencyKhz: 40, passes: 1, intervalMm: 0.03, angleDeg: 0, angleStepDeg: 0 } },
  { id: "anodized", label: "Mark anodised aluminium", settings: { powerPct: 30, speedMmPerS: 1500, frequencyKhz: 40, passes: 1, intervalMm: 0.03, angleDeg: 0, angleStepDeg: 0 } },
  { id: "plastic", label: "Mark plastic (ABS, PC)", settings: { powerPct: 20, speedMmPerS: 1500, frequencyKhz: 40, passes: 1, intervalMm: 0.04, angleDeg: 0, angleStepDeg: 0 } },
  { id: "paper", label: "Mark paper / card", settings: { powerPct: 10, speedMmPerS: 2000, frequencyKhz: 40, passes: 1, intervalMm: 0.05, angleDeg: 0, angleStepDeg: 0 } },
];

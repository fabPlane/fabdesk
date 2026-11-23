/**
 * Small placement moves inside the last-mile loop (port of the toolkit's tools/nudge_place.py, with the change that
 * keepout rule areas only block when they disallow footprints or tracks) and the bench's placement dry run
 * (tools/bench.py `cmd_fit`).
 *
 * The agent names the part and what it should sit near; the pose is computed. For each move, on a 0.1 mm spiral round
 * the target and for each allowed rotation, the first ring with a legal pose wins, and on it the pose with the shortest
 * pad-to-mate distance (own non-ground pads to the nearest pad of the same net) is taken. Legal: courtyard box clear of
 * every other courtyard box on its side by `clearance`, of every drilled pad, of every blocking keepout rule area (either
 * side), and inside the outline by `edge`. Fixed parts are refused. Side is kept.
 * Copper: every track/via touching the part's old pads is removed, and any other-net copper under the new pads;
 * dangling copper of the cut nets is pruned, so only the affected connections open. A differential pair that loses any
 * copper is removed whole (both members) and listed in `cut_nets`. Gate: native courtyard DRC must be clean.
 *
 * Board facts come from the requirements: the ground net (acceptance stack_policy), the pairs (net classes) and the
 * fixed parts (mechanical anchors), not from C6 names.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pyRound } from "../accept";
import { parseBoard, readBoard, type Footprint, type Pad } from "../board";
import { localBox, overlap, worldBox, type Box, type Pt } from "../edit/geom";
import { pruneDangling } from "../edit/prune";
import { footprintSpans, setPose } from "../layout/text";
import type { Acceptance, Requirements } from "../requirements";
import { keepoutBlocks, kid, kids, num, parseSexpr, removeSpans, topLevelSpans, type SNode, type Span } from "../sexpr";
import { copyBoardFolder } from "./bench";
import { renderBoardSvg } from "./view";

// ---------------------------------------------------------------- types

/** One move. `near`: a point, a part (`REF`, its origin) or a pad (`REF.PAD`); none = where the part is. */
export interface NudgeMoveSpec {
  ref: string;
  near?: [number, number] | string | null;
  /** Search radius in mm (default 6, as the toolkit; the bench's actions pass 2.5 unless `~R` is given). */
  radius?: number;
  /** Allowed rotations (default: the part's own). */
  rotations?: number[];
}

/** The moves of one nudge step (the toolkit's MOVES.json). `actions.ts`'s step `moves` is assignable to it. */
export interface NudgeMoves {
  clearance?: number;
  edge?: number;
  moves: NudgeMoveSpec[];
}

export interface NudgeMoveRecord {
  ref: string;
  from: [number, number, number];
  to: [number, number, number];
  mate_distance_mm: number;
}

/** nudge.json, field for field as the toolkit writes it (the KRT plan runner reads `cut_nets`). */
export interface NudgeRecord {
  moves: NudgeMoveRecord[];
  removed: number;
  pruned: number;
  native_courtyard: Record<string, number>;
  cut_nets: string[];
}

/** A refused move, an unknown part, or a failed courtyard gate; the message is the toolkit's exit message. */
export class NudgeError extends Error {
  /** Set when the board was moved and written but the courtyard gate failed (nudge.json is written too). */
  readonly record?: NudgeRecord;
  constructor(message: string, record?: NudgeRecord) {
    super(message);
    this.name = "NudgeError";
    if (record) this.record = record;
  }
}

/** What the nudge needs to know about the board beyond its file. */
export interface NudgeBoardContext {
  ground: string;
  fixed: (ref: string) => boolean;
  /** Differential pairs (P, N). */
  pairs: Array<[string, string]>;
}

export type CourtyardDrc = (board: string, report: string) => Promise<Array<{ rule: string; items: Array<{ description: string }> }>>;

/** Ground net as the toolkit's boardctx: stack_policy.ground_net, else IO_GND for the legacy C6 schema, else GND. */
export function groundNet(acc: Acceptance): string {
  return acc.stack_policy?.ground_net ?? (acc.schema === "C6_ACCEPTANCE_V1" ? "IO_GND" : "GND");
}

/** Board context from the requirements; `fixed` overrides the mechanical anchors (a spec's fixed pattern, for instance). */
export function nudgeContext(req: Requirements, fixed?: (ref: string) => boolean): NudgeBoardContext {
  const anchors = new Set(req.mechanical.anchors.map((a) => a.reference));
  const pairs: Array<[string, string]> = [];
  for (const c of Object.values(req.acceptance.net_classes.classes)) for (const p of c.pairs ?? []) pairs.push([p[0], p[1]]);
  return { ground: groundNet(req.acceptance), fixed: fixed ?? ((r) => anchors.has(r)), pairs };
}

// ---------------------------------------------------------------- geometry (pure)

export interface PadBox {
  net: string;
  box: Box;
  center: Pt;
}

/** The footprint's pads as if it sat at (x, y, rot): square boxes of half the larger pad side, grown by `grow`. */
export function padBoxes(fp: SNode, x: number, y: number, rot: number, grow = 0): PadBox[] {
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  return kids(fp, "pad").map((pad) => {
    const at = kid(pad, "at")!;
    const size = kid(pad, "size")!;
    const net = kid(pad, "net");
    const px = num(at[1]);
    const py = num(at[2]);
    const h = Math.max(num(size[1]), num(size[2])) / 2 + grow;
    const cx = x + px * c + py * s;
    const cy = y - px * s + py * c;
    return { net: net ? String(net[net.length - 1]) : "", box: [cx - h, cy - h, cx + h, cy + h], center: [cx, cy] };
  });
}

/** Bounding boxes of keepout rule areas that disallow footprints or tracks (allow-all rule areas only scope DRC rules). */
export function keepoutBoxes(root: SNode): Box[] {
  const out: Box[] = [];
  for (const z of kids(root, "zone")) {
    if (!keepoutBlocks(z, ["footprints", "tracks"])) continue;
    const pts: Pt[] = [];
    for (const poly of kids(z, "polygon")) for (const q of kids(kid(poly, "pts") ?? ["pts"], "xy")) pts.push([num(q[1]), num(q[2])]);
    if (pts.length) out.push([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]);
  }
  return out;
}

/** The legal area for courtyard boxes: the Edge.Cuts lines' and rectangles' extent shrunk by `edge`. */
export function outlineLimits(root: SNode, edge: number): Box {
  const pts: Pt[] = [];
  for (const g of [...kids(root, "gr_line"), ...kids(root, "gr_rect")]) {
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    for (const k of ["start", "end"]) {
      const p = kid(g, k);
      if (p) pts.push([num(p[1]), num(p[2])]);
    }
  }
  if (!pts.length) throw new NudgeError("no Edge.Cuts lines or rectangles on the board");
  return [Math.min(...pts.map((p) => p[0])) + edge, Math.min(...pts.map((p) => p[1])) + edge, Math.max(...pts.map((p) => p[0])) - edge, Math.max(...pts.map((p) => p[1])) - edge];
}

const pyFloat = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const f2 = (x: number) => pyRound(x, 2).toFixed(2);

export interface SeatResult {
  /** Board text with the moved poses (copper untouched). */
  text: string;
  moves: NudgeMoveRecord[];
  /** Old pad boxes of the moved parts (grown 0.05): copper touching them is cut. */
  ripBoxes: Box[];
  /** New pad boxes (grown 0.15) and their nets: other-net copper under them is cut. */
  newPads: Array<[string, Box]>;
}

/**
 * Compute the poses of the moves and write them into the board text. Throws NudgeError (the toolkit's message) for an
 * unknown or fixed part, or a move with no legal pose (naming what sits at the target).
 */
export function seatParts(text: string, spec: NudgeMoves, ctx: NudgeBoardContext): SeatResult {
  const gap = spec.clearance ?? 0.25;
  const root = parseSexpr(text);
  const board = readBoard(root);
  const fps = board.footprints;
  const pads = board.pads;
  const raw = new Map<string, SNode>();
  for (const fp of kids(root, "footprint")) {
    let ref: string | undefined;
    for (const p of kids(fp, "property")) if (p[1] === "Reference") ref = String(p[2]);
    if (ref !== undefined) raw.set(ref, fp);
  }
  const [X0, Y0, X1, Y1] = outlineLimits(root, spec.edge ?? 0.5);
  const moving = spec.moves.map((m) => m.ref);
  for (const r of moving) {
    if (!fps.has(r)) throw new NudgeError(`${r}: not on the board`);
    if (ctx.fixed(r)) throw new NudgeError(`${r}: fixed part, not movable`);
  }
  const boxes = new Map<string, [string, Box]>();
  for (const [r, f] of fps) if (!moving.includes(r)) boxes.set(r, [f.layer[0]!, worldBox(localBox(raw.get(r)!), f.x, f.y, f.rot)]);
  const drills: Box[] = [];
  for (const [r, fp] of raw) {
    const f = fps.get(r)!;
    const c = Math.cos((f.rot * Math.PI) / 180);
    const s = Math.sin((f.rot * Math.PI) / 180);
    for (const pad of kids(fp, "pad")) {
      if (!kid(pad, "drill")) continue;
      const at = kid(pad, "at")!;
      const size = kid(pad, "size")!;
      const cx = f.x + num(at[1]) * c + num(at[2]) * s;
      const cy = f.y - num(at[1]) * s + num(at[2]) * c;
      const h = Math.max(num(size[1]), num(size[2])) / 2;
      drills.push([cx - h, cy - h, cx + h, cy + h]);
    }
  }
  const keepouts = keepoutBoxes(root);
  const outside = (wb: Box) => wb[0] < X0 || wb[1] < Y0 || wb[2] > X1 || wb[3] > Y1;

  const record: NudgeMoveRecord[] = [];
  const ripBoxes: Box[] = [];
  const newPads: Array<[string, Box]> = [];
  for (const m of spec.moves) {
    const ref = m.ref;
    const f = fps.get(ref)!;
    const fp = raw.get(ref)!;
    const side = f.layer[0]!;
    const lb = localBox(fp);
    const [tx, ty] = target(m.near, f, fps, pads);
    const mates = new Map<string, Pt[]>();
    for (const q of pads) if (q.ref !== ref && q.net !== ctx.ground) (mates.get(q.net) ?? mates.set(q.net, []).get(q.net)!).push([q.x, q.y]);
    const cost = (x: number, y: number, rot: number) => {
      let t = 0;
      for (const p of padBoxes(fp, x, y, rot)) {
        const ms = mates.get(p.net);
        if (!ms) continue;
        let best = Infinity;
        for (const q of ms) best = Math.min(best, Math.hypot(p.center[0] - q[0], p.center[1] - q[1]));
        t += best;
      }
      return t;
    };
    const radius = m.radius ?? 6;
    const rots = m.rotations ?? [f.rot];
    let best = null as { cost: number; x: number; y: number; rot: number; wb: Box } | null;
    for (let ring = 0; ring <= Math.trunc(radius / 0.1); ring++) {
      const r = ring * 0.1;
      const steps = Math.max(1, Math.trunc((2 * Math.PI * r) / 0.1));
      for (let k = 0; k < steps; k++) {
        const x = tx + r * Math.cos((2 * Math.PI * k) / steps);
        const y = ty + r * Math.sin((2 * Math.PI * k) / steps);
        for (const rot of rots) {
          const wb = worldBox(lb, x, y, rot);
          if (outside(wb)) continue;
          let blocked = false;
          for (const [s, b] of boxes.values()) if (s === side && overlap(wb, b, gap)) { blocked = true; break; }
          if (blocked || drills.some((d) => overlap(wb, d, gap)) || keepouts.some((kz) => overlap(wb, kz, 0))) continue;
          const cst = cost(x, y, rot);
          if (best === null || cst < best.cost) best = { cost: cst, x: pyRound(x, 3), y: pyRound(y, 3), rot: mod360(rot), wb };
        }
      }
      if (best) break;
    }
    if (!best) {
      // say what is in the way at the target, so the next move can clear it
      const why = new Set<string>();
      for (const rot of rots) {
        const wb = worldBox(lb, tx, ty, rot);
        if (outside(wb)) why.add("outline/edge");
        for (const [o, [s, b]] of boxes) if (s === side && overlap(wb, b, gap)) why.add(o);
        if (drills.some((d) => overlap(wb, d, gap))) why.add("drilled pad");
        if (keepouts.some((kz) => overlap(wb, kz, 0))) why.add("keepout");
      }
      const box = worldBox(lb, tx, ty, rots[0]!);
      throw new NudgeError(
        `${ref}: no legal pose within ${m.radius === undefined ? "6" : pyFloat(radius)} mm of the target; at the target ` +
          `(courtyard ${f2(box[2] - box[0])} x ${f2(box[3] - box[1])} mm, gap ${pyFloat(gap)}) it hits: ${[...why].sort().join(", ") || "nothing (radius too small?)"}`,
      );
    }
    boxes.set(ref, [side, best.wb]);
    for (const p of padBoxes(fp, f.x, f.y, f.rot, 0.05)) ripBoxes.push(p.box);
    for (const p of padBoxes(fp, best.x, best.y, best.rot, 0.15)) newPads.push([p.net, p.box]);
    const span = footprintSpans(text).get(ref)!;
    text = text.slice(0, span[0]) + setPose(text.slice(span[0], span[1]), best.x, best.y, best.rot) + text.slice(span[1]);
    record.push({ ref, from: [pyRound(f.x, 3), pyRound(f.y, 3), f.rot], to: [best.x, best.y, best.rot], mate_distance_mm: pyRound(best.cost, 2) });
  }
  return { text, moves: record, ripBoxes, newPads };
}

const mod360 = (x: number) => ((x % 360) + 360) % 360;

function target(near: NudgeMoveSpec["near"], f: Footprint, fps: Map<string, Footprint>, pads: Pad[]): Pt {
  if (Array.isArray(near)) return [near[0], near[1]];
  if (near && near.includes(".")) {
    const i = near.lastIndexOf(".");
    const r = near.slice(0, i);
    const p = near.slice(i + 1);
    const q = pads.find((q) => q.ref === r && q.pad === p);
    if (!q) throw new NudgeError(`${near}: no such pad (with a net) on the board`);
    return [q.x, q.y];
  }
  if (near) {
    const g = fps.get(near);
    if (!g) throw new NudgeError(`${near}: not on the board`);
    return [g.x, g.y];
  }
  return [f.x, f.y];
}

const ITEM_NET = /\(net "([^"]*)"\)/;
const ITEM_PTS = /\((?:start|end|at|mid) ([-\d.]+) ([-\d.]+)/g;

export interface CutResult {
  text: string;
  removed: number;
  pruned: number;
  /** Sorted. */
  cut_nets: string[];
}

/** Remove the copper on the old pads and other-net copper under the new pads, whole cut pairs, then dangling copper of the cut nets. */
export function cutCopper(text: string, ripBoxes: readonly Box[], newPads: ReadonlyArray<[string, Box]>, pairs: ReadonlyArray<readonly [string, string]>): CutResult {
  const spans: Span[] = [];
  const taken = new Set<number>();
  const cut = new Set<string>();
  let removed = 0;
  const inside = (b: Box, x: number, y: number) => b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];
  for (const kind of ["segment", "via", "arc"]) {
    for (const sp of topLevelSpans(text, kind)) {
      const it = text.slice(sp.start, sp.end);
      const net = ITEM_NET.exec(it)?.[1] ?? "";
      const pts: Pt[] = [...it.matchAll(ITEM_PTS)].map((m) => [Number(m[1]), Number(m[2])]);
      const hit = pts.some(([x, y]) => ripBoxes.some((b) => inside(b, x, y))) || pts.some(([x, y]) => newPads.some(([n, b]) => n !== net && inside(b, x, y)));
      if (hit) {
        spans.push(sp);
        taken.add(sp.start);
        removed++;
        cut.add(net);
      }
    }
  }
  // A cut differential pair is routed again as a pair: remove all of its copper (both members), so the pair router
  // starts from the pads and not from leftover stubs.
  const whole = new Set<string>();
  for (const pr of pairs) if (pr.some((n) => cut.has(n))) for (const n of pr) whole.add(n);
  for (const n of whole) cut.add(n);
  for (const kind of ["segment", "via", "arc"]) {
    for (const sp of topLevelSpans(text, kind)) {
      const net = ITEM_NET.exec(text.slice(sp.start, sp.end))?.[1] ?? "";
      if (whole.has(net) && !taken.has(sp.start)) {
        spans.push(sp);
        taken.add(sp.start);
        removed++;
      }
    }
  }
  const pr = pruneDangling(removeSpans(text, spans), cut);
  return { text: pr.text, removed, pruned: pr.pruned, cut_nets: [...cut].sort() };
}

/** The whole board edit of a nudge (no files, no DRC): poses, then copper. */
export function planNudge(text: string, spec: NudgeMoves, ctx: NudgeBoardContext): { text: string; moves: NudgeMoveRecord[]; removed: number; pruned: number; cut_nets: string[] } {
  const seat = seatParts(text, spec, ctx);
  const cu = cutCopper(seat.text, seat.ripBoxes, seat.newPads, ctx.pairs);
  return { text: cu.text, moves: seat.moves, removed: cu.removed, pruned: cu.pruned, cut_nets: cu.cut_nets };
}

// ---------------------------------------------------------------- courtyard gate

const COURTYARD = new Set(["courtyards_overlap", "npth_inside_courtyard", "pth_inside_courtyard"]);

/** Courtyard findings of native DRC as {type: count}, in the order first seen (toolkit floorplan_run.native_courtyard). */
export async function nativeCourtyardCounts(drc: CourtyardDrc, board: string, report: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const v of await drc(board, report)) if (COURTYARD.has(v.rule)) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  return counts;
}

/** Python's repr of a str -> int dict (the toolkit's gate message prints it). */
export const pyDictRepr = (d: Record<string, number>) => `{${Object.entries(d).map(([k, v]) => `'${k}': ${v}`).join(", ")}}`;

// ---------------------------------------------------------------- steps (files)

export interface NudgeStepOptions {
  /** Current board folder. */
  cur: string;
  /** New folder (must not exist): a copy of `cur` with the moved board, moves.json, placement-drc.json and nudge.json. */
  out: string;
  /** Board file name inside the folders. */
  pcb: string;
  moves: NudgeMoves;
  req: Requirements;
  courtyardDrc: CourtyardDrc;
  /** Fixed-part test; default the requirements' mechanical anchors. */
  fixed?: (ref: string) => boolean;
}

const exists = async (p: string) => stat(p).then(() => true, () => false);

/**
 * The nudge step: `out` = copy of `cur` with the parts re-seated and their copper opened, `out/nudge.json` as the toolkit
 * writes it. A refused move throws NudgeError before anything is written; a failed courtyard gate writes everything and
 * then throws NudgeError(`courtyard gate failed: {...}`) with the record attached (the toolkit's exit code and message).
 */
export async function nudgeStep(o: NudgeStepOptions): Promise<NudgeRecord> {
  if (await exists(o.out)) throw new NudgeError(`${o.out} exists`);
  const ctx = nudgeContext(o.req, o.fixed);
  const plan = planNudge(await readFile(join(o.cur, o.pcb), "utf8"), o.moves, ctx);
  await copyBoardFolder(o.cur, o.out);
  await writeFile(join(o.out, "moves.json"), JSON.stringify(o.moves, null, 1) + "\n");
  const board = join(o.out, o.pcb);
  await writeFile(board, plan.text);
  const court = await nativeCourtyardCounts(o.courtyardDrc, board, join(o.out, "placement-drc.json"));
  const rec: NudgeRecord = { moves: plan.moves, removed: plan.removed, pruned: plan.pruned, native_courtyard: court, cut_nets: plan.cut_nets };
  await writeFile(join(o.out, "nudge.json"), JSON.stringify(rec, null, 1) + "\n");
  if (Object.keys(court).length) throw new NudgeError(`courtyard gate failed: ${pyDictRepr(court)}`, rec);
  return rec;
}

export interface FitOptions extends NudgeStepOptions {
  /** Window to draw [X0, Y0, X1, Y1]; default the moved parts' old and new origins plus 4 mm. */
  box?: [number, number, number, number];
  /** Side to draw (default F, as the toolkit). */
  side?: "F" | "B" | "both";
  /** Picture title (the toolkit: `fit ACTION`). */
  title?: string;
  /** SVG to PNG; without it (or when it fails) the SVG is the picture. */
  render?: (svg: string) => Promise<Uint8Array>;
}

export interface FitResult {
  fit: boolean;
  /** The refusal or gate message when nothing fits (the toolkit printed `NO FIT: <message>`). */
  reason?: string;
  record?: NudgeRecord;
  /** The bench's printout: one line per move, then copper and courtyard. */
  lines: string[];
  /** The moved scratch board. */
  board?: string;
  box?: [number, number, number, number];
  svg?: string;
  png?: string | null;
}

/**
 * Placement dry run (bench `fit`): `out` is a scratch folder (replaced); the nudge goes to `out/board`, the window
 * picture to `out/fit.svg` (and `out/fit.png` with `render`). Nothing that fails to fit is an exception: the result says why.
 */
export async function fitStep(o: FitOptions): Promise<FitResult> {
  await rm(o.out, { recursive: true, force: true });
  await mkdir(o.out, { recursive: true });
  const dir = join(o.out, "board");
  let rec: NudgeRecord;
  try {
    rec = await nudgeStep({ ...o, out: dir });
  } catch (e) {
    if (!(e instanceof NudgeError)) throw e;
    const reason = e.message.trim().split("\n").pop()!;
    return { fit: false, reason, lines: [`NO FIT: ${reason}`], ...(e.record ? { record: e.record } : {}) };
  }
  const lines: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const p = (x: number, w: number, d: number) => pyRound(x, d).toFixed(d).padStart(w);
  for (const m of rec.moves) {
    lines.push(`  ${m.ref.padEnd(12)} ${p(m.from[0], 7, 2)} ${p(m.from[1], 7, 2)} ${p(m.from[2], 5, 0)}  ->  ${p(m.to[0], 7, 2)} ${p(m.to[1], 7, 2)} ${p(m.to[2], 5, 0)}   mate ${m.mate_distance_mm} mm`);
    xs.push(m.from[0], m.to[0]);
    ys.push(m.from[1], m.to[1]);
  }
  const court = Object.keys(rec.native_courtyard).length ? pyDictRepr(rec.native_courtyard) : "clean";
  lines.push(`  copper removed ${rec.removed}, cut pairs/nets ${rec.cut_nets.length}, native courtyard ${court}`);
  const box = o.box ?? ([Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) + 4, Math.max(...ys) + 4] as [number, number, number, number]);
  const board = join(dir, o.pcb);
  const svg = renderBoardSvg(parseBoard(await readFile(board, "utf8")), { window: box, side: o.side ?? "F", labels: true, title: o.title ?? `fit ${rec.moves.map((m) => m.ref).join("&")}` });
  const svgPath = join(o.out, "fit.svg");
  await writeFile(svgPath, svg);
  let png: string | null = null;
  if (o.render) {
    try {
      const bytes = await o.render(svg);
      png = join(o.out, "fit.png");
      await writeFile(png, bytes);
    } catch {
      png = null; // the SVG is the picture
    }
  }
  lines.push(png ?? svgPath);
  return { fit: true, record: rec, lines, board, box, svg: svgPath, png };
}

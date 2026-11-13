/**
 * Floorplan block passes (port of the toolkit's `tools/floorplan_run.py` and `tools/block_pass.py`): the agent writes a
 * FLOORPLAN.json (groups of BLOCKS.json blocks, or explicit part lists, each with a region, an order, a courtyard
 * clearance and pinned poses) and TraceMaker's placer places one group at a time:
 *
 *   for each group: pin its pinned parts, gather its parts at a free point in its region, convert the board for
 *   TraceMaker, lock every other footprint and add footprint keep-outs outside the region (block_pass prepare), over
 *   every fixed connector's courtyard and on the opposite side of a dense fixed SMD connector's pad field; place with
 *   `tracemaker-place --mode full`; copy the placed poses back onto the native board (block_pass transfer); verify every
 *   part was placed, the poses equal the placer's, and nothing outside the group moved.
 *
 * Then single-pad parts (test points) go to the nearest free spot to their net (tp_legalise, here the edit stage's
 * `legalise`), and native KiCad courtyard DRC gates the result. A pass that fails verification stops the run with the
 * placer's own reasons. The board is edited as text: every byte outside a moved footprint is as KiCad wrote it.
 *
 * The C6 constants the toolkit hard-coded are derived from the board: the off-board staging square (C6 [110, 20, 130,
 * 40]) and the box the outside-region keep-outs reach to (C6 [-5, -5, 80, 71]); both reproduce C6's values.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { pyRound } from "../accept";
import { parseBoard } from "../board";
import { localBox, worldBox, type Box } from "../edit/geom";
import { planMoves, rawFootprints } from "../edit/move";
import { legaliseMoves } from "../edit/plan";
import { parseSexpr } from "../sexpr";
import { FlowError, requireEngine, type LayoutHost } from "./ctx";
import { pathExists } from "./fsx";
import { nativeCourtyard } from "./place";
import { appendBeforeClose, convertTransforms, footprintSpans, keepoutZone, lockFootprints, pose, setPose, transferPoses } from "./text";

export type Region = [number, number, number, number];

export interface FloorplanGroup {
  name: string;
  /** BLOCKS.json block names whose parts form the group (minus parts other groups claim with `parts`). */
  blocks?: string[];
  /** An explicit part list (a sub-group: a row along a signal path); these parts leave their sheet groups. */
  parts?: string[];
  /** The parent group a sub-group belongs to (route_region / block_eval select a group with its sub-groups). */
  of?: string;
  region: Region;
  /** Poses applied before any pass; pinned parts are never moved by a pass. */
  pinned?: Record<string, [number, number, number]>;
  courtyard_clearance_mm?: number;
}

export interface Floorplan {
  courtyard_clearance_mm: number;
  groups: FloorplanGroup[];
}

export type Blocks = Record<string, { parts: string[] }>;

/** A floorplan file's content, checked enough to fail by name instead of deep in a pass. */
export function readFloorplan(json: unknown, blocks: Blocks): Floorplan {
  const fp = json as Partial<Floorplan>;
  if (!fp || !Array.isArray(fp.groups)) throw new FlowError("floorplan: expected {courtyard_clearance_mm, groups: [...]}");
  if (typeof fp.courtyard_clearance_mm !== "number") throw new FlowError("floorplan: courtyard_clearance_mm (mm) is required");
  for (const g of fp.groups) {
    if (!g || typeof g.name !== "string") throw new FlowError("floorplan: every group needs a name");
    if (!Array.isArray(g.region) || g.region.length !== 4 || g.region.some((v) => typeof v !== "number")) throw new FlowError(`floorplan group ${g.name}: region is [X0, Y0, X1, Y1] in mm`);
    for (const b of g.blocks ?? []) if (!blocks[b]) throw new FlowError(`floorplan group ${g.name}: no block ${b} in the blocks file (board_route blocks writes one)`);
    if (!g.parts?.length && !g.blocks?.length) throw new FlowError(`floorplan group ${g.name}: give blocks or parts`);
  }
  return fp as Floorplan;
}

/** Groups named, with their sub-groups (`of`), in floorplan order (route_region --replace, block_eval --groups). */
export function selectGroups(fp: Floorplan, names: string[]): FloorplanGroup[] {
  return fp.groups.filter((g) => names.includes(g.name) || (g.of !== undefined && names.includes(g.of)));
}

/** Parts listed explicitly by any group's `parts` (they leave their sheet-derived groups). */
export function claimedParts(fp: Floorplan): Set<string> {
  return new Set(fp.groups.flatMap((g) => g.parts ?? []));
}

/** Footprints with at most one netted pad that are not fixed (test points: legalised, never placed by a pass). */
export function singlePadParts(text: string, fixed: RegExp): Set<string> {
  return new Set([...parseBoard(text).footprints].filter(([r, f]) => Object.keys(f.pins).length <= 1 && !fixed.test(r)).map(([r]) => r));
}

/**
 * Movable parts of a group: its explicit `parts`, or its blocks' parts minus those claimed by sub-groups; never fixed,
 * single-pad or pinned parts. Sorted.
 */
export function groupRefs(g: FloorplanGroup, blocks: Blocks, single: Set<string>, claimed: Set<string>, fixed: RegExp): string[] {
  const src = g.parts?.length ? g.parts : (g.blocks ?? []).flatMap((b) => blocks[b]!.parts.filter((r) => !claimed.has(r)));
  return src.filter((r) => !fixed.test(r) && !single.has(r) && !(r in (g.pinned ?? {}))).sort();
}

/** Every movable part a floorplan names (its groups' parts or blocks), fixed parts left out. Sorted. */
export function floorplanParts(fp: Floorplan, blocks: Blocks, fixed: RegExp): string[] {
  return [...new Set(fp.groups.flatMap((g) => (g.parts?.length ? g.parts : (g.blocks ?? []).flatMap((b) => blocks[b]!.parts))))].filter((r) => !fixed.test(r)).sort();
}

export type PoseRow = [number, number, number, string];

/** ref -> [x, y] rounded to 4 decimals, rotation mod 360, layer (floorplan_run.poses). */
export function boardPoses(text: string): Map<string, PoseRow> {
  return new Map([...parseBoard(text).footprints].map(([r, f]) => [r, [pyRound(f.x, 4), pyRound(f.y, 4), f.rot, f.layer] as PoseRow]));
}

/** Courtyard boxes of fixed connectors/switches (not `FIT_` mechanical fits): what a gather point keeps clear of. */
export function fixedBoxes(text: string, fixed: RegExp): Box[] {
  const raw = rawFootprints(parseSexpr(text));
  const fps = parseBoard(text).footprints;
  const out: Box[] = [];
  for (const [ref, node] of raw) {
    if (!fixed.test(ref) || ref.startsWith("FIT_")) continue;
    const f = fps.get(ref)!;
    out.push(worldBox(localBox(node), f.x, f.y, f.rot));
  }
  return out;
}

const pyF4 = (x: number) => pyRound(x, 4).toFixed(4);

/**
 * Move the parts to one point in `region`: the placer keeps parts that overlap a keep-out where they are, so the point is
 * the free 0.5 mm grid point nearest the region centre, clear of the `avoid` boxes by the largest part's half-diagonal
 * plus 0.5 mm (the region centre when no point is free).
 */
export function gatherParts(text: string, refs: string[], region: Region, avoid: Box[] = []): string {
  const [r0, r1, r2, r3] = region;
  let cx = (r0 + r2) / 2, cy = (r1 + r3) / 2;
  const pts: Array<[number, number, number, number]> = [];
  for (let i = 0; i < Math.trunc((r2 - r0) / 0.5) + 1; i++)
    for (let j = 0; j < Math.trunc((r3 - r1) / 0.5) + 1; j++) {
      const p: [number, number] = [r0 + i * 0.5, r1 + j * 0.5];
      pts.push([p[0], p[1], (p[0] - cx) ** 2 + (p[1] - cy) ** 2, pts.length]);
    }
  pts.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const want = new Set(refs);
  const raw = rawFootprints(parseSexpr(text));
  const sizes = [...raw].filter(([r]) => want.has(r)).map(([, n]) => localBox(n));
  const m = 0.5 + (sizes.length ? Math.max(...sizes.map((b) => ((b[2] - b[0]) ** 2 + (b[3] - b[1]) ** 2) ** 0.5 / 2)) : 2.5);
  for (const [px, py] of pts)
    if (!avoid.some((b) => b[0] - m < px && px < b[2] + m && b[1] - m < py && py < b[3] + m)) {
      [cx, cy] = [px, py];
      break;
    }
  for (const ref of refs) {
    const sp = footprintSpans(text).get(ref);
    if (!sp) throw new FlowError(`${ref}: not on the board`);
    const body = text.slice(sp[0], sp[1]);
    // the toolkit rewrote the transform's translate; setPose also handles a board written with (at x y r) poses
    const next = /\(transform\s+\(translate/.test(body) ? body.replace(/\(translate [-\d.]+ [-\d.]+\)/, `(translate ${pyF4(cx)} ${pyF4(cy)})`) : setPose(body, cx, cy, pose(body)[2]);
    text = text.slice(0, sp[0]) + next + text.slice(sp[1]);
  }
  return text;
}

/** Apply pinned poses (child angles turn with the part). */
export function pinParts(text: string, pinned: Record<string, [number, number, number]>): string {
  for (const [ref, [x, y, rot]] of Object.entries(pinned)) {
    const sp = footprintSpans(text).get(ref);
    if (!sp) throw new FlowError(`pinned ${ref}: not on the board`);
    text = text.slice(0, sp[0]) + setPose(text.slice(sp[0], sp[1]), x, y, rot) + text.slice(sp[1]);
  }
  return text;
}

/** Off-board staging square right of the outline (C6: [110, 20, 130, 40]): locked off-outline parts are no obstacles. */
export function stagingRegion(text: string): Region {
  const o = parseBoard(text).outline ?? { minX: 0, minY: 0, maxX: 75, maxY: 66 };
  const x = Math.ceil(o.maxX) + 35;
  return [x, o.minY + 20, x + 20, o.minY + 40];
}

/** The box the outside-region keep-outs reach to: the outline plus 5 mm, whole millimetres (C6: [-5, -5, 80, 71]). */
export function beyondBox(text: string): Region {
  const o = parseBoard(text).outline ?? { minX: 0, minY: 0, maxX: 75, maxY: 66 };
  return [Math.floor(o.minX) - 5, Math.floor(o.minY) - 5, Math.ceil(o.maxX) + 5, Math.ceil(o.maxY) + 5];
}

/**
 * block_pass prepare: every footprint not in `refs` locked, and footprint keep-outs on F and B covering everything
 * outside `region` (out to `beyond`), so the placer moves only the block's parts and only inside its region.
 */
export function prepareBlockPass(text: string, refs: string[], region: Region, beyond: Region): { text: string; movable: number; locked: number } {
  const spans = footprintSpans(text);
  const want = new Set(refs);
  const missing = refs.filter((r) => !spans.has(r));
  if (missing.length) throw new FlowError(`unknown refs: ${[...new Set(missing)].sort().join(", ")}`);
  const others = [...spans.keys()].filter((r) => !want.has(r));
  let out = lockFootprints(text, others);
  const [X0, Y0, X1, Y1] = region;
  const B = beyond;
  const boxes: Region[] = [[B[0], B[1], B[2], Y0], [B[0], Y1, B[2], B[3]], [B[0], Y0, X0, Y1], [X1, Y0, B[2], Y1]];
  out = appendBeforeClose(out, ["F.Cu", "B.Cu"].flatMap((l) => boxes.map((b) => keepoutZone(l, ...b))).join(""));
  return { text: out, movable: want.size, locked: spans.size - want.size };
}

/**
 * Footprint keep-outs over each fixed connector/switch courtyard on its side (tracemaker-place put parts over C6's USB-C
 * although its courtyard is valid), and on the opposite side over a dense SMD connector's pad field (>= 8 netted pads,
 * no through-hole pad): its escapes need through vias, so nothing may sit there.
 */
export function addFixedKeepouts(passText: string, fixed: RegExp): string {
  const root = parseSexpr(passText);
  const raw = rawFootprints(root);
  const board = parseBoard(passText);
  let zones = "";
  for (const [ref, node] of raw) {
    if (!fixed.test(ref) || ref.startsWith("FIT_")) continue;
    const f = board.footprints.get(ref)!;
    zones += keepoutZone(f.layer, ...worldBox(localBox(node), f.x, f.y, f.rot));
    const smd = board.pads.filter((p) => p.ref === ref && p.net && !p.net.startsWith("unconnected"));
    const tht = node.some((pd) => Array.isArray(pd) && pd[0] === "pad" && pd[2] === "thru_hole");
    if (smd.length >= 8 && !tht) {
      const other = f.layer === "F.Cu" ? "B.Cu" : "F.Cu";
      const xs = smd.map((p) => p.x), ys = smd.map((p) => p.y);
      const m = 0.6;
      zones += keepoutZone(other, Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m);
    }
  }
  return appendBeforeClose(passText, zones);
}

export interface GroupPassRecord {
  group: string;
  parts: number;
  pinned: Record<string, [number, number, number]>;
  placed: number | null;
  failed: number | null;
  conflicts_after: number | null;
  new_conflicts: number | null;
  moved: number;
  moved_outside_group: string[];
  pose_mismatch: string[];
  origin_outside_region: string[];
  ok: boolean;
  placer_unplaced?: unknown[];
}

/** TraceMaker's placer: `TRACEMAKER_PLACE_BIN`, else `tracemaker-place` next to the TraceMaker binary. */
export async function tracemakerPlacer(host: LayoutHost): Promise<string> {
  const env = process.env["TRACEMAKER_PLACE_BIN"];
  if (env) return env;
  const tm = await requireEngine(host, "tracemaker");
  const exe = basename(tm).endsWith(".exe") ? "tracemaker-place.exe" : "tracemaker-place";
  const p = join(dirname(tm), exe);
  if (!existsSync(p)) throw new FlowError(`${exe} is not next to TraceMaker (${tm}): the floorplan passes need TraceMaker's placer; set TRACEMAKER_PLACE_BIN to it`);
  return p;
}

export interface GroupPassOptions {
  /** The native board file, edited in place. */
  board: string;
  /** Working folder for the pass's TraceMaker files. */
  tm: string;
  tag: string;
  group: FloorplanGroup;
  refs: string[];
  clearance: number;
  time: number;
  seed: number;
  fixed: RegExp;
  placer: string;
  beyond: Region;
}

/** One block pass (floorplan_run.place_group). `ok` false: the pass must not be used. */
export async function placeGroup(host: LayoutHost, o: GroupPassOptions): Promise<GroupPassRecord> {
  const g = o.group;
  const pinned = g.pinned ?? {};
  let text = pinParts(await readFile(o.board, "utf8"), pinned);
  const before = boardPoses(text);
  text = gatherParts(text, o.refs, g.region, fixedBoxes(text, o.fixed));
  await writeFile(o.board, text);
  const f = (s: string) => join(o.tm, `${o.tag}-${s}`);
  await writeFile(f("in.kicad_pcb"), convertTransforms(text).text);
  const prepared = prepareBlockPass(await readFile(f("in.kicad_pcb"), "utf8"), o.refs, g.region, o.beyond);
  await writeFile(f("pass.kicad_pcb"), addFixedKeepouts(prepared.text, o.fixed));
  const cmd = [o.placer, f("pass.kicad_pcb"), "-o", f("placed.kicad_pcb"), "--mode", "full", "--time", String(o.time), "--seed", String(o.seed), "--courtyard-clearance-mm", String(o.clearance), "--json", f("place.json")];
  const res = await host.spawn(cmd, { log: f("place.log"), ...(host.signal ? { signal: host.signal } : {}), ...(host.onPid ? { onPid: host.onPid } : {}) });
  const log = await readFile(f("place.log"), "utf8").catch(() => "");
  if (res.code) throw new FlowError(`tracemaker-place failed (exit ${res.code}) on group ${g.name}: ${log.slice(-600)}`);
  const legal = /legalisation: (\d+) placed, (\d+) failed/.exec(log);
  const conflicts = /conflicts\s+before\s+\d+\s+after\s+(\d+)\s+new (\d+)/.exec(log);
  const placedText = await readFile(f("placed.kicad_pcb"), "utf8");
  text = transferPoses(await readFile(o.board, "utf8"), placedText, o.refs).text;
  await writeFile(o.board, text);
  const after = boardPoses(text), placed = boardPoses(placedText);
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const moved = [...after.keys()].filter((r) => !same(after.get(r)!, before.get(r) ?? []));
  const want = new Set(o.refs);
  const mismatch = o.refs.filter((r) => !same(after.get(r)!.slice(0, 3), placed.get(r)?.slice(0, 3) ?? []));
  const [X0, Y0, X1, Y1] = g.region;
  const outside = o.refs.filter((r) => {
    const [x, y] = after.get(r)!;
    return !(X0 <= x && x <= X1 && Y0 <= y && y <= Y1);
  });
  const rec: GroupPassRecord = {
    group: g.name,
    parts: o.refs.length,
    pinned,
    placed: legal ? Number(legal[1]) : null,
    failed: legal ? Number(legal[2]) : null,
    conflicts_after: conflicts ? Number(conflicts[1]) : null,
    new_conflicts: conflicts ? Number(conflicts[2]) : null,
    moved: moved.length,
    moved_outside_group: moved.filter((r) => !want.has(r)),
    pose_mismatch: mismatch,
    origin_outside_region: outside,
    ok: false,
  };
  rec.ok = !(rec.failed || rec.new_conflicts || rec.moved_outside_group.length || mismatch.length || rec.placed !== o.refs.length);
  try {
    // the placer's own reasons for parts it did not move (e.g. no legal position in the region)
    const pj = JSON.parse(await readFile(f("place.json"), "utf8")) as { fixed_parts?: Array<{ ref: string }> };
    rec.placer_unplaced = (pj.fixed_parts ?? []).filter((x) => want.has(x.ref));
  } catch {
    /* no report */
  }
  return rec;
}

/** Single-pad parts to the nearest free spot to their net (tp_legalise: 0.15 mm clearance, 0.5 mm from the edge). */
export type Legalise = (text: string, refs: string[], fixed: RegExp) => string;
export const legaliseSingles: Legalise = (text, refs, fixed) => (refs.length ? planMoves(text, (r) => fixed.test(r), legaliseMoves(refs), undefined, []).text : text);

export interface FloorplanRunOptions {
  /** The placement base project folder (copied to `out`). */
  base: string;
  out: string;
  stem: string;
  floorplan: Floorplan;
  blocks: Blocks;
  fixed: RegExp;
  /** Seconds per pass for the placer's annealer (default 30). */
  time?: number;
  seed?: number;
  legalise?: Legalise;
}

export interface FloorplanRunResult {
  ok: boolean;
  board: string;
  log: Array<GroupPassRecord | Record<string, unknown>>;
  /** Why the run stopped. */
  stop?: string;
}

/**
 * floorplan_run: the base copied to `out`, every floorplan part staged off the board, all pinned poses applied, then one
 * pass per group in floorplan order (stopping at the first that fails verification), single-pad parts legalised and the
 * native courtyard gate. Writes `out/floorplan-log.json`.
 */
export async function floorplanRun(host: LayoutHost, o: FloorplanRunOptions): Promise<FloorplanRunResult> {
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  const placer = await tracemakerPlacer(host);
  await cp(o.base, o.out, { recursive: true });
  const board = join(o.out, `${o.stem}.kicad_pcb`);
  const tm = join(o.out, "tm");
  await mkdir(tm);
  const log: FloorplanRunResult["log"] = [];
  const done = async (stop?: string): Promise<FloorplanRunResult> => {
    await writeFile(join(o.out, "floorplan-log.json"), JSON.stringify(log, null, 1) + "\n");
    return { ok: !stop, board, log, ...(stop ? { stop } : {}) };
  };
  let text = await readFile(board, "utf8");
  const single = singlePadParts(text, o.fixed);
  const claimed = claimedParts(o.floorplan);
  const movable = floorplanParts(o.floorplan, o.blocks, o.fixed);
  const beyond = beyondBox(text);
  text = gatherParts(text, movable, stagingRegion(text));
  for (const g of o.floorplan.groups) text = pinParts(text, g.pinned ?? {}); // all pinned poses first: earlier passes see them
  await writeFile(board, text);
  for (const [i, g] of o.floorplan.groups.entries()) {
    host.signal?.throwIfAborted();
    const refs = groupRefs(g, o.blocks, single, claimed, o.fixed);
    const rec = await placeGroup(host, {
      board, tm, tag: `${String(i).padStart(2, "0")}-${g.name}`, group: g, refs,
      clearance: g.courtyard_clearance_mm ?? o.floorplan.courtyard_clearance_mm, time: o.time ?? 30, seed: o.seed ?? 1, fixed: o.fixed, placer, beyond,
    });
    log.push(rec);
    host.log?.(JSON.stringify(rec));
    if (!rec.ok) return done(`pass failed verification: ${g.name} placed ${rec.placed} of ${refs.length}; placer: ${JSON.stringify(rec.placer_unplaced ?? null)}`);
  }
  const tps = [...single].filter((r) => movable.includes(r)).sort();
  try {
    await writeFile(board, (o.legalise ?? legaliseSingles)(await readFile(board, "utf8"), tps, o.fixed));
  } catch (e) {
    log.push({ single_pad_legalised: [], error: e instanceof Error ? e.message : String(e) });
    return done(`single-pad legalise failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  log.push({ single_pad_legalised: tps });
  const bad = await nativeCourtyard(host, board, join(tm, "placement-drc.json"));
  log.push({ native_courtyard_check: bad });
  return done(Object.keys(bad).length ? `native courtyard check failed: ${JSON.stringify(bad)}` : undefined);
}


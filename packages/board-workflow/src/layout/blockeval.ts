/**
 * One block's placement judged in isolation (port of the toolkit's `tools/block_eval.py`): optionally re-place the
 * block's floorplan groups in their regions (the floorplan passes and gates), then a TraceMaker session routes only the
 * block's nets on a copper-free board (the base plan's session stages restricted to those nets: on C6 the dense
 * connector's small nets, then the pairs; then the rest in calls of at most 60 nets). Failures here are placement
 * geometry or router limits, never interaction with other blocks; ground drops are left out unless `gndFirst`, so the
 * figure is optimistic (C6 display: 5 open isolated, 16 integrated). Writes `out/eval.json` (per stage routed / open,
 * every failed connection with the router's reason) and `out/eval.svg` (the window with the block's parts).
 *
 * The toolkit took its base plan from a C6 file (`review/c6-route85/plan-r6.json`); here it is the layout spec's
 * TraceMaker plan. Its `escape` (power_escape stubs) is not set: the TypeScript route pipeline does not run power_escape.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profile } from "../accept";
import { parseBoard } from "../board";
import type { Requirements } from "../requirements";
import { renderBoardSvg } from "../lastmile/view";
import { FlowError, type LayoutHost } from "./ctx";
import { claimedParts, gatherParts, groupRefs, pinParts, placeGroup, beyondBox, selectGroups, singlePadParts, stagingRegion, tracemakerPlacer, type Blocks, type Floorplan, type FloorplanGroup, type GroupPassRecord } from "./floorplan";
import { pathExists } from "./fsx";
import { nativeCourtyard } from "./place";
import { pairClasses } from "./plan";
import { loadPlan, routePipeline } from "./route";

interface TmStage {
  name: string;
  nets: string | string[];
  work?: number;
  hints?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The base plan's session stages restricted to `nets` (empty ones dropped), then the rest in calls of <= 60 nets. */
export function blockPlan(base: { session?: TmStage[] }, nets: string[], req: Requirements, names: string[], gndFirst = false, ground = profile(req.acceptance).ground): { note: string; session: TmStage[]; cli: null } {
  const acc = req.acceptance;
  const noTracks = acc.stack_policy.no_track_layers ?? [];
  const pairs = Object.values(pairClasses(acc)).flatMap((c) => (c.pairs ?? []).flat());
  const want = new Set(nets);
  const stages: TmStage[] = [];
  if (gndFirst) stages.push({ name: "gnd-drops", work: 30000000, nets: [ground], hints: { layers: { no_tracks: noTracks } } });
  const taken = new Set<string>();
  for (const st of base.session ?? []) {
    const mine = (st.nets === "@pairs" ? pairs : Array.isArray(st.nets) ? st.nets : []).filter((n) => want.has(n));
    if (!mine.length) continue;
    stages.push({ ...st, nets: mine });
    for (const n of mine) taken.add(n);
  }
  const rest = nets.filter((n) => !taken.has(n));
  for (let i = 0; i < rest.length; i += 60) stages.push({ name: `rest-${i / 60}`, work: 50000000, nets: rest.slice(i, i + 60), hints: { layers: { no_tracks: noTracks } } });
  // the toolkit's note prints the Python list
  return { note: `block_eval isolation: [${names.map((n) => `'${n}'`).join(", ")}]`, session: stages, cli: null };
}

/** The nets of the groups' parts (their parts lists or blocks, fixed parts included), ground and unconnected left out. */
export function blockNets(text: string, groups: FloorplanGroup[], blocks: Blocks, ground: string): string[] {
  const refs = new Set(groups.flatMap((g) => (g.parts?.length ? g.parts : (g.blocks ?? []).flatMap((b) => blocks[b]!.parts))));
  return [...new Set(parseBoard(text).pads.filter((p) => refs.has(p.ref) && p.net && p.net !== ground && !p.net.startsWith("unconnected")).map((p) => p.net))].sort();
}

export interface BlockEvalOptions {
  /** A copper-free placed project folder (copied to out/placed). */
  placed: string;
  out: string;
  stem: string;
  floorplan: Floorplan;
  blocks: Blocks;
  /** Group names; sub-groups (`of`) come along. */
  groups: string[];
  replace?: boolean;
  seed?: number;
  /** The layout spec's TraceMaker plan (a file or `builtin:tm`). */
  basePlan: string;
  req: Requirements;
  fixed: RegExp;
  window?: [number, number, number, number];
  gndFirst?: boolean;
}

export interface BlockEvalRecord {
  groups: string[];
  replace: boolean;
  seed: number;
  placement?: Array<Pick<GroupPassRecord, "group" | "parts" | "placed" | "ok"> & { placer_unplaced: unknown }>;
  native_courtyard?: Record<string, number> | "skipped";
  nets?: number;
  stages?: unknown;
  failed?: Array<{ net: unknown; a: unknown; b: unknown; reason: unknown }>;
  failed_count?: number;
  stop?: string;
}

export async function blockEval(host: LayoutHost, o: BlockEvalOptions): Promise<BlockEvalRecord> {
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  const groups = selectGroups(o.floorplan, o.groups);
  if (!groups.length) throw new FlowError(`unknown group in ${o.groups.join(",")} (the floorplan has ${o.floorplan.groups.map((g) => g.name).join(", ")})`);
  const names = groups.map((g) => g.name);
  const placed = join(o.out, "placed");
  await mkdir(o.out, { recursive: true });
  await cp(o.placed, placed, { recursive: true, filter: (s) => { const n = s.slice(s.lastIndexOf("/") + 1); return s === o.placed || !(n === "tm" || /^acceptance.*\.json$/.test(n) || n.startsWith("score")); } });
  const board = join(placed, `${o.stem}.kicad_pcb`);
  const rec: BlockEvalRecord = { groups: names, replace: !!o.replace, seed: o.seed ?? 1 };
  const save = () => writeFile(join(o.out, "eval.json"), JSON.stringify(rec, null, 1) + "\n");
  if (o.replace) {
    const placer = await tracemakerPlacer(host);
    const tm = join(placed, "tm");
    await mkdir(tm, { recursive: true });
    let text = await readFile(board, "utf8");
    const single = singlePadParts(text, o.fixed);
    const claimed = claimedParts(o.floorplan);
    const beyond = beyondBox(text);
    text = gatherParts(text, groups.flatMap((g) => groupRefs(g, o.blocks, single, claimed, o.fixed)), stagingRegion(text));
    for (const g of groups) text = pinParts(text, g.pinned ?? {}); // all pinned poses first
    await writeFile(board, text);
    rec.placement = [];
    for (const g of groups) {
      const p = await placeGroup(host, {
        board, tm, tag: g.name, group: g, refs: groupRefs(g, o.blocks, single, claimed, o.fixed),
        clearance: g.courtyard_clearance_mm ?? o.floorplan.courtyard_clearance_mm, time: 30, seed: o.seed ?? 1, fixed: o.fixed, placer, beyond,
      });
      rec.placement.push({ group: p.group, parts: p.parts, placed: p.placed, ok: p.ok, placer_unplaced: p.placer_unplaced ?? null });
      if (!p.ok) break;
    }
    const allOk = rec.placement.length === groups.length && rec.placement.every((p) => p.ok);
    rec.native_courtyard = allOk ? await nativeCourtyard(host, board, join(tm, "placement-drc.json")) : "skipped";
    if (!allOk || Object.keys(rec.native_courtyard).length) {
      rec.stop = `placement failed: ${JSON.stringify(rec.placement)}`;
      await save();
      return rec;
    }
  }
  const nets = blockNets(await readFile(board, "utf8"), groups, o.blocks, profile(o.req.acceptance).ground);
  const plan = blockPlan((await loadPlan(o.basePlan)) as unknown as { session?: TmStage[] }, nets, o.req, names, o.gndFirst);
  await writeFile(join(o.out, "plan.json"), JSON.stringify(plan, null, 1) + "\n");
  const log = (await routePipeline(host, { placed, out: join(o.out, "route"), plan: join(o.out, "plan.json"), stem: o.stem, req: o.req })) as { stages: unknown[] };
  const resp = (await readFile(join(o.out, "route", "tm", "responses.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { unrouted?: Array<Record<string, unknown>> });
  const failed = resp.slice(1).flatMap((r) => (r.unrouted ?? []).map((u) => ({ net: u["net"], a: u["a"], b: u["b"], reason: u["reason"] })));
  Object.assign(rec, { nets: nets.length, stages: log.stages, failed, failed_count: failed.length });
  await save();
  const routedBoard = join(o.out, "route", "tm", "session", `${o.stem}.kicad_pcb`);
  if (await pathExists(routedBoard)) {
    const b = parseBoard(await readFile(routedBoard, "utf8"));
    await writeFile(join(o.out, "eval.svg"), renderBoardSvg(b, { labels: true, title: `${names.join(",")} isolated: ${failed.length} failed`, ...(o.window ? { window: o.window } : {}) }));
  }
  return rec;
}

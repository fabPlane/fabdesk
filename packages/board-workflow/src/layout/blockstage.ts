/**
 * The floorplan path of the layout stage, beside the KRT seeds: `floorplan` (block passes from FLOORPLAN.json; a gated
 * result joins the place pool, so `rank` routes it with the seeds), `block_eval` (one block judged in isolation),
 * `placement` (placement_check figures) and `blocks` (BLOCKS.json for a floorplan to name).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { profile } from "../accept";
import { admitted, FlowError, type LayoutHost } from "./ctx";
import { blockEval, type BlockEvalRecord } from "./blockeval";
import { blockInventory, blockLines, type Block } from "./blocks";
import { floorplanRun, readFloorplan, type Blocks, type GroupPassRecord } from "./floorplan";
import { saveFlow, type FlowState, type PoolSeed, type StageOutcome } from "./flow";
import { placementCheck, placementLines, type PlacementReport } from "./placement";
import { readRequirementsDir } from "./score";
import type { LayoutSpec } from "./spec";

const rel = (spec: LayoutSpec, p: string) => (p.startsWith("builtin:") || isAbsolute(p) ? p : resolve(spec.base, "..", p));

/** Pool numbers of floorplan results: 1000 + the placer seed (KRT seeds are small numbers). */
export const FLOORPLAN_POOL_BASE = 1000;

async function readBlocksAndPlan(floorplanFile: string, blocksFile: string) {
  const blocks = JSON.parse(await readFile(blocksFile, "utf8").catch(() => { throw new FlowError(`no blocks file ${blocksFile}: board_route blocks writes one`); })) as Blocks;
  const fp = readFloorplan(JSON.parse(await readFile(floorplanFile, "utf8").catch(() => { throw new FlowError(`no floorplan file ${floorplanFile}`); })), blocks);
  return { blocks, fp };
}

export interface FloorplanStageOptions {
  floorplan: string;
  blocks: string;
  seed?: number;
  time?: number;
}

/** Floorplan block passes on the workspace base; a gated board joins the place pool (kept) for `rank`. */
export async function stageFloorplan(host: LayoutHost, st: FlowState, o: FloorplanStageOptions): Promise<StageOutcome> {
  if (st.stages.check?.status !== "pass") throw new FlowError("run check first (fail fast: nothing heavy before the preflight passes)");
  const sp = st.spec;
  const { blocks, fp } = await readBlocksAndPlan(o.floorplan, o.blocks);
  const seed = o.seed ?? 1;
  const name = `${basename(o.floorplan).replace(/\.json$/, "")}-s${seed}`;
  const out = join(st.ws, "floorplan", name);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(st.ws, "floorplan"), { recursive: true });
  const fixed = new RegExp(sp.fixed);
  const r = await admitted(host, "tracemaker", `floorplan ${name}`, [join(st.ws, "base")], () =>
    floorplanRun(host, { base: join(st.ws, "base"), out, stem: sp.stem, floorplan: fp, blocks, fixed, seed, ...(o.time ? { time: o.time } : {}) }),
  );
  const isPass = (x: (typeof r.log)[number]): x is GroupPassRecord => "group" in x;
  const lines = r.log.map((x) =>
    isPass(x) ? `${String(x.group).padEnd(14)} ${x.ok ? "ok " : "NO "} placed ${x.placed}/${x.parts}  moved ${x.moved}${x.moved_outside_group.length ? `  outside group: ${x.moved_outside_group.join(",")}` : ""}${x.pose_mismatch.length ? `  pose mismatch: ${x.pose_mismatch.join(",")}` : ""}` : JSON.stringify(x),
  );
  let report: PlacementReport | null = null;
  if (r.ok) {
    const acc = (await readRequirementsDir(rel(sp, sp.requirements))).acceptance;
    report = placementCheck(await readFile(r.board, "utf8"), { fixed, ground: profile(acc).ground, blocks, board: r.board });
    await writeFile(join(out, "placement.json"), JSON.stringify(report, null, 1) + "\n");
    lines.push(...placementLines(report));
  }
  const entry: PoolSeed = {
    seed: FLOORPLAN_POOL_BASE + seed, gate: r.ok, crossings: null, cost: report?.hpwl_total_mm ?? null, wire: null, placed: out, why: r.stop ?? "", kept: r.ok, source: `floorplan ${o.floorplan} seed ${seed}`,
  };
  st.place_pool = [...(st.place_pool ?? []).filter((s) => s.seed !== entry.seed), entry];
  await saveFlow(st);
  const verdict = r.ok
    ? `PASS floorplan ${name}: every group placed and gated; in the place pool as seed ${entry.seed} (kept), so rank routes it with the KRT seeds`
    : `STOP floorplan ${name}: ${r.stop}. Change the floorplan (regions, order, clearance, pinned poses, sub-groups) and run it again`;
  return { verdict, ok: r.ok, lines, result: { log: r.log, placement: report, pool_seed: entry.seed }, ...(r.ok ? { board: r.board } : {}) };
}

export interface BlockEvalStageOptions {
  floorplan: string;
  blocks: string;
  groups: string[];
  replace?: boolean;
  seed?: number;
  /** A placed project folder (default the workspace base). */
  placed?: string;
  window?: [number, number, number, number];
}

/** block_eval on the workspace base (or `placed`): `WS/block_eval/<groups>-s<seed>[-r]/eval.json` and `eval.svg`. */
export async function stageBlockEval(host: LayoutHost, st: FlowState, o: BlockEvalStageOptions): Promise<StageOutcome> {
  const sp = st.spec;
  const { blocks, fp } = await readBlocksAndPlan(o.floorplan, o.blocks);
  const seed = o.seed ?? 1;
  const name = `${o.groups.join("+")}-s${seed}${o.replace ? "-r" : ""}`;
  const out = join(st.ws, "block_eval", name);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(st.ws, "block_eval"), { recursive: true });
  const req = await readRequirementsDir(rel(sp, sp.requirements));
  const rec: BlockEvalRecord = await admitted(host, "tracemaker", `block_eval ${name}`, [o.placed ?? join(st.ws, "base")], async () => {
    for (let noted = false; host.tracemakerBusy && !host.signal?.aborted && (await host.tracemakerBusy()); noted = true) {
      if (!noted) host.log?.("waiting: a TraceMaker outside this job is running (one per machine)");
      await new Promise((r) => setTimeout(r, 15_000));
    }
    return blockEval(host, {
      placed: o.placed ?? join(st.ws, "base"), out, stem: sp.stem, floorplan: fp, blocks, groups: o.groups, replace: !!o.replace, seed,
      basePlan: rel(sp, sp.plans.tm), req, fixed: new RegExp(sp.fixed), ...(o.window ? { window: o.window } : {}),
    });
  });
  const lines = [
    ...(rec.placement ?? []).map((p) => `${p.group.padEnd(14)} ${p.ok ? "ok " : "NO "} placed ${p.placed}/${p.parts}`),
    ...(rec.native_courtyard && rec.native_courtyard !== "skipped" && Object.keys(rec.native_courtyard).length ? [`native courtyard ${JSON.stringify(rec.native_courtyard)}`] : []),
    ...((rec.stages as Array<Record<string, unknown>> | undefined) ?? []).map((s) => `${String(s["stage"]).padEnd(16)} routed ${s["routed"] ?? s["summary"] ?? "?"}  open ${s["open_after"] ?? "?"}`),
    ...(rec.failed ?? []).slice(0, 12).map((f) => `failed ${String(f.net)}: ${String(f.reason)}`),
  ];
  if (rec.stop) return { verdict: `STOP block_eval ${name}: ${rec.stop}`, ok: false, lines, result: rec };
  return { verdict: `PASS block_eval ${name}: ${rec.nets} nets, ${rec.failed_count} failed connection(s) isolated (${join(out, "eval.svg")})`, ok: true, lines, result: rec };
}

/** placement_check figures for a board text with the layout spec's fixed pattern and ground net. */
export function placementFor(text: string, o: { fixed: RegExp; ground: string; blocks?: Blocks; board?: string }): { report: PlacementReport; lines: string[] } {
  const report = placementCheck(text, { fixed: o.fixed, ground: o.ground, ...(o.blocks ? { blocks: o.blocks } : {}), ...(o.board ? { board: o.board } : {}) });
  return { report, lines: placementLines(report) };
}

/** BLOCKS.json for a board text: sheets, `split` sheets by anchor IC (U/IC references, with or without a sheet prefix). */
export function blocksFor(text: string, o: { split: string[]; ground: string; heights?: Array<{ ref: string; height_above_surface_mm?: number | null }> }): { blocks: Record<string, Block>; lines: string[] } {
  const blocks = blockInventory(text, { split: o.split, ground: o.ground, anchor: /^(.*_)?(U|IC)\d/, ...(o.heights ? { heights: o.heights } : {}) });
  return { blocks, lines: blockLines(blocks) };
}

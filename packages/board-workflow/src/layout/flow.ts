/**
 * The layout flow as a state machine any agent can drive (port of the toolkit's `flow/flow.py`):
 *
 *   check  fail-fast preflight; nothing heavy runs until it passes
 *   place  KRT placer seeds, every seed gated on native courtyard DRC and fixed parts unmoved
 *   rank   route the kept seeds (KRT), rank by open connections, then A8 pair nets, then A7 width nets
 *   route  best seed: TraceMaker, then KRT finish and fine finish, hedged with a KRT finish of the rank route
 *   auto   the remaining stages in order, up to a stage, stopping at the first FAIL/STOP
 *   status / next / finish
 *
 * Every stage writes `WS/<stage>/result.json`, ends with a verdict (`PASS`, `FAIL <reason>`, `STOP <decision>`) and is
 * recorded in `WS/flow.json`. The last mile (`lastmile/`) starts from `best_board`, the route stage's board.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { checkAcceptance } from "../accept";
import { parseBoard } from "../board";
import { readJsonOrNull } from "../files";
import { admitted, engineReady, FlowError, type LayoutHost } from "./ctx";
import { facing } from "./facing";
import { pathExists } from "./fsx";
import { placeKrt, type PlaceRecord } from "./place";
import { boardPlan, globRe, applyAliases } from "./plan";
import { krtClaim, loadPlan, routeKrt, routePipeline, tmClaim, type RouterClaim } from "./route";
import { viaInPadPolicy, viaInPadReport, type ViaInPadReport } from "../release/viaproc";
import { cmpScore, copyDir, readRequirementsDir, scoreOf, type ScoreFigures } from "./score";
import type { LayoutSpec } from "./spec";
import { copperItems, footprintSpans } from "./text";

export const STAGES = ["check", "place", "rank", "route", "lastmile"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageRecord {
  status: string;
  started: number;
  verdict?: string;
  wall_s?: number;
  result?: unknown;
}
export interface PoolSeed {
  seed: number;
  gate: boolean;
  crossings: unknown;
  cost: unknown;
  wire: unknown;
  placed: string;
  why: string;
  away?: string[];
  kept?: boolean;
  /** Where the placement came from when not a KRT seed (`floorplan <file> seed N`: board_route floorplan, numbered 1000 + N). */
  source?: string;
}
export interface RankedSeed {
  seed: number;
  wall_s: number;
  score: ScoreFigures | null;
  placed: string;
  kept: boolean;
  /** What the router reported (its own model); `score.open` is the native count on the scored board. */
  claim?: RouterClaim | null;
}
export interface FlowState {
  ws: string;
  spec_path: string;
  spec: LayoutSpec;
  run_id: string;
  created: number;
  stages: Partial<Record<Stage, StageRecord>>;
  decisions: unknown[];
  place_pool?: PoolSeed[];
  best_seed?: RankedSeed;
  best_board?: ScoreFigures;
  finished?: { outcome: string; at: number };
}

export interface StageOutcome {
  verdict: string;
  ok: boolean;
  lines: string[];
  result: unknown;
  /** The board a following stage (the last mile) starts from, when the stage produced one. */
  board?: string;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
const round1 = (x: number) => Math.round(x * 10) / 10;
const rel = (spec: LayoutSpec, p: string) => (p.startsWith("builtin:") || isAbsolute(p) ? p : resolve(spec.base, "..", p));

// ---------------------------------------------------------------- state

export async function loadFlow(ws: string): Promise<FlowState> {
  const st = await readJsonOrNull<FlowState>(join(ws, "flow.json"));
  if (!st) throw new FlowError(`no workspace at ${ws}: start one with check (it initialises the workspace from the layout spec)`);
  return st;
}
const save = (ws: string, st: FlowState) => writeFile(join(ws, "flow.json"), JSON.stringify(st, null, 1) + "\n");
/** Write the workspace state (flow.json). */
export const saveFlow = (st: FlowState) => save(st.ws, st);

/** Workspace from a spec: the base project is copied in (without prl, acceptance or score files). */
export async function initFlow(wsInput: string, spec: LayoutSpec, specPath: string, now = Date.now()): Promise<FlowState> {
  const ws = resolve(wsInput);
  if (await pathExists(join(ws, "flow.json"))) throw new FlowError(`${ws} already initialised`);
  await mkdir(ws, { recursive: true });
  await copyDir(spec.base, join(ws, "base"), (n) => !(n.endsWith(".kicad_prl") || /^acceptance.*\.json$/.test(n) || n === "score.json"));
  const st: FlowState = { ws, spec_path: resolve(specPath), spec, run_id: `host-${stamp()}`, created: now / 1000, stages: {}, decisions: [] };
  await save(ws, st);
  return st;
}

async function stageBegin(host: LayoutHost, st: FlowState, name: Stage): Promise<string> {
  st.stages[name] = { status: "running", started: (host.now?.() ?? Date.now()) / 1000 };
  await save(st.ws, st);
  const d = join(st.ws, name);
  await mkdir(d, { recursive: true });
  return d;
}

async function stageEnd(host: LayoutHost, st: FlowState, name: Stage, verdict: string, result: unknown, lines: string[], board?: string): Promise<StageOutcome> {
  const s = st.stages[name]!;
  Object.assign(s, { status: verdict.split(" ")[0]!.toLowerCase(), verdict, wall_s: round1((host.now?.() ?? Date.now()) / 1000 - s.started), result });
  await save(st.ws, st);
  await writeFile(join(st.ws, name, "result.json"), JSON.stringify(s, null, 1) + "\n");
  return { verdict, ok: verdict.startsWith("PASS"), lines, result, ...(board ? { board } : {}) };
}

const boardFile = (dir: string, st: FlowState, ext = "kicad_pcb") => join(dir, `${st.spec.stem}.${ext}`);
const mustBeFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() === true;

// ---------------------------------------------------------------- check

const BOARD_NETS_A = /\(net\s+\d+\s+"([^"]*)"\)/g;
const BOARD_NETS_B = /\(net\s+"([^"]*)"\)/g;

export interface LayoutCheckOptions {
  /** Also run A3/A4/A5/A9 on the base (a DRC run). */
  full?: boolean;
}

export async function stageCheck(host: LayoutHost, st: FlowState, opts: LayoutCheckOptions = {}): Promise<StageOutcome> {
  const sp = st.spec;
  const d = await stageBegin(host, st, "check");
  const base = join(st.ws, "base");
  const fails: string[] = [];
  const warns: string[] = [];
  const info: Record<string, unknown> = {};
  const lines: string[] = [];
  const need = (ok: unknown, msg: string, fix: string) => void (ok || fails.push(`${msg} -> ${fix}`));

  // a missing engine installs here when the host can (first use); an override that is set is checked as given
  const krt = await engineReady(host, "krt");
  const tm = await engineReady(host, "tracemaker");
  need(krt.path && (await pathExists(join(krt.path, "src/plugins"))), `krt missing at ${krt.path ?? "(not installed)"}${krt.why ? ` (${krt.why})` : ""}`, "board_engines install krt, Settings → Routers, or set FABDESK_KRT_DIR");
  need(tm.path && (await pathExists(tm.path)), `tracemaker missing at ${tm.path ?? "(not installed)"}${tm.why ? ` (${tm.why})` : ""}`, "board_engines install tracemaker, Settings → Routers, or set TRACEMAKER_BIN");
  need(host.tools.kicadCli, "no KiCad CLI", "install KiCad or set KICAD_CLI");
  info["disk_gib"] = round1(await host.diskFreeGiB(st.ws));
  info["mem_avail_gib"] = round1(await host.memAvailableGiB());
  need((info["disk_gib"] as number) >= 10, `disk ${info["disk_gib"]} GiB free`, "free reproducible board copies (seeds, tries): board_route clean lists them, apply deletes");
  if ((info["mem_avail_gib"] as number) < 14) warns.push(`${info["mem_avail_gib"]} GiB available: TraceMaker (11-14 GB) would wait or OOM`);

  const pcb = boardFile(base, st);
  need(await mustBeFile(pcb), `${sp.stem}.kicad_pcb missing in base`, "spec.stem must match the project files");
  need(await mustBeFile(boardFile(base, st, "kicad_pro")), "project file missing", "copy the .kicad_pro with the board");
  const finish = async () => {
    for (const w of warns) lines.push(`WARN ${w}`);
    lines.push("info " + JSON.stringify(info));
    const verdict = fails.length ? "FAIL " + fails.join(" | ") : "PASS check";
    return stageEnd(host, st, "check", verdict, { fails, warns, info }, lines);
  };
  if (fails.length) return stageEnd(host, st, "check", "FAIL " + fails.join("; "), { fails, warns, info }, lines);

  const text = await readFile(pcb, "utf8");
  const spans = footprintSpans(text);
  const fps = new Map([...spans].map(([r, [a, b]]) => [r, text.slice(a, b)]));
  const nets = new Set([...[...text.matchAll(BOARD_NETS_A)].map((m) => m[1]!), ...[...text.matchAll(BOARD_NETS_B)].map((m) => m[1]!)]);
  info["footprints"] = fps.size;
  info["nets"] = nets.size;
  const segs = copperItems(text, ["segment", "arc"]).length; // board-level tracks only, not arcs of polygon outlines
  info["segments"] = segs;
  if (segs) warns.push(`base has ${segs} track segments: the placer moves parts under them (the layout base has its copper stripped)`);

  // fixed parts: pattern + mechanical anchors, all present
  const fixedRe = new RegExp(sp.fixed);
  const fixed = [...fps.keys()].filter((r) => fixedRe.test(r)).sort();
  info["fixed"] = fixed.length;
  const reqDir = rel(sp, sp.requirements);
  const mech = await readJsonOrNull<{ anchors?: Array<{ reference: string }> }>(join(reqDir, "mechanical.json"));
  if (mech) {
    const anchors = (mech.anchors ?? []).map((x) => x.reference);
    const missing = anchors.filter((r) => !fps.has(r));
    need(!missing.length, `anchors not on board: ${pyList(missing)}`, "board and mechanical.json disagree");
    const loose = anchors.filter((r) => !fixedRe.test(r));
    need(!loose.length, `anchors not matched by spec.fixed: ${pyList(loose)}`, "widen spec.fixed (the placer would move them)");
  }

  // courtyards: a footprint without pads (logo, graphic, board name) has nothing to collide on copper
  const noCrt = [...fps].filter(([r, b]) => !b.includes("CrtYd") && !r.startsWith("FIT_") && b.includes("(pad ")).map(([r]) => r).sort();
  need(!noCrt.length, `${noCrt.length} parts without courtyard: ${pyList(noCrt.slice(0, 8))}`, "add them: board_route {\"action\":\"courtyards\"} (courtyard DRC cannot see these parts)");

  // groups cover every movable part exactly once
  const groups = (JSON.parse(await readFile(rel(sp, sp.groups), "utf8")) as { groups: Array<{ name: string; refs: string[] }> }).groups;
  const seen = new Map<string, string[]>();
  for (const g of groups) for (const r of g.refs) (seen.get(r) ?? seen.set(r, []).get(r)!).push(g.name);
  const unknown = [...seen.keys()].filter((r) => !fps.has(r)).sort();
  const dup = [...seen].filter(([, gs]) => gs.length > 1).map(([r]) => r).sort();
  const movable = [...fps.keys()].filter((r) => !fixedRe.test(r)).sort();
  const orphan = movable.filter((r) => !seen.has(r));
  need(!unknown.length, `group refs not on board: ${pyList(unknown.slice(0, 8))}`, "regenerate groups from this board");
  need(!dup.length, `refs in several groups: ${pyList(dup.slice(0, 8))}`, "one group per part");
  if (orphan.length) warns.push(`${orphan.length} movable parts in no group (the placer packs them freely): ${pyList(orphan.slice(0, 8))}`);
  info["groups"] = groups.length;

  // templates reference parts on the board
  for (const t of sp.templates ?? []) {
    const tr = JSON.parse(await readFile(rel(sp, t), "utf8")) as { anchor?: string; members?: Array<{ ref: string }> };
    const bad = [tr.anchor, ...(tr.members ?? []).map((m) => m.ref)].filter((r): r is string => !!r && !fps.has(r));
    need(!bad.length, `template ${basename(t)}: refs not on board ${pyList(bad)}`, "refit the template to this board");
  }

  const req = await readRequirementsDir(reqDir);
  const acc = req.acceptance;
  // route plans: expand each plan for this board; every literal net glob must hit a board net (catches another board's plan)
  for (const role of ["rank", "finish", "finish_fine"] as const) {
    let plan;
    try {
      plan = boardPlan(await loadPlan(rel(sp, sp.plans[role])), acc);
    } catch (e) {
      fails.push(`plan ${role} does not expand: ${(e instanceof Error ? e.message : String(e)).slice(-200)} -> fix the plan or the acceptance`);
      continue;
    }
    const anet = new Set(nets);
    for (const [rx, rep] of plan.aliases) for (const n of nets) anet.add(applyAliases(n, [[rx, rep]]));
    for (const stg of plan.stages) {
      const args = stg.args ?? [];
      const i0 = args.indexOf("--nets");
      if (i0 < 0) continue;
      for (let i = i0 + 1; i < args.length && !args[i]!.startsWith("--"); i++) {
        const a = args[i]!;
        if (!a.startsWith("@") && !a.startsWith("!") && ![...anet].some((n) => globRe(a).test(n)))
          fails.push(`plan ${role}:${stg.name} net glob ${pyRepr(a)} matches no board net -> use the generic plans or regenerate this one`);
      }
    }
  }
  const pairs = Object.values(acc.net_classes.classes).flatMap((c) => c.pairs ?? []);
  const lost = pairs.filter((p) => !nets.has(p[0]) || !nets.has(p[1]));
  need(!lost.length, `${lost.length} acceptance pairs not on board: ${pyList(lost.slice(0, 4).map((p) => `[${pyRepr(p[0])}, ${pyRepr(p[1])}]`), false)}`, "acceptance pairs must use board net names");
  info["pairs"] = pairs.length;
  const unclassed = Object.values(acc.net_classes.classes).flatMap((c) => c.nets ?? []).filter((n) => !nets.has(n));
  need(!unclassed.length, `class nets not on board: ${pyList(unclassed.slice(0, 6))}`, "acceptance classes must use board net names");

  // optional: A3/A4/A5/A9 on the base (a DRC run)
  if (opts.full && !fails.length) {
    const drcFile = join(d, "acceptance.drc.json");
    try {
      const drc = await host.scoreDrc(pcb, drcFile, true);
      const res = checkAcceptance(parseBoard(text), req, drc, { boardPath: pcb });
      await writeFile(join(d, "acceptance.json"), JSON.stringify(res, null, 1) + "\n");
      info["acceptance"] = res.summary;
      for (const k of ["A3_parity", "A4_circuit", "A5_anchors", "A9_heights"] as const) need(res.summary[k], `base fails ${k}`, `see ${join(d, "acceptance.json")}`);
    } catch (e) {
      fails.push(`acceptance on the base failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return finish();
}

const pyRepr = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const pyList = (xs: string[], quote = true) => `[${xs.map((x) => (quote ? pyRepr(x) : x)).join(", ")}]`;

// ---------------------------------------------------------------- place

export interface PlaceOpts {
  seeds?: string;
  jobs?: number;
}

export async function stagePlace(host: LayoutHost, st: FlowState, opts: PlaceOpts = {}): Promise<StageOutcome> {
  const sp = st.spec;
  if (st.stages.check?.status !== "pass") throw new FlowError("run check first (fail fast: nothing heavy before the preflight passes)");
  const seeds = opts.seeds ?? "0-7";
  const d = await stageBegin(host, st, "place");
  const out = join(d, `seeds-${seeds}`);
  await rm(out, { recursive: true, force: true });
  const lines: string[] = [];
  if (sp.keepouts?.length) await writeFile(join(d, "keepouts.json"), JSON.stringify(sp.keepouts, null, 1));
  let rec: PlaceRecord;
  try {
    rec = await admitted(host, "router", `place seeds ${seeds}`, [join(st.ws, "base")], () =>
      placeKrt(host, {
        placed: join(st.ws, "base"),
        out,
        stem: sp.stem,
        groups: rel(sp, sp.groups),
        seeds,
        fixed: new RegExp(sp.fixed),
        jobs: opts.jobs ?? 4,
        templates: (sp.templates ?? []).map((t) => rel(sp, t)),
        ...(sp.keepouts?.length ? { keepouts: sp.keepouts } : {}),
        ...(sp.clustered_seeds ? { clusteredSeeds: sp.clustered_seeds } : {}),
        timeoutMs: (sp.budgets_min?.place ?? 20) * 60_000,
      }),
    );
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    return stageEnd(host, st, "place", `FAIL placer produced no place.json (${e.message}) -> ${d}`, {}, lines);
  }
  const acc = (await readRequirementsDir(rel(sp, sp.requirements))).acceptance;
  const seedList: PoolSeed[] = [];
  for (const [sd, r] of Object.entries(rec.seeds)) {
    const pl = (r.placer ?? {}) as Record<string, unknown>;
    seedList.push({
      seed: Number(sd),
      gate: r.gate ?? false,
      crossings: pl["crossings"] ?? null,
      cost: pl["cost"] ?? null,
      wire: pl["wire"] ?? null,
      placed: join(out, `s${sd}`, "placed"),
      why: r.error ?? (r.courtyard && Object.keys(r.courtyard).length ? `courtyard ${JSON.stringify(r.courtyard)}` : ""),
    });
    const s = seedList[seedList.length - 1]!;
    if (!s.why && r.fixed_moved?.length) s.why = `fixed moved ${pyList(r.fixed_moved)}`;
  }
  // Pin facing per seed (< 1 s): pair pins facing away from their far end cannot be fixed by routing. Reported, never ranked.
  for (const s of seedList) {
    const b = boardFile(s.placed, st);
    if (s.gate && (await pathExists(b))) {
      s.away = facing(parseBoard(await readFile(b, "utf8")), acc)
        .filter((x) => x.faces_away)
        .map((x) => `${x.chip}:${x.pair.split(" / ")[0]}`);
    }
  }
  const prev = st.place_pool ?? [];
  const pool = [...prev.filter((s) => !seedList.some((x) => x.seed === s.seed)), ...seedList];
  st.place_pool = pool;
  const num = (v: unknown) => (typeof v === "number" ? v : 1e9);
  const ok = pool.filter((s) => s.gate).sort((a, b) => num(a.crossings) - num(b.crossings) || num(a.cost) - num(b.cost));
  // Cull by placer crossings is off by default (keep fraction 1.0): measured Spearman 0.69 on one board, and on another it
  // would have dropped the best seed. Seeds are sorted by crossings so a cull, if set in the spec, keeps the lower ones.
  const keep = ok.length ? Math.max(2, Math.ceil(ok.length * (sp.cull_keep_fraction ?? 1.0))) : 0;
  ok.forEach((s, i) => (s.kept = i < keep));
  for (const s of [...pool].sort((a, b) => a.seed - b.seed))
    lines.push(
      `seed ${String(s.seed).padStart(2)}  gate ${s.gate ? "ok " : "NO "} crossings ${s.crossings}  cost ${Math.round(Number(s.cost ?? 0))}  away ${(s.away ?? []).length}  ${s.kept ? "KEEP" : ""} ${s.why}` +
        (s.away?.length ? `  [${s.away.join(", ")}]` : ""),
    );
  await save(st.ws, st);
  if (!ok.length)
    return stageEnd(host, st, "place", "STOP no seed passed the gates: read the reasons above, then change groups, templates or spacing (agent decision) and run place again", { seeds: pool }, lines);
  return stageEnd(host, st, "place", `PASS place ${ok.length}/${pool.length} gated, ${keep} kept for rank`, { seeds: pool }, lines);
}

// ---------------------------------------------------------------- rank

export interface RankOpts {
  jobs?: number;
  /** Route every gated seed, not only the kept ones (calibrates the crossings cull; costs twice as much). */
  all?: boolean;
}

export async function stageRank(host: LayoutHost, st: FlowState, opts: RankOpts = {}): Promise<StageOutcome> {
  const sp = st.spec;
  const pool = (st.place_pool ?? []).filter((s) => s.kept || (opts.all && s.gate));
  if (!pool.length) throw new FlowError("no kept seeds: run place first");
  const d = await stageBegin(host, st, "rank");
  const budget = (sp.budgets_min?.rank_seed ?? 25) * 60_000;
  const req = await readRequirementsDir(rel(sp, sp.requirements));
  const lines: string[] = [];
  const one = async (s: PoolSeed): Promise<RankedSeed> => {
    const out = join(d, `s${s.seed}`);
    await rm(out, { recursive: true, force: true });
    const t0 = Date.now();
    try {
      await admitted(host, "router", `rank seed ${s.seed}`, [s.placed], () =>
        routeKrt(host, { placed: s.placed, out, plan: rel(sp, sp.plans.rank), stem: sp.stem, req, score: true, budgetMs: budget }),
      );
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      await mkdir(out, { recursive: true });
      await writeFile(join(d, `s${s.seed}.log`), `${e.message}\n`);
    }
    return { seed: s.seed, wall_s: round1((Date.now() - t0) / 1000), score: await scoreOf(join(out, "score")), placed: s.placed, kept: s.kept ?? false, claim: krtClaim(await readJsonOrNull(join(out, "krt.json"))) };
  };
  lines.push(NATIVE_NOTE);
  const res: RankedSeed[] = [];
  const queue = [...pool];
  const workers = Array.from({ length: Math.max(1, opts.jobs ?? 4) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await one(s);
      res.push(r);
      const line = `seed ${String(r.seed).padStart(2)}  ${String(Math.round(r.wall_s)).padStart(6)}s  ` + (r.score ? `open ${r.score.open}  A8 ${r.score.A8}  A7 ${r.score.A7}` : "no score (timeout or router failure)") + claimNote(r.claim);
      lines.push(line);
      host.log?.(line);
    }
  });
  await Promise.all(workers);
  res.sort((a, b) => a.seed - b.seed);
  const good = res.filter((r) => r.score).sort((a, b) => cmpScore(a.score!, b.score!));
  if (!good.length) return stageEnd(host, st, "rank", "FAIL no seed routed: see rank/s*/ logs", { seeds: res }, lines);
  const best = good[0]!;
  st.best_seed = best;
  return stageEnd(host, st, "rank", `PASS rank best seed ${best.seed} open ${best.score!.open}`, { seeds: res }, lines);
}

// ---------------------------------------------------------------- route

export async function stageRoute(host: LayoutHost, st: FlowState): Promise<StageOutcome> {
  const sp = st.spec;
  const best = st.best_seed;
  if (!best?.score) throw new FlowError("run rank first");
  const d = await stageBegin(host, st, "route");
  const req = await readRequirementsDir(rel(sp, sp.requirements));
  const B = sp.budgets_min ?? {};
  const results: Record<string, ScoreFigures | string | number | null> = {};
  const claims: Record<string, RouterClaim | null> = {};
  const lines: string[] = [NATIVE_NOTE];

  const krtFinish = async (src: string, name: string): Promise<ScoreFigures | null> => {
    const f1 = join(d, name);
    await rm(f1, { recursive: true, force: true });
    const run = (placed: string, out: string, plan: string, label: string) =>
      admitted(host, "router", label, [placed], () => routeKrt(host, { placed, out, plan: rel(sp, plan), stem: sp.stem, req, score: true, budgetMs: (B.finish ?? 15) * 60_000 })).catch((e) => {
        if (!(e instanceof FlowError)) throw e;
      });
    await run(src, f1, sp.plans.finish, `route ${name}`);
    const s1 = await scoreOf(join(f1, "score"));
    results[name] = s1;
    claims[name] = krtClaim(await readJsonOrNull(join(f1, "krt.json")));
    if (!s1) return null;
    const f2 = join(d, `${name}-g`);
    await rm(f2, { recursive: true, force: true });
    await run(join(f1, "score"), f2, sp.plans.finish_fine, `route ${name}-g`);
    results[`${name}-g`] = await scoreOf(join(f2, "score"));
    claims[`${name}-g`] = krtClaim(await readJsonOrNull(join(f2, "krt.json")));
    return (results[`${name}-g`] as ScoreFigures | null) ?? s1;
  };

  const tmBranch = async (): Promise<ScoreFigures | null> => {
    const tmReady = await engineReady(host, "tracemaker");
    if (!tmReady.path) {
      results["tm"] = null;
      results["tm_skipped"] = tmReady.why ?? "TraceMaker is not installed";
      return null;
    }
    const t0 = Date.now();
    const tm = join(d, "tm");
    // One TraceMaker job per machine (11-14 GB): the governor admits one `tracemaker` job at a time and waits for memory;
    // a TraceMaker started by another process is waited on too.
    await admitted(host, "tracemaker", "route TraceMaker", [best.placed], async () => {
      for (let noted = false; host.tracemakerBusy && !host.signal?.aborted && (await host.tracemakerBusy()); noted = true) {
        if (!noted) host.log?.("waiting: a TraceMaker outside this job is running (one per machine)");
        await new Promise((r) => setTimeout(r, 15_000));
      }
      results["tm_lock_wait_s"] = round1((Date.now() - t0) / 1000);
      await rm(tm, { recursive: true, force: true });
      await routePipeline(host, { placed: best.placed, out: tm, plan: rel(sp, sp.plans.tm), stem: sp.stem, req, budgetMs: (B.tm ?? 20) * 60_000, planRoot: resolve(sp.base, "..") }).catch((e) => {
        if (!(e instanceof FlowError)) throw e;
        lines.push(`TraceMaker: ${e.message}`);
      });
    });
    results["tm"] = await scoreOf(join(tm, "score"));
    claims["tm"] = tmClaim(await readJsonOrNull(join(tm, "pipeline.json")));
    return results["tm"] ? krtFinish(join(tm, "score"), "tm-f") : null;
  };

  // Hedge: a KRT finish of the rank route runs beside the TraceMaker branch; the better result is kept.
  await Promise.all([tmBranch(), krtFinish(best.score.dir, "rank-f")]);
  // Via-in-pad policy on every routed result, against the placed board it started from: a result that adds vias in solder
  // pads the requirements do not allow is reported and left out (adoption would refuse it).
  const policy = viaInPadPolicy(req.acceptance.manufacturing_rules.via_in_pad);
  const placedText = await readFile(boardFile(best.placed, st), "utf8").catch(() => null);
  const viaInPad: Record<string, ViaInPadReport> = {};
  // a result the check cannot read is left out too (unless the policy allows vias in pads anyway): never passed unchecked
  const unchecked = new Set<string>();
  for (const [k, v] of Object.entries(results)) {
    if (!v || typeof v !== "object") continue;
    const routed = await readFile(join(v.dir, `${sp.stem}.kicad_pcb`), "utf8").catch(() => null);
    let r: ViaInPadReport | null = null;
    try {
      r = placedText === null || routed === null ? null : viaInPadReport(placedText, routed, policy);
    } catch {
      r = null;
    }
    if (r === null) unchecked.add(k);
    else if (r.vias.length) viaInPad[k] = r;
  }
  if (unchecked.size && !policy.allowed) lines.push(`via-in-pad check could not run on ${[...unchecked].join(", ")}: left out`);
  for (const [k, v] of Object.entries(results)) {
    if (v && typeof v === "object") lines.push(`${k.padEnd(10)} open ${v.open}  A8 ${v.A8}  A7 ${v.A7}  drc ${JSON.stringify(v.drc)}${claimNote(claims[k])}${viaInPad[k] ? `  [${viaInPad[k].vias.length} new via(s) in pads${policy.allowed ? "" : ", not allowed: left out"}]` : ""}`);
    else if (v !== null) lines.push(`${k.padEnd(10)} ${v}`);
  }
  for (const [k, r] of Object.entries(viaInPad)) lines.push(`${k}: ${r.text}`);
  const record = { ...results, claims, ...(Object.keys(viaInPad).length ? { via_in_pad: viaInPad } : {}) };
  const routedResults = Object.entries(results).filter((e): e is [string, ScoreFigures] => !!e[1] && typeof e[1] === "object");
  const cands = routedResults.filter(([k]) => policy.allowed || (!viaInPad[k] && !unchecked.has(k))).map(([, v]) => v);
  if (!routedResults.length) return stageEnd(host, st, "route", "FAIL no routed result: see route/*/ logs", record, lines);
  if (!cands.length)
    return stageEnd(host, st, "route", "STOP every routed result adds vias in solder pads and manufacturing_rules.via_in_pad does not allow them: record a justified {allow:true,basis} in the board's acceptance, or change the route plans, then run route again", record, lines);
  const win = [...cands].sort(cmpScore)[0]!;
  st.best_board = win;
  const lim = sp.lastmile_max_open ?? 25;
  if (win.open! > lim)
    return stageEnd(host, st, "route", `STOP best open ${win.open} > ${lim}: placement problem, not a last-mile job. Look at the board (${win.dir}), change groups or templates for the cluster, run place again with new seeds`, record, lines, join(win.dir, `${sp.stem}.kicad_pcb`));
  return stageEnd(host, st, "route", `PASS route best open ${win.open} A8 ${win.A8} A7 ${win.A7} (${win.dir})`, record, lines, join(win.dir, `${sp.stem}.kicad_pcb`));
}

/** How the stage lines read their figures: `open` is the saved board's native count, a router's own claim follows it. */
const NATIVE_NOTE = "open = KiCad DRC unconnected items on the scored board (native, authoritative); a router's own claim follows in brackets";
const claimNote = (c: RouterClaim | null | undefined) => (c ? `  [router: ${c.text}]` : "");

// ---------------------------------------------------------------- status, next, finish, auto

export function nextStep(st: FlowState): { stage: Stage | null; text: string } {
  const why: Record<Stage, string> = {
    check: "preflight: catches a wrong spec, missing courtyards, foreign plans and low disk in seconds",
    place: "placer seeds with native gates, culled by placer crossings",
    rank: "only routing separates seeds; kept seeds route in parallel",
    route: "best seed through TraceMaker and KRT finishing, hedged",
    lastmile: "last-mile bench on the best board",
  };
  for (const n of STAGES) {
    const s = st.stages[n];
    if (n === "lastmile") break;
    if (!s || s.status === "running") return { stage: n, text: `board_route {"action": "${n}"}\n  why: ${why[n]}` };
    if (s.status === "fail" || s.status === "stop") return { stage: null, text: `blocked at ${n}: ${s.verdict}\n  decide, change the spec/groups/templates, then: board_route {"action": "${n}"}` };
  }
  return { stage: null, text: `layout done; the route stage's board is the last mile's input (${st.best_board?.dir ?? "?"}). Finish with board_route {"action": "status", "finish": "success"|"failed"|"blocked"}` };
}

export function statusLines(st: FlowState): string[] {
  const lines = [`${st.spec.name}  ws ${st.ws}  run ${st.run_id}  elapsed ${(((Date.now() / 1000) - st.created) / 60).toFixed(1)} min`];
  for (const n of STAGES.slice(0, 4)) {
    const s = st.stages[n];
    lines.push(s ? `  ${n.padEnd(9)} ${s.status.padEnd(8)} ${((s.wall_s ?? 0) / 60).toFixed(1).padStart(5)} min  ${(s.verdict ?? "").slice(0, 110)}` : `  ${n.padEnd(9)} -`);
  }
  if (st.best_board) lines.push(`  best: open ${st.best_board.open} A8 ${st.best_board.A8} A7 ${st.best_board.A7}  ${st.best_board.dir}`);
  return lines;
}

export async function finishFlow(st: FlowState, outcome: "success" | "failed" | "blocked"): Promise<string> {
  st.finished = { outcome, at: Date.now() / 1000 };
  await save(st.ws, st);
  return `finished ${st.run_id}: ${outcome} (` + Object.entries(st.stages).map(([k, v]) => `${k} ${v.wall_s} s`).join(", ") + ")";
}

export interface AutoOpts extends PlaceOpts, RankOpts {
  until?: Exclude<Stage, "lastmile">;
}

/** Run the remaining stages in order up to `until`; stop at the first FAIL/STOP (the agent's decision point). */
export async function runAuto(host: LayoutHost, st: FlowState, opts: AutoOpts = {}): Promise<{ stopped: StageOutcome | null; ran: Array<{ stage: Stage; outcome: StageOutcome }> }> {
  const ran: Array<{ stage: Stage; outcome: StageOutcome }> = [];
  const until = opts.until ?? "route";
  for (const n of STAGES.slice(0, STAGES.indexOf(until) + 1)) {
    if (st.stages[n]?.status === "pass") continue;
    host.log?.(`== ${n}`);
    const outcome =
      n === "check" ? await stageCheck(host, st, { full: true }) : n === "place" ? await stagePlace(host, st, opts) : n === "rank" ? await stageRank(host, st, opts) : await stageRoute(host, st);
    ran.push({ stage: n, outcome });
    if (!outcome.ok) return { stopped: outcome, ran };
  }
  return { stopped: null, ran };
}

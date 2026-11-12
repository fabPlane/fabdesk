/**
 * Routing a placed board with a staged plan: KiCadRoutingTools stages (`routeKrt`, port of `route_krt.py`) and the
 * TraceMaker session + CLI pipeline (`routePipeline`, port of `route_pipeline.py`). Each ends with `scoreRoute`.
 * The engines are programs run through `host.spawn`; this file owns the plan, the working copies and the merge.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Acceptance, Requirements } from "../requirements";
import { readJsonOrNull } from "../files";
import { FlowError, type LayoutHost } from "./ctx";
import { krtPaths, krtRouterScript, routeSummaries } from "./engines";
import { pathExists } from "./fsx";
import { applyAliases, boardPlan, expandArgs, pairClasses, signalLayers, BUILTIN_PLANS, type ExpandedPlan, type KrtPlan, type Selectors } from "./plan";
import { applyNetclasses, copyDir, scoreRoute } from "./score";
import { appendBeforeClose, convertTransforms } from "./text";

/** A plan by reference: a JSON file, or `builtin:<role>`. */
export async function loadPlan(ref: string): Promise<KrtPlan> {
  if (ref.startsWith("builtin:")) {
    const p = BUILTIN_PLANS[ref.slice(8)];
    if (!p) throw new FlowError(`no builtin plan ${ref}`);
    return structuredClone(p) as KrtPlan;
  }
  return JSON.parse(await readFile(ref, "utf8")) as KrtPlan;
}

const q = (s: string) => `"${s}"`;

export interface RouteKrtOptions {
  placed: string;
  out: string;
  plan: string;
  stem: string;
  req: Requirements;
  score: boolean;
  /** Wall-clock budget for the whole run (the toolkit killed the process at its budget). */
  budgetMs?: number;
}
export interface RouteKrtRecord {
  stages: Array<Record<string, unknown>>;
  wall_s?: number;
  error?: string;
}

/** Run a KRT plan on `placed`; `<out>/score` holds the scored board when `score` is set and every stage wrote a board. */
export async function routeKrt(host: LayoutHost, o: RouteKrtOptions): Promise<RouteKrtRecord> {
  if (!host.tools.krt) throw new FlowError("KiCadRoutingTools is not configured (FABDESK_KRT_DIR)");
  const acc = o.req.acceptance;
  const plan = boardPlan(await loadPlan(o.plan), acc);
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  await mkdir(o.out, { recursive: true });
  await writeFile(join(o.out, "plan.json"), JSON.stringify(plan, null, 1) + "\n");
  const k = krtPaths(plan.krt?.root ?? host.tools.krt);
  const native = join(o.placed, `${o.stem}.kicad_pcb`);

  // KRT input: (at ...) poses, aliased net names, project files beside every stage board.
  let text = applyAliases(convertTransforms(await readFile(native, "utf8")).text, plan.aliases);
  let fenceRules = "";
  for (const [i, fe] of (plan.fences ?? []).entries()) {
    const name = fe.name ?? `fence${i}`;
    const [x0, y0, x1, y1] = fe.box;
    const nets = [...new Set([...text.matchAll(/\(net "([^"]+)"\)/g)].map((m) => m[1]!))].filter((n) => new RegExp(fe.nets).test(n)).sort();
    if (!nets.length) throw new FlowError(`fence ${name}: no net matches ${JSON.stringify(fe.nets)}`);
    const layers = (fe.layers ?? signalLayers(acc)).map(q).join(" ");
    text = appendBeforeClose(
      text,
      `\n  (zone (net "") (layers ${layers}) (uuid "${randomUUID()}") (name "${name}") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.15)` +
        ` (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))` +
        ` (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))\n`,
    );
    fenceRules += `(rule "fence ${name}"\n  (constraint disallow track via)\n  (condition "A.intersectsArea('${name}') && (${nets.map((n) => `A.NetName == '${n}'`).join(" || ")})"))\n`;
  }
  const krtIn = join(o.out, "s0.kicad_pcb");
  await writeFile(krtIn, text);
  const project = async (stem: string) => {
    for (const ext of ["kicad_pro", "kicad_dru"]) if (await pathExists(join(o.placed, `${o.stem}.${ext}`))) await copyFile(join(o.placed, `${o.stem}.${ext}`), join(o.out, `${stem}.${ext}`));
    if (fenceRules) {
      const dru = join(o.out, `${stem}.kicad_dru`);
      await writeFile(dru, ((await pathExists(dru)) ? await readFile(dru, "utf8") : "(version 1)\n") + fenceRules);
    }
  };
  await project("s0");

  const sel: Selectors = { pairsToReroute: [], cutNets: [], openBefore: [] };
  const accOfPlaced = await readJsonOrNull<{ results?: { A8_pairs?: { pairs_to_reroute?: string[][] } } }>(join(o.placed, "acceptance.json"));
  sel.pairsToReroute = accOfPlaced?.results?.A8_pairs?.pairs_to_reroute ?? [];
  const rip = await readJsonOrNull<{ nets?: string[]; open_before?: string[] }>(join(o.placed, "rip.json"));
  const nudge = await readJsonOrNull<{ cut_nets?: string[] }>(join(o.placed, "nudge.json"));
  sel.cutNets = [...(rip?.nets ?? []), ...(nudge?.cut_nets ?? [])];
  sel.openBefore = rip?.open_before ?? [];

  const record: RouteKrtRecord = { stages: [] };
  let cur = krtIn;
  const t0 = Date.now();
  for (const [i, st] of plan.stages.entries()) {
    const nxt = join(o.out, `s${i + 1}.kicad_pcb`);
    const args = expandArgs(st.args ?? [], plan, acc, sel);
    if (args === null) {
      record.stages.push({ name: st.name, tool: st.tool, skipped: "nothing selected" });
      continue;
    }
    await project(`s${i + 1}`);
    const log = join(o.out, `s${i + 1}-${st.name}.log`);
    const remaining = o.budgetMs ? o.budgetMs - (Date.now() - t0) : undefined;
    if (remaining !== undefined && remaining <= 0) {
      record.error = `budget exhausted before stage ${st.name}`;
      break;
    }
    const r = await host.spawn([...k.python, krtRouterScript(k, st.tool), cur, nxt, ...args, ...(plan.common ?? [])], {
      cwd: k.plugins,
      env: { ...plan.env, ...st.env },
      log,
      ...(remaining !== undefined ? { timeoutMs: remaining } : {}),
      ...(host.signal ? { signal: host.signal } : {}),
      ...(host.onPid ? { onPid: host.onPid } : {}),
    });
    const rec = { name: st.name, tool: st.tool, exit: r.code, wall_s: r.wallS, ...routeSummaries(await readFile(log, "utf8").catch(() => "")) };
    record.stages.push(rec);
    host.log?.(JSON.stringify({ name: rec.name, exit: rec.exit, wall_s: rec.wall_s }));
    if (!(await pathExists(nxt))) {
      record.error = `stage ${st.name} wrote no board`;
      break;
    }
    cur = nxt;
  }
  record.wall_s = Math.round((Date.now() - t0) / 100) / 10;
  const routed = join(o.out, "routed-native-names.kicad_pcb");
  await writeFile(routed, applyAliases(await readFile(cur, "utf8"), plan.unaliases));
  await writeFile(join(o.out, "krt.json"), JSON.stringify(record, null, 1) + "\n");
  if (o.score && !record.error) {
    // The router input again, in native names: new copper is whatever the routed board has beyond it.
    const raw = join(o.out, "krt-in-native-names.kicad_pcb");
    await writeFile(raw, convertTransforms(await readFile(native, "utf8")).text);
    try {
      await scoreRoute({ drc: host.scoreDrc }, o.req, o.stem, o.placed, join(o.out, "score"), { kind: "tm", source: raw, routed, replace: plan.merge === "replace" });
    } finally {
      await rm(raw, { force: true });
    }
  }
  return record;
}

// ---------------------------------------------------------------- TraceMaker

interface TmPlan {
  planes?: string;
  escape?: unknown;
  session?: Array<{ name: string; nets: string | string[]; work?: number; variants?: number; hints?: Record<string, any>; options?: Record<string, unknown>; seed?: number; first?: boolean }>;
  cli?: { work?: number; no_neck?: string | string[] | null; extra?: string[] };
}

function tmNets(spec: string | string[], acc: Acceptance): string[] {
  const classes = acc.net_classes.classes;
  if (spec === "@pairs") return Object.values(pairClasses(acc)).flatMap((c) => (c.pairs ?? []).flat());
  if (spec === "@outer_only_power")
    return Object.entries(classes).filter(([k, c]) => k.startsWith("PWR_") && "inner_track_width" in c && c.inner_track_width === null).flatMap(([, c]) => c.nets ?? []);
  return spec as string[];
}

export interface RoutePipelineOptions {
  placed: string;
  out: string;
  plan: string;
  stem: string;
  req: Requirements;
  budgetMs?: number;
}

/** TraceMaker: session stages for the plan's nets, then the CLI for everything left; scored into `<out>/score`. */
export async function routePipeline(host: LayoutHost, o: RoutePipelineOptions): Promise<Record<string, unknown>> {
  const tmBin = host.tools.tracemaker;
  if (!tmBin) throw new FlowError("TraceMaker is not installed (Settings → Routers, or TRACEMAKER_BIN)");
  const acc = o.req.acceptance;
  const plan = (await loadPlan(o.plan)) as unknown as TmPlan;
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  const noTrack = acc.stack_policy.no_track_layers ?? [];
  const log: { placed: string; plan: string; stages: Array<Record<string, unknown>>; [k: string]: unknown } = { placed: o.placed, plan: o.plan, stages: [] };
  const base = join(o.out, "base");
  await copyDir(o.placed, base, (n) => n !== "tm" && !n.endsWith(".json"));
  if (await pathExists(join(o.placed, "manufacturing-via-process.json"))) await copyFile(join(o.placed, "manufacturing-via-process.json"), join(base, "manufacturing-via-process.json"));
  if (plan.planes || plan.escape) throw new FlowError("plan.planes / plan.escape (power_planes, power_escape) are not ported to the TypeScript workflow");
  await applyNetclasses(join(base, `${o.stem}.kicad_pro`), acc);
  const tm = join(o.out, "tm");
  await mkdir(tm, { recursive: true });
  const board = join(tm, `${o.stem}.kicad_pcb`);
  await writeFile(board, convertTransforms(await readFile(join(base, `${o.stem}.kicad_pcb`), "utf8")).text);
  const proj = async (dir: string) => {
    for (const ext of ["kicad_pro", "kicad_dru"]) if (await pathExists(join(base, `${o.stem}.${ext}`))) await copyFile(join(base, `${o.stem}.${ext}`), join(dir, `${o.stem}.${ext}`));
  };
  await proj(tm);
  const t0 = Date.now();
  const spawnOpts = { ...(host.signal ? { signal: host.signal } : {}), ...(host.onPid ? { onPid: host.onPid } : {}) };
  let current = board;
  if (plan.session?.length) {
    const reqs: unknown[] = [{ tool: "board_info", args: {} }];
    for (const st of plan.session) {
      const args: Record<string, any> = {
        nets: tmNets(st.nets, acc),
        work: st.work ?? 30000000,
        variants: st.variants ?? 8,
        verify: "report",
        hints: { version: 1, ...st.hints },
        options: st.options ?? { soft_zones: true },
      };
      const lay = (args["hints"].layers ??= {});
      lay.no_tracks = [...new Set([...(lay.no_tracks ?? []), ...noTrack])].sort();
      if (st.seed !== undefined) args["seed"] = st.seed;
      if (st.first) args["hints"].first_nets = args["nets"];
      reqs.push({ tool: "route", args });
    }
    reqs.push({ tool: "check", args: { full: true, refill: true } }, { tool: "save", args: { refill: false } });
    await writeFile(join(tm, "requests.jsonl"), reqs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s1 = join(tm, "session");
    await mkdir(s1, { recursive: true });
    await proj(s1); // TraceMaker finds rules by basename, so the output keeps the stem beside its project files
    const remaining = o.budgetMs ? o.budgetMs - (Date.now() - t0) : undefined;
    await host.spawn([tmBin, "session", current, "--out", join(s1, `${o.stem}.kicad_pcb`), "--jsonl", "--threads", "8", "--log", join(tm, "session-log.jsonl")], {
      log: join(tm, "session.err"),
      stdin: join(tm, "requests.jsonl"),
      stdout: join(tm, "responses.jsonl"),
      ...(remaining ? { timeoutMs: remaining } : {}),
      ...spawnOpts,
    });
    const resp = ((await readFile(join(tm, "responses.jsonl"), "utf8").catch(() => "")) as string)
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const [i, st] of plan.session.entries()) {
      const r = resp[i + 1];
      if (r) log.stages.push({ stage: st.name, routed: r["routed"], open_after: r["open_after"], added_errors: r["added_errors"], error: r["error"] });
    }
    log["session_s"] = Math.round((Date.now() - t0) / 100) / 10;
    current = join(s1, `${o.stem}.kicad_pcb`);
  }
  if (plan.cli) {
    const r = join(tm, "cli");
    await mkdir(r, { recursive: true });
    await proj(r);
    const cmd = [tmBin, "route", current, "-o", join(r, `${o.stem}.kicad_pcb`), "--soft-zones", ...(noTrack.length ? ["--no-tracks-on", noTrack.join(",")] : []), "--work", String(plan.cli.work ?? 50000000), "--threads", "8", ...(plan.cli.extra ?? [])];
    const nn = plan.cli.no_neck ? tmNets(plan.cli.no_neck, acc) : [];
    if (nn.length) cmd.push("--no-neck-nets", nn.join(","));
    const t1 = Date.now();
    const remaining = o.budgetMs ? o.budgetMs - (Date.now() - t0) : undefined;
    const res = await host.spawn(cmd, { log: join(tm, "cli.log"), ...(remaining ? { timeoutMs: Math.max(1000, remaining) } : {}), ...spawnOpts });
    const line = (await readFile(join(tm, "cli.log"), "utf8").catch(() => "")).split("\n").find((l) => l.startsWith("routed ")) ?? "";
    log.stages.push({ stage: "cli", summary: line, exit: res.code });
    log["cli_s"] = Math.round((Date.now() - t1) / 100) / 10;
    current = join(r, `${o.stem}.kicad_pcb`);
  }
  if (!(await pathExists(current))) throw new FlowError("TraceMaker wrote no board");
  const score = await scoreRoute({ drc: host.scoreDrc }, o.req, o.stem, base, join(o.out, "score"), { kind: "tm", source: board, routed: current, replace: false });
  log["score"] = score;
  await writeFile(join(o.out, "pipeline.json"), JSON.stringify(log, null, 1) + "\n");
  return log;
}

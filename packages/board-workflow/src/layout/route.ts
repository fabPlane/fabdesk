/**
 * Routing a placed board with a staged plan: KiCadRoutingTools stages (`routeKrt`, port of `route_krt.py`) and the
 * TraceMaker session + CLI pipeline (`routePipeline`, port of `route_pipeline.py`). Each ends with `scoreRoute`.
 * The engines are programs run through `host.spawn`; this file owns the plan, the working copies and the merge.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Acceptance, Requirements } from "../requirements";
import { checkPlanesPlan, powerEscape, powerPlanes } from "../power/index";
import { readJsonOrNull } from "../files";
import { FlowError, requireEngine, type LayoutHost } from "./ctx";
import { krtPaths, krtRouterScript, routeSummaries } from "./engines";
import { pathExists } from "./fsx";
import { applyAliases, avoidLayersInPlan, boardPlan, expandArgs, pairClasses, signalLayers, BUILTIN_PLANS, type ExpandedPlan, type KrtPlan, type Selectors } from "./plan";
import { applyNetclasses, copyDir, scoreRoute } from "./score";
import { checkKrtOverrides, hasKrtOverrides, hasPairStageOptions, krtStageCommand, pairOptionsInPlan, KRT_OVERRIDE_FILE, KRT_OVERRIDE_SCRIPT, type PairOptionsRecord, type PairStageOptions } from "./krt-override";
import { appendBeforeClose, convertTransforms } from "./text";
import { viaInPadPolicy, viaInPadReport, type ViaInPadPolicy } from "../release/viaproc";

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
  /** A plan file, `builtin:<role>`, or the plan itself (a last-mile step carries its edited copy). */
  plan: string | KrtPlan;
  stem: string;
  req: Requirements;
  score: boolean;
  /** Wall-clock budget for the whole run (the toolkit killed the process at its budget). */
  budgetMs?: number;
  /** Layers kept out of reach after the plan's macros expand (`avoidLayersInPlan`: inner left out, outer costed). */
  avoidLayers?: readonly string[];
  /**
   * Options for the plan's pair stages (`route_diff`), applied after its macros expand (`pairOptionsInPlan`): KRT's
   * short-leg rule lowered through the override wrapper, intra-pair length matching. Refused when the plan has no pair stage.
   */
  pairOptions?: PairStageOptions;
}
export interface RouteKrtRecord {
  stages: Array<Record<string, unknown>>;
  /** What `avoidLayers` did, per stage. */
  avoided?: Array<{ stage: string; removed: string[]; costed: string[] }>;
  /** What `pairOptions` did, per pair stage. */
  pair_options?: PairOptionsRecord[];
  wall_s?: number;
  error?: string;
}

/** Run a KRT plan on `placed`; `<out>/score` holds the scored board when `score` is set and every stage wrote a board. */
export async function routeKrt(host: LayoutHost, o: RouteKrtOptions): Promise<RouteKrtRecord> {
  const krtRoot = await requireEngine(host, "krt");
  const acc = o.req.acceptance;
  let plan = boardPlan(typeof o.plan === "string" ? await loadPlan(o.plan) : structuredClone(o.plan), acc);
  let avoided: RouteKrtRecord["avoided"];
  if (o.avoidLayers?.length) ({ plan, record: avoided } = avoidLayersInPlan(plan, o.avoidLayers));
  let pairRec: RouteKrtRecord["pair_options"];
  if (hasPairStageOptions(o.pairOptions)) {
    try {
      ({ plan, record: pairRec } = pairOptionsInPlan(plan, o.pairOptions));
    } catch (e) {
      throw new FlowError(e instanceof Error ? e.message : String(e));
    }
  }
  // every stage's overrides checked before anything runs (a plan file may carry its own)
  const overrides = plan.stages.map((st) => {
    try {
      return checkKrtOverrides(st["krt_overrides"], `stage ${st.name}`);
    } catch (e) {
      throw new FlowError(e instanceof Error ? e.message : String(e));
    }
  });
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  await mkdir(o.out, { recursive: true });
  await writeFile(join(o.out, "plan.json"), JSON.stringify(plan, null, 1) + "\n");
  const k = krtPaths(plan.krt?.root ?? krtRoot);
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
  type PlacedAcc = { results?: { A8_pairs?: { pairs_to_reroute?: string[][] } } };
  // a layout seed keeps its acceptance beside the board; a last-mile board keeps it under .lastmile/ (the bench's scorer)
  const accOfPlaced =
    (await readJsonOrNull<PlacedAcc>(join(o.placed, "acceptance.json"))) ?? (await readJsonOrNull<PlacedAcc>(join(o.placed, ".lastmile", "acceptance.json")));
  sel.pairsToReroute = accOfPlaced?.results?.A8_pairs?.pairs_to_reroute ?? [];
  const rip = await readJsonOrNull<{ nets?: string[]; open_before?: string[] }>(join(o.placed, "rip.json"));
  const nudge = await readJsonOrNull<{ cut_nets?: string[] }>(join(o.placed, "nudge.json"));
  sel.cutNets = [...(rip?.nets ?? []), ...(nudge?.cut_nets ?? [])];
  // after a rip, the nets open before it; otherwise the nets open on this board (the last-mile bench's score of it)
  const scored = rip ? null : await readJsonOrNull<{ opens?: Array<{ net?: string }> }>(join(o.placed, "lastmile.score.json"));
  sel.openBefore = rip?.open_before ?? [...new Set((scored?.opens ?? []).map((x) => x.net).filter((n): n is string => !!n))].sort();

  const wrapper = join(o.out, KRT_OVERRIDE_FILE);
  if (overrides.some(hasKrtOverrides)) await writeFile(wrapper, KRT_OVERRIDE_SCRIPT);
  const record: RouteKrtRecord = { stages: [], ...(avoided ? { avoided } : {}), ...(pairRec ? { pair_options: pairRec } : {}) };
  let cur = krtIn;
  const t0 = Date.now();
  for (const [i, st] of plan.stages.entries()) {
    if (host.signal?.aborted) {
      record.error = `aborted before stage ${st.name}`;
      break;
    }
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
    const ov = overrides[i]!;
    const { allowed, basis } = viaInPadPolicy(acc.manufacturing_rules.via_in_pad);
    const viaClearance = allowed ? -1 : Math.max(0.15, acc.manufacturing_rules.adopted.min_clearance);
    const stageArgs = [...args, ...(plan.common ?? [])];
    if (["route", "route_diff", "route_planes"].includes(st.tool)) {
      if (stageArgs.some(arg => arg === "--same-net-pad-clearance" || arg.startsWith("--same-net-pad-clearance=")))
        throw new FlowError("Set the via-in-pad policy in acceptance.manufacturing_rules; do not override it in router arguments");
      stageArgs.push("--same-net-pad-clearance", String(viaClearance));
    }
    const r = await host.spawn(krtStageCommand(k.python, krtRouterScript(k, st.tool), [cur, nxt, ...stageArgs], hasKrtOverrides(ov) ? { wrapper, overrides: ov } : undefined), {
      cwd: k.plugins,
      env: { ...plan.env, ...st.env },
      log,
      ...(remaining !== undefined ? { timeoutMs: remaining } : {}),
      ...(host.signal ? { signal: host.signal } : {}),
      ...(host.onPid ? { onPid: host.onPid } : {}),
    });
    const logText = await readFile(log, "utf8").catch(() => "");
    const rec = { name: st.name, tool: st.tool, viaInPadPolicy: { allowed, clearanceMm: viaClearance, basis }, exit: r.code, wall_s: r.wallS, ...(hasKrtOverrides(ov) ? { krt_overrides: ov } : {}), ...routeSummaries(logText) };
    record.stages.push(rec);
    host.log?.(JSON.stringify({ name: rec.name, exit: rec.exit, wall_s: rec.wall_s }));
    const overrideError = /^KRT_OVERRIDE_ERROR: (.*)$/m.exec(logText);
    if (overrideError) {
      record.error = `stage ${st.name}: ${overrideError[1]}`;
      break;
    }
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
  /** A power-planes plan file (power/planes.ts), relative to `planRoot`: split plane zones written before routing. */
  planes?: string;
  /** Fine-pitch power escapes (power/escape.ts) before routing; an object sets the stub reach and clearance, mm. */
  escape?: boolean | { max_stub?: number; clearance?: number };
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
  /** Where a relative `planes` file resolves (the layout folder, like the spec's plan paths); default the plan's folder. */
  planRoot?: string;
}

/**
 * The toolkit's pre-routing steps on the base copy (route_pipeline.py): split power planes from the plan's `planes` file,
 * then fine-pitch power escapes when the plan asks. Returns what each did, for the pipeline record.
 */
export async function prepareRouteBase(base: string, stem: string, acc: Acceptance, plan: Pick<TmPlan, "planes" | "escape">, planRoot: string): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {};
  const board = join(base, `${stem}.kicad_pcb`);
  if (plan.planes) {
    const file = resolve(planRoot, plan.planes);
    const p = checkPlanesPlan(JSON.parse(await readFile(file, "utf8").catch(() => { throw new FlowError(`plan.planes: cannot read ${file}`); })));
    const r = powerPlanes(await readFile(board, "utf8"), p);
    await writeFile(board, r.text);
    log["planes"] = r.record;
  }
  if (plan.escape) {
    const e = typeof plan.escape === "object" ? plan.escape : {};
    const r = powerEscape(await readFile(board, "utf8"), acc, { ...(e.max_stub !== undefined ? { maxStub: e.max_stub } : {}), ...(e.clearance !== undefined ? { clearance: e.clearance } : {}) });
    await writeFile(board, r.text);
    log["escape"] = r.stats;
  }
  return log;
}

/** TraceMaker: session stages for the plan's nets, then the CLI for everything left; scored into `<out>/score`. */
export async function routePipeline(host: LayoutHost, o: RoutePipelineOptions): Promise<Record<string, unknown>> {
  const tmBin = await requireEngine(host, "tracemaker");
  const acc = o.req.acceptance;
  const plan = (await loadPlan(o.plan)) as unknown as TmPlan;
  if (await pathExists(o.out)) throw new FlowError(`${o.out} exists`);
  const noTrack = acc.stack_policy.no_track_layers ?? [];
  const log: { placed: string; plan: string; stages: Array<Record<string, unknown>>; [k: string]: unknown } = { placed: o.placed, plan: o.plan, stages: [] };
  const base = join(o.out, "base");
  await copyDir(o.placed, base, (n) => n !== "tm" && !n.endsWith(".json"));
  if (await pathExists(join(o.placed, "manufacturing-via-process.json"))) await copyFile(join(o.placed, "manufacturing-via-process.json"), join(base, "manufacturing-via-process.json"));
  Object.assign(log, await prepareRouteBase(base, o.stem, acc, plan, o.planRoot ?? (o.plan.startsWith("builtin:") ? base : dirname(o.plan))));
  await applyNetclasses(join(base, `${o.stem}.kicad_pro`), acc);
  const tm = join(o.out, "tm");
  await mkdir(tm, { recursive: true });
  const board = join(tm, `${o.stem}.kicad_pcb`);
  await writeFile(board, convertTransforms(await readFile(join(base, `${o.stem}.kicad_pcb`), "utf8")).text);
  const proj = async (dir: string) => {
    for (const ext of ["kicad_pro", "kicad_dru"]) if (await pathExists(join(base, `${o.stem}.${ext}`))) await copyFile(join(base, `${o.stem}.${ext}`), join(dir, `${o.stem}.${ext}`));
  };
  await proj(tm);
  const spawnOpts = { ...(host.signal ? { signal: host.signal } : {}), ...(host.onPid ? { onPid: host.onPid } : {}) };
  // via-in-pad policy (acceptance.manufacturing_rules.via_in_pad): TraceMaker's own options keep vias off the pads, and
  // a plan cannot ask for via-in-pad the requirements do not allow; the routed board is checked afterwards either way
  const policy = viaInPadPolicy(acc.manufacturing_rules.via_in_pad);
  if (!policy.allowed && (plan.cli?.extra ?? []).some((a) => a === "--via-in-pad"))
    throw new FlowError("plan.cli.extra asks for --via-in-pad: set the via-in-pad policy in acceptance.manufacturing_rules (allow with a basis), not in router arguments");
  if (!policy.allowed && plan.session?.some((st) => st.options?.["via_in_pad"] === true))
    throw new FlowError("a session stage asks for via_in_pad: set the via-in-pad policy in acceptance.manufacturing_rules (allow with a basis), not in router options");
  let keepOff = false;
  if (!policy.allowed) {
    await host.spawn([tmBin, "route", "--help"], { log: join(tm, "route-help.txt"), ...spawnOpts }).catch(() => null);
    keepOff = tracemakerKeepsViasOffPads(await readFile(join(tm, "route-help.txt"), "utf8").catch(() => ""));
  }
  log["via_in_pad_policy"] = {
    ...policy,
    native: policy.allowed
      ? "allowed: TraceMaker's defaults"
      : keepOff
        ? `${TM_KEEP_VIAS_OFF_PADS.join(" ")} (CLI); vias_off_pads (session: pads under 2 mm)`
        : "this TraceMaker has no --keep-vias-off-pads: post-route check only",
  };
  const t0 = Date.now();
  let current = board;
  if (plan.session?.length) {
    host.signal?.throwIfAborted();
    const reqs: unknown[] = [{ tool: "board_info", args: {} }];
    for (const st of plan.session) {
      const args: Record<string, any> = {
        nets: tmNets(st.nets, acc),
        work: st.work ?? 30000000,
        variants: st.variants ?? 8,
        verify: "report",
        hints: { version: 1, ...st.hints },
        options: { ...(st.options ?? { soft_zones: true }), ...(keepOff ? { vias_off_pads: true } : {}) },
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
    host.signal?.throwIfAborted();
    const r = join(tm, "cli");
    await mkdir(r, { recursive: true });
    await proj(r);
    const cmd = [tmBin, "route", current, "-o", join(r, `${o.stem}.kicad_pcb`), "--soft-zones", ...(noTrack.length ? ["--no-tracks-on", noTrack.join(",")] : []), "--work", String(plan.cli.work ?? 50000000), "--threads", "8", ...(keepOff ? TM_KEEP_VIAS_OFF_PADS : []), ...(plan.cli.extra ?? [])];
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
  log["via_in_pad"] = viaInPadReport(await readFile(join(base, `${o.stem}.kicad_pcb`), "utf8"), await readFile(join(o.out, "score", `${o.stem}.kicad_pcb`), "utf8"), policy);
  await writeFile(join(o.out, "pipeline.json"), JSON.stringify(log, null, 1) + "\n");
  return log;
}

/**
 * TraceMaker's options that keep vias off SMD pads: `--keep-vias-off-pads` applies to pads narrower than
 * `--vias-off-pads-below` (default 2 mm), so a width no pad reaches keeps vias off every SMD pad, as the policy means.
 */
export const TM_KEEP_VIAS_OFF_PADS: readonly string[] = ["--keep-vias-off-pads", "--vias-off-pads-below", "1000"];

/** Whether a TraceMaker's `route --help` text offers the keep-off options (older builds do not; passing them would fail). */
export const tracemakerKeepsViasOffPads = (help: string) => help.includes("--keep-vias-off-pads") && help.includes("--vias-off-pads-below");

/** What a router said it routed, beside the saved board's native count (the workflow headlines the native one). */
export interface RouterClaim {
  router: string;
  /** Connections (TraceMaker) or nets (KRT) the router reported routed / failed, in its own model. */
  routed?: number;
  failed?: number;
  total?: number;
  text: string;
}

/** KRT's claim: the last stage that printed its compact tally (`JSON_SUMMARY_MIN`: successful / failed nets). */
export function krtClaim(rec: { stages?: Array<Record<string, unknown>> } | null): RouterClaim | null {
  for (const st of [...(rec?.stages ?? [])].reverse()) {
    const m = st["JSON_SUMMARY_MIN"] as { successful?: unknown; failed?: unknown } | undefined;
    if (!m || typeof m.successful !== "number" || typeof m.failed !== "number") continue;
    return { router: "krt", routed: m.successful, failed: m.failed, text: `KRT claimed ${m.successful} routed, ${m.failed} failed (stage ${String(st["name"])})` };
  }
  return null;
}

/** TraceMaker's claim: the CLI's `routed N/M connections` line, else the last session stage's `open_after`. */
export function tmClaim(log: { stages?: Array<Record<string, unknown>> } | null): RouterClaim | null {
  const stages = log?.stages ?? [];
  const cli = stages.find((s) => s["stage"] === "cli");
  const m = typeof cli?.["summary"] === "string" ? /routed (\d+)\/(\d+)/.exec(cli["summary"]) : null;
  if (m) {
    const [routed, total] = [Number(m[1]), Number(m[2])];
    return { router: "tracemaker", routed, total, failed: total - routed, text: `TraceMaker claimed ${routed}/${total} routed` };
  }
  const last = [...stages].reverse().find((s) => typeof s["open_after"] === "number");
  return last ? { router: "tracemaker", failed: last["open_after"] as number, text: `TraceMaker claimed ${String(last["open_after"])} open after session stage ${String(last["stage"])}` } : null;
}

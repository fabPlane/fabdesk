/**
 * Apply: an isolated copy of the project with the change made on the board AND the schematic sheets, the requirements
 * copied and edited with a ledger. The unedited project is scored first so a failure after the edit can be attributed.
 * Repair (re-routing what the edit opened) is the route stage's job; `edit.json` records what it should look at.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptanceResults, CheckKey } from "../accept";
import { BOARD_DIR, exists } from "../files";
import type { Acceptance, CircuitRequirement, HeightsRequirement, MechanicalRequirement } from "../requirements";
import { REQUIREMENT_FILES } from "../requirements";
import { pairsOf, type EditEnv } from "./env";
import { fillAddDefaults, impact, boardModel, type ImpactReport } from "./impact";
import { planMoves, cutPads, type MoveLedger } from "./move";
import { addFootprint, ensureNetDeclared, fpInfo, setFpDnp, setPadNet, setValue, swapFootprint, type SwapLog } from "./ops";
import { pruneDangling, deletePadless } from "./prune";
import type { EditPlan } from "./plan";
import { splitPin } from "./plan";
import { SheetSet, addSymbol, relabel, removePinOrphans, setSymFlags, setSymProps, stop, EditStop } from "./sch";
import { footprintSpans, refOf, removeBlocks, sideOf } from "./text";
import { readBoard } from "../board";
import { parseSexpr } from "../sexpr";
import { readProjectSettings } from "../project";
import { sha256 } from "./copper";
import { directLink, type LinkLog } from "./link";
import { applyCopper, applyHole, applyStackBoard, holeRecord, stackAcceptance, type CopperLog, type StackLog } from "./keys";
import { holeValue, type HoleRecord } from "./hole";
import { dirname } from "node:path";

/** What a scoring run returns (an `AcceptanceResult` fits). */
export interface Scored {
  summary: Record<CheckKey, boolean>;
  results: AcceptanceResults;
}
export type ScoreFn = (dir: string) => Promise<Scored>;

export interface ApplyLog {
  before?: Record<CheckKey, boolean>;
  before_cached?: string;
  accepted_before?: Record<string, string>;
  footprints?: number;
  segments_deleted?: number;
  vias_deleted?: number;
  arcs_deleted?: number;
  pruned_items?: number;
  pad_cut?: { removed: number; pruned: number; cut_nets: string[] };
  swaps: SwapLog[];
  adds: Array<{ ref: string; footprint_file: string; schematic: string; near: unknown; link?: LinkLog }>;
  net_changes: Array<{ pin: string; from: string; to: string; schematic: string; label_was: string }>;
  net_change_pruned?: number;
  net_change_padless_deleted?: number;
  net_change_padless_nets?: string[];
  landing?: MoveLedger;
  moves?: MoveLedger;
  symbols: number;
  schematic_orphans_removed?: Record<string, { wire: number; label: number; no_connect: number }>;
  /** plan.copper (copper_plan): counts and the nets it touched; the full ledger is copper-ledger.json. */
  copper?: CopperLog;
  /** plan.hole (mechanical_hole): the hole-edit.json record. */
  hole?: HoleRecord;
  /** plan.stack (stack_plan): what changed; the record is stack-plan.json. */
  stack?: StackLog;
  /** Project-relative files besides the board and the sheets that the candidate changed (a library footprint, acceptance.json): adopt carries them. */
  extra_files?: string[];
}

/** Files a scoring copy does not need: models, documents and history. */
const SKIP_EXT = /\.(step|stp|wrl|wrz|glb|gltf|pdf|zip|png|jpe?g|kicad_prl)$/i;
const SKIP_DIR = /^(\.git|\.fabdesk|fp-info-cache)$|-backups$/;

/** Copy the project into `dest` for an isolated edit: design files and libraries, not models, documents or host-app state. (`dest` may sit inside `src`, under `.fabdesk`.) */
export async function copyProject(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const name = e.name;
    if (SKIP_DIR.test(name) || SKIP_EXT.test(name) || name.startsWith("_autosave") || name.startsWith("~")) continue;
    if (e.isDirectory()) await copyProject(join(src, name), join(dest, name));
    else if (e.isFile()) await copyFile(join(src, name), join(dest, name));
    else if (e.isSymbolicLink()) await cp(join(src, name), join(dest, name), { dereference: true, recursive: true });
  }
}

const BAD_BEFORE: CheckKey[] = ["A3_parity", "A4_circuit", "A5_anchors", "A9_heights"];

const jsonIn = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const jsonOut = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 1) + "\n");

/**
 * Apply `plan` in `out` (a new folder). Returns the impact report and the ledger. Throws EditStop for a STOP/FAIL verdict.
 * `score` is called on the unedited copy (cached by the caller).
 */
export async function applyEdit(
  plan: EditPlan,
  env: EditEnv,
  out: string,
  opts: { score: ScoreFn; beforeScored?: (dir: string) => Promise<{ scored: Scored; cached?: string }> },
): Promise<{ rep: ImpactReport; log: ApplyLog; pcbText: string }> {
  fillAddDefaults(plan, env.pcbText);
  const rep = impact(plan, env);
  if (!rep.verdict.startsWith("PASS")) throw new EditStop(rep.verdict);
  if (await exists(out)) throw new EditStop(`${out} exists`);
  await mkdir(join(out, ".."), { recursive: true });
  await copyProject(env.projectDir, out);
  // the candidate is its own project: requirements and onboarding record travel with it
  const home = join(out, BOARD_DIR);
  await mkdir(home, { recursive: true });
  await cp(join(env.projectDir, BOARD_DIR, "requirements"), join(home, "requirements"), { recursive: true });
  if (await exists(join(env.projectDir, BOARD_DIR, "onboard.json"))) await cp(join(env.projectDir, BOARD_DIR, "onboard.json"), join(home, "onboard.json"));
  const gone = new Set(plan.remove ?? []);
  const log: ApplyLog = { swaps: [], adds: [], net_changes: [], symbols: 0 };
  // Fail fast on inherited mismatches: the assembled project must pass parity/circuit/anchors/heights BEFORE the edit, or
  // after-edit failures cannot be attributed.
  const b = opts.beforeScored ? await opts.beforeScored(out) : { scored: await opts.score(out) };
  const before = b.scored;
  if (b.cached) log.before_cached = b.cached;
  log.before = before.summary;
  jsonOut(join(out, "before-acceptance.json"), { summary: before.summary, results: before.results });
  let bad = BAD_BEFORE.filter((k) => !before.summary[k]);
  // a board that already fails a check can be edited when the plan names the failure with a reason; the judgement is then "no new failure"
  const accepted = Object.fromEntries(Object.entries(plan.accept_before ?? {}).filter(([k]) => bad.includes(k as CheckKey)));
  if (Object.keys(accepted).length) {
    log.accepted_before = accepted;
    bad = bad.filter((k) => !(k in accepted));
  }
  if (bad.length)
    throw new EditStop(`STOP the source project fails [${bad.map((k) => `'${k}'`).join(", ")}] before the edit (see ${join(home, "accept")}): name each in plan.accept_before with the reason, or fix the source first so an after-edit failure can be attributed`);
  const sheets = new SheetSet(out);
  const pcbPath = join(out, env.pcbName);
  let text = await readFile(pcbPath, "utf8");
  // stack (stack_plan): copper_source, named via removals and dielectrics, on the board as the plan names it
  let stackLog: ReturnType<typeof applyStackBoard>["log"] | null = null;
  if (plan.stack) {
    const r = applyStackBoard(text, plan, env);
    text = r.text;
    stackLog = r.log;
  }
  // board: footprints, copper on dead nets, dangling copper on reduced nets
  const rb = removeBlocks(text, "footprint", (blk) => gone.has(refOf(blk) ?? ""));
  text = rb.text;
  log.footprints = rb.removed;
  const dead = new Set(rep.copper.delete_on_nets);
  for (const kind of ["segment", "via", "arc"] as const) {
    const r = removeBlocks(text, kind, (blk) => dead.has(/\(net "([^"]*)"\)/.exec(blk)?.[1] ?? ""));
    text = r.text;
    log[`${kind}s_deleted` as "segments_deleted" | "vias_deleted" | "arcs_deleted"] = r.removed;
  }
  const pr = pruneDangling(text, new Set(rep.copper.prune_on_nets));
  text = pr.text;
  log.pruned_items = pr.pruned;
  const pairs0 = pairsOf(env.req);
  const isFixed = (r: string) => env.fixed.has(r);
  // copper first, on the old geometry: pads whose net changes and every pad of a swapped footprint
  const fps0 = boardModel(text, env.pcbName).board.footprints;
  const targets: Array<[string, string]> = (plan.net ?? []).map((nc) => splitPin(nc.pin));
  for (const sw of plan.swap ?? []) if (sw.footprint) for (const p of Object.keys(fps0.get(sw.ref)!.pins)) targets.push([sw.ref, p]);
  if (targets.length) {
    const r = cutPads(text, targets, pairs0);
    text = r.text;
    log.pad_cut = r.log;
  }
  for (const sw of plan.swap ?? []) {
    if (sw.dnp !== undefined) {
      // fit / do-not-fit: footprint attr and symbol flag together (parity compares them)
      text = setFpDnp(text, sw.ref, !!sw.dnp);
      setSymFlags(sheets, sw.ref, { dnp: sw.dnp ? "yes" : "no", in_bom: sw.dnp ? "no" : "yes" });
    }
    if (sw.value !== undefined || (sw.fields && Object.keys(sw.fields).length)) text = setValue(text, sw.ref, sw.value, sw.fields);
    if (sw.footprint) {
      const r = swapFootprint(text, out, sw.ref, sw.footprint, sw.side);
      text = r.text;
      setSymFlags(sheets, sw.ref, r.log.sym_flags); // parity compares in_bom/dnp with the footprint attrs
      log.swaps.push(r.log);
    }
    const props: Record<string, string> = {};
    if (sw.value !== undefined) props["Value"] = sw.value;
    if (sw.footprint !== undefined) props["Footprint"] = sw.footprint;
    Object.assign(props, sw.fields ?? {});
    if (Object.keys(props).length) setSymProps(sheets, sw.ref, props);
  }
  for (const nc of plan.net ?? []) {
    const [r, pd] = splitPin(nc.pin);
    text = ensureNetDeclared(text, nc.to);
    const sp = setPadNet(text, r, pd, nc.to);
    text = sp.text;
    const rl = relabel(sheets, r, pd, nc.to);
    log.net_changes.push({ pin: nc.pin, from: sp.was, to: nc.to, schematic: rl.sheet, label_was: rl.was });
  }
  if (plan.net?.length) {
    // the old net's stub to the pad dangles only once the pad has its new net
    const froms = new Set(log.net_changes.map((c) => c.from));
    const p2 = pruneDangling(text, froms);
    text = p2.text;
    log.net_change_pruned = p2.pruned;
    const dp = deletePadless(text, froms);
    text = dp.text;
    log.net_change_padless_deleted = dp.deleted;
    log.net_change_padless_nets = dp.nets;
  }
  type Landing = import("./move").MoveSpec;
  const landing: Landing[] = (plan.swap ?? []).filter((sw) => sw.footprint).map((sw) => ({ ref: sw.ref, to: [fps0.get(sw.ref)!.x, fps0.get(sw.ref)!.y, fps0.get(sw.ref)!.rot] as [number, number, number] }));
  for (const ad of plan.add ?? []) {
    const fpsNow = boardModel(text, env.pcbName).board;
    const likeFp = fpsNow.footprints.has(ad.like) ? fpInfo(text, ad.like) : null;
    const tgt = ad.near ?? ad.like;
    let tx: number, ty: number;
    if (typeof tgt === "string" && !fpsNow.footprints.has(tgt) && tgt.includes(".")) {
      const dot = tgt.indexOf(".");
      const hit = fpsNow.pads.find((p) => p.ref === tgt.slice(0, dot) && p.pad === tgt.slice(dot + 1));
      if (!hit) return stop(`STOP add ${ad.ref}: near ${tgt}: no such pad`);
      [tx, ty] = [hit.x, hit.y];
    } else if (typeof tgt === "string") {
      const f = fpsNow.footprints.get(tgt);
      if (!f) return stop(`STOP add ${ad.ref}: near ${tgt}: not on the board`);
      [tx, ty] = [f.x, f.y];
    } else [tx, ty] = tgt;
    const side = ad.side ?? likeFp?.side ?? "F";
    const keep = likeFp ? likeFp.keep.filter((k) => !k.startsWith("(path")) : [];
    for (const n of new Set(Object.values(ad.pins))) text = ensureNetDeclared(text, n);
    const inherit = Object.fromEntries(Object.entries(likeFp?.props ?? {}).filter(([k]) => !["Reference", "Value", "Footprint"].includes(k))); // parity compares every field with the symbol
    const af = addFootprint(text, out, ad.ref, ad.footprint!, ad.value ?? "", { ...inherit, ...(ad.fields ?? {}) }, ad.pins, [tx, ty, ad.rot ?? 0], side, keep);
    text = af.text;
    const schName = addSymbol(sheets, ad.like, ad.ref, ad.value ?? "", ad.footprint!, ad.fields ?? {}, ad.pins, ad.symbol);
    // board footprint path = template's sheet path + the new symbol's uuid
    const sym = sheets.symbol(ad.ref)!;
    const symUuid = /\(uuid "([^"]+)"\)/.exec(sheets.texts.get(sym.name)!.slice(sym.span.start, sym.span.end))![1]!;
    const lp = likeFp?.keep.find((k) => k.startsWith("(path"));
    if (lp) {
      const sheet = /^\(path "(.*)\/[^/"]+"\)/.exec(lp)![1]!;
      const sp = footprintSpans(text).get(ad.ref)!;
      const b3 = text.slice(sp.start, sp.end).replace(`(layer "${side}.Cu")`, () => `(layer "${side}.Cu")\n    (path "${sheet}/${symUuid}")`);
      text = text.slice(0, sp.start) + b3 + text.slice(sp.end);
    }
    landing.push({ ref: ad.ref, near: [tx, ty], radius: ad.radius ?? 10, rotations: ad.rotations ?? "any", basis: `added part near ${Array.isArray(tgt) ? `[${tgt.join(", ")}]` : tgt}` });
    log.adds.push({ ref: ad.ref, footprint_file: af.src, schematic: schName, near: tgt });
  }
  if (landing.length) {
    const r = planMoves(text, isFixed, landing, plan.displace ?? { radius: 6 }, pairs0);
    text = r.text;
    log.landing = r.led;
  }
  // an added part placed next to a pad gets a direct track to it when it shares that pad's net (a decoupling
  // capacitor's connection), not only the pour; `link: false` in the add leaves it to the pour / the last mile
  const linkAdds = (plan.add ?? []).filter((ad) => typeof ad.near === "string" && ad.near.includes(".") && ad.link !== false);
  if (linkAdds.length) {
    const ps = readProjectSettings(await readFile(join(env.projectDir, `${env.stem}.kicad_pro`), "utf8").catch(() => "{}"));
    const clearance = Math.max(ps.classes.find((c) => c.name === "Default")?.clearance ?? 0, ps.minClearance ?? 0) || 0.2;
    for (const ad of linkAdds) {
      let lk = directLink(text, ad.ref, ad.near as string, clearance);
      // blocked where the landing put it: try poses round the target pad, nearest first, each through the same
      // courtyard-gated placement (boards up to 30 MB: each try re-reads it)
      if ("skipped" in lk.log && text.length < 30e6) {
        const near = ad.near as string;
        const tb = readBoard(parseSexpr(text)).pads.find((p) => `${p.ref}.${p.pad}` === near);
        const tries: Array<[number, number, number]> = [];
        if (tb)
          for (const r of [1.2, 1.6, 2.0, 2.5, 3.0])
            for (let k = 0; k < 8; k++) for (const rot of ad.rot !== undefined ? [ad.rot] : [0, 90, 180, 270]) tries.push([tb.x + r * Math.cos((k * Math.PI) / 4), tb.y + r * Math.sin((k * Math.PI) / 4), rot]);
        // poses that link, nearest first; one that cuts no other net's copper wins at once, else the one cutting
        // fewest. Nets a pose cuts become planned (the ledger's landing cut nets): the repair routes them again.
        const own = new Set(Object.values(ad.pins));
        let best: { text: string; log: LinkLog; cut: string[]; extra: number } | null = null;
        const nearerBlocked = new Set<string>(); // parts in the way of poses tried before the chosen one (nearer first)
        for (const to of tries) {
          let pm: ReturnType<typeof planMoves>;
          try {
            pm = planMoves(text, isFixed, [{ ref: ad.ref, to }], null, pairs0);
          } catch (e) {
            if (!(e instanceof EditStop)) throw e;
            if (!best) for (const m of e.message.matchAll(/(?:^|[:;,] )([A-Z]{1,4}\d+[A-Z]?) \(/g)) if (m[1] !== ad.ref) nearerBlocked.add(m[1]!);
            continue;
          }
          const cut = pm.led.cut_nets.filter((n) => !own.has(n));
          if (best && cut.length >= best.extra) continue;
          const l2 = directLink(pm.text, ad.ref, near, clearance);
          if ("skipped" in l2.log) continue;
          best = { text: l2.text, log: { ...l2.log, placed: to.map((v) => Math.round(v * 1e4) / 1e4) as [number, number, number], ...(nearerBlocked.size ? { nearer_blocked_by: [...nearerBlocked].sort().slice(0, 8) } : {}) }, cut: pm.led.cut_nets, extra: cut.length };
          if (!cut.length) break;
        }
        if (best) {
          lk = { text: best.text, log: best.log };
          if (log.landing) log.landing.cut_nets = [...new Set([...log.landing.cut_nets, ...best.cut])].sort();
        }
      }
      text = lk.text;
      const entry = log.adds.find((x) => x.ref === ad.ref);
      if (entry) entry.link = lk.log;
    }
  }
  if (plan.move?.length) {
    const r = planMoves(text, isFixed, plan.move, plan.displace, pairs0);
    text = r.text;
    log.moves = r.led;
  }
  // hole (mechanical_hole) and copper (copper_plan) after the moves, on the board as edited
  const extra: string[] = [];
  let hole: ReturnType<typeof applyHole> | null = null;
  if (plan.hole) {
    hole = applyHole(text, plan, env);
    text = hole.text;
    await mkdir(dirname(join(out, hole.libRel)), { recursive: true });
    await writeFile(join(out, hole.libRel), hole.libText);
    extra.push(hole.libRel);
  }
  let copperLedger: unknown = null;
  if (plan.copper) {
    const r = applyCopper(text, plan, env);
    text = r.text;
    log.copper = r.log;
    copperLedger = r.ledger;
  }
  await writeFile(pcbPath, text);
  if (hole) {
    log.hole = holeRecord(plan, env.pcbText, text, hole.centre, hole.libRel);
    jsonOut(join(out, "hole-edit.json"), log.hole);
  }
  if (copperLedger) jsonOut(join(out, "copper-ledger.json"), { ...(copperLedger as object), source_sha256: sha256(env.pcbText), output_sha256: sha256(text) });
  // schematic symbols
  for (const name of sheets.names) {
    const t = sheets.texts.get(name)!;
    const rs = removeBlocks(t, "symbol", (blk) => blk.slice(0, 200).includes("(lib_id") && gone.has(refOf(blk) ?? ""));
    if (rs.removed) {
      const orph = removePinOrphans(t, rs.text, gone);
      sheets.set(name, orph.text);
      log.symbols += rs.removed;
      (log.schematic_orphans_removed ??= {})[name] = orph.counts;
    }
  }
  sheets.flush();
  // requirements: proposed copy with the change and its ledger
  const rq = join(home, "requirements");
  const c = jsonIn<CircuitRequirement & { components: Array<Record<string, unknown>> }>(join(rq, REQUIREMENT_FILES.circuit));
  c.components = c.components.filter((x) => !gone.has(x["reference"] as string));
  const comp = new Map<string, Record<string, unknown>>(c.components.map((x) => [x["reference"] as string, x as Record<string, unknown>]));
  for (const sw of plan.swap ?? []) {
    if (sw.value !== undefined) comp.get(sw.ref)!["value"] = sw.value;
    if (sw.footprint) comp.get(sw.ref)!["footprint"] = sw.footprint;
  }
  // the hole's new Value (fabdesk's circuit.json lists board-only parts too; the toolkit's does not)
  if (plan.hole && comp.has(plan.hole.ref)) comp.get(plan.hole.ref)!["value"] = holeValue(plan.hole.ref, plan.hole.size_mm);
  for (const nc of plan.net ?? []) {
    const [r, pd] = splitPin(nc.pin);
    const x = comp.get(r)!;
    (x["pins"] as Record<string, string>)[pd] = nc.to;
  }
  for (const ad of plan.add ?? [])
    c.components.push({ reference: ad.ref, value: ad.value ?? "", footprint: ad.footprint, baseline: `edit ${plan.id}`, source_reference: null, original_footprint: null, pins: ad.pins, approved_geometry_exception: null, basis: ad.basis ?? plan.reason });
  jsonOut(join(rq, REQUIREMENT_FILES.circuit), c);
  const finalBoard = readBoard(parseSexpr(text));
  const m = jsonIn<MechanicalRequirement>(join(rq, REQUIREMENT_FILES.mechanical));
  m.anchors = m.anchors.filter((a) => !gone.has(a.reference));
  for (const mv of (plan.move ?? []).filter((x) => x.to)) {
    const to = mv.to!;
    const ent = { reference: mv.ref, at: [String(Number(to[0].toFixed(6))), String(Number(to[1].toFixed(6)))] as [string, string], rotation: [String(Number((((to[2] % 360) + 360) % 360).toFixed(6)))] as [string], layer: finalBoard.footprints.get(mv.ref)?.layer ?? "F.Cu", basis: mv.basis ?? plan.authority ?? null };
    const had = m.anchors.some((a) => a.reference === mv.ref);
    if (had || mv.anchor) m.anchors = [...m.anchors.filter((a) => a.reference !== mv.ref), ent];
  }
  jsonOut(join(rq, REQUIREMENT_FILES.mechanical), m);
  const acc = jsonIn<Acceptance>(join(rq, REQUIREMENT_FILES.acceptance));
  const hp = join(rq, REQUIREMENT_FILES.heights);
  if (existsSync(hp)) {
    const h = jsonIn<HeightsRequirement & { entries: Array<Record<string, unknown>> }>(hp);
    h.entries = h.entries.filter((e) => !gone.has(e["ref"] as string));
    const spans = footprintSpans(text);
    const partSide = (ref: string) => {
      const sp = spans.get(ref);
      return sp ? sideOf(text.slice(sp.start, sp.end)) : "B";
    };
    for (const x of [...(plan.swap ?? []), ...(plan.add ?? [])])
      if (x.height_mm !== undefined) {
        h.entries = [...h.entries.filter((e) => e["ref"] !== x.ref), { ref: x.ref, side: ("side" in x && x.side) || partSide(x.ref), height_above_surface_mm: x.height_mm, basis: x.height_basis ?? `edit ${plan.id}` }];
      }
    jsonOut(hp, h);
  }
  for (const cl of Object.values(acc.net_classes.classes)) {
    if (cl.pairs) cl.pairs = cl.pairs.filter((p) => !p.some((n) => dead.has(n)));
    if (cl.nets) cl.nets = cl.nets.filter((n) => !dead.has(n));
  }
  for (const [net, d] of Object.entries(acc.net_classes.tap_pads ?? {})) {
    if (d && typeof d === "object" && !net.startsWith("_")) for (const k of Object.keys(d)) if (gone.has(k.split(".")[0]!)) delete d[k];
  }
  const newAnchors = (plan.move ?? []).filter((mv) => mv.anchor).map((mv) => mv.ref);
  if (newAnchors.length) {
    const fx = ((acc as Record<string, unknown>)["fixed"] ??= {}) as Record<string, string>;
    fx["anchors"] = (fx["anchors"] ?? "") + ` Edit ${plan.id}: ${newAnchors.join(", ")} are anchors at their edited poses.`;
  }
  const mvLog = log.moves;
  for (const nc of plan.net ?? []) {
    // a pad joining a power class can be a tap (acceptance tap_rule), with its width basis
    if (nc.tap_width) {
      const tp = (acc.net_classes.tap_pads ??= {});
      const cur = (tp[nc.to] ??= {}) as Record<string, { width: number; basis: string }>;
      cur[nc.pin] = { width: nc.tap_width, basis: nc.tap_basis ?? plan.reason ?? "" };
    }
  }
  if (plan.stack) {
    const r = stackAcceptance(acc as unknown as Record<string, unknown>, plan.stack);
    log.stack = { classes_updated: r.updated, classes_split: r.split, removed_paths: r.removed_paths, ...stackLog! };
    extra.push(join(BOARD_DIR, "requirements", REQUIREMENT_FILES.acceptance));
  }
  const edits = ((acc as Record<string, unknown>)["edits"] ??= []) as unknown[];
  edits.push({
    id: plan.id, authority: plan.authority ?? null, reason: plan.reason ?? null,
    moved: mvLog?.moved ?? [], carried: mvLog?.carried ?? [], near: mvLog?.near ?? [], displaced: mvLog?.displaced ?? [], anchors_added: newAnchors,
    swapped: [...log.swaps, ...(plan.swap ?? []).filter((s) => !s.footprint).map((s) => ({ ref: s.ref, value: s.value ?? null, fields: s.fields ?? null }))],
    added: log.adds, net_changes: log.net_changes, removed: [...gone].sort(), nets_deleted: [...dead].sort(),
    accepted_unconnected: plan.accept_unconnected ?? [], notes: plan.notes ?? {},
    ...(log.copper ? { copper: log.copper } : {}), ...(log.hole ? { hole: log.hole } : {}), ...(log.stack ? { stack: log.stack } : {}),
  });
  jsonOut(join(rq, REQUIREMENT_FILES.acceptance), acc);
  if (log.stack)
    jsonOut(join(out, "stack-plan.json"), {
      plan: plan.id, source: env.projectDir, out, source_pcb_sha256: sha256(env.pcbText), pcb_sha256: sha256(text),
      copper_source: log.stack.copper_source, changed_copper: log.stack.changed_copper, removed_vias: log.stack.removed_vias,
    });
  if (extra.length) log.extra_files = extra;
  jsonOut(join(out, "edit.json"), { plan, impact: rep, applied: log });
  return { rep, log, pcbText: text };
}


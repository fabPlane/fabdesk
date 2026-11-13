/**
 * Impact: what an ECO touches, before anything is written. Removed parts, every net they touch, pins left alone,
 * parts that would serve nothing, copper to delete or prune, requirement and contract entries naming them, schematic
 * symbols, the moves' computed poses, and a verdict. A STOP verdict is a decision for the owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyNetRefs, parseBoard, type Board, type Pad } from "../board";
import { pairsOf, type EditEnv } from "./env";
import { fpInfo, libFootprint, swapFootprint } from "./ops";
import type { AddSpec, EditPlan } from "./plan";
import { splitPin } from "./plan";
import { EditStop, SheetSet, projectLibSymbol } from "./sch";
import { planMoves, type MoveLedger } from "./move";
import { footprintSpans } from "./text";
import { round } from "./fmt";

export const RAIL = /GND|VBUS|V\d|\dV\d|3V3|5V|1V8|1V1|2V5|VCC|VDD|SYS$|PWR|^unconnected-/i;

export interface NetImpact {
  pads_before: number;
  pads_after: number;
  status: string;
  copper_mm: number;
  vias: number;
}

export interface ImpactReport {
  id: string;
  board: string;
  missing_refs: string[];
  parts: Record<string, { value: string | null; side: string; at: [number, number, number]; anchor: boolean; fixed: boolean; pads: number }>;
  nets: Record<string, NetImpact>;
  unconnected_pins: string[];
  cascade_candidates: string[];
  copper: { delete_on_nets: string[]; delete_mm: number; delete_vias: number; prune_on_nets: string[] };
  requirements: Record<string, unknown>;
  contracts: Array<Record<string, unknown>>;
  schematic: string[];
  review: string[];
  identity: string[];
  swaps?: Array<Record<string, unknown>>;
  adds?: Array<Record<string, unknown>>;
  net_changes?: Array<{ pin: string; from: string; to: string; old_net_pads_left: number }>;
  moves?: MoveLedger;
  verdict: string;
}

export interface BoardModel {
  text: string;
  board: Board;
  byNet: Map<string, Pad[]>;
}

/** A board's model for edits; refuses the pre-10 file format (tracks name nets by number). */
export function boardModel(text: string, name = "board"): BoardModel {
  if (legacyNetRefs(text))
    throw new EditStop(`STOP ${name} is in the pre-10 file format (tracks name nets by number), which the edit tools cannot follow: upgrade it first (board_check upgrade: true upgrades a checked copy and writes it over the board, keeping the previous one)`);
  const board = parseBoard(text);
  const byNet = new Map<string, Pad[]>();
  for (const p of board.pads) if (p.net) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  return { text, board, byNet };
}

const length = (s: { a: [number, number]; b: [number, number] }) => Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]);

/** `add` copies its template part: footprint and value default to the `like` part's own. */
export function fillAddDefaults(plan: EditPlan, text: string): void {
  const spans = footprintSpans(text);
  for (const ad of (plan.add ?? []) as AddSpec[]) {
    if (ad.footprint && ad.value !== undefined) continue;
    const sp = ad.like ? spans.get(ad.like) : undefined;
    const m = sp ? /\(footprint "([^"]+)"/.exec(text.slice(sp.start, sp.end)) : null;
    if (!ad.footprint) {
      if (!m) throw new EditStop(`STOP add ${ad.ref}: give a footprint, or a \`like\` part that is on the board`);
      ad.footprint = m[1]!;
    }
    if (ad.value === undefined) ad.value = m ? (fpInfo(text, ad.like).props["Value"] ?? "") : "";
  }
}

/** Manufacturer identity strings of a part: LCSC codes in its board value, MPN/LCSC fields on its schematic symbol. */
function identityOf(sheets: SheetSet, ref: string, value: string | null): string[] {
  const ids = new Set<string>(value?.match(/\bC\d{4,}\b/g) ?? []);
  for (const [, t] of sheets.texts) {
    const i = t.indexOf(`(property "Reference" "${ref}"`);
    if (i >= 0) {
      const blk = t.slice(t.lastIndexOf("(symbol", i), i + 4000);
      for (const m of blk.matchAll(/\(property "(?:MPN|LCSC|Manufacturer_Part_Number)" "([^"]+)"/g)) if (m[1]) ids.add(m[1]);
    }
  }
  return [...ids];
}

const refPat = (r: string) => new RegExp("\\b" + r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");

export function impact(plan: EditPlan, env: EditEnv): ImpactReport {
  const { board, byNet } = boardModel(env.pcbText, env.pcbName);
  const text = env.pcbText;
  const fps = board.footprints;
  const gone = new Set(plan.remove ?? []);
  const missing = [...gone].filter((r) => !fps.has(r)).sort();
  const acc = env.req.acceptance;
  const anchors = new Set(env.req.mechanical.anchors.map((a) => a.reference));
  const isFixed = (r: string) => env.fixed.has(r);
  const sheets = new SheetSet(env.projectDir);
  const rep: ImpactReport = {
    id: plan.id, board: join(env.projectDir, env.pcbName), missing_refs: missing, parts: {}, nets: {}, unconnected_pins: [], cascade_candidates: [],
    copper: { delete_on_nets: [], delete_mm: 0, delete_vias: 0, prune_on_nets: [] }, requirements: {}, contracts: [], schematic: [], review: [], identity: [], verdict: "",
  };
  const goneHere = [...gone].filter((r) => fps.has(r)).sort();
  for (const r of goneHere) {
    const f = fps.get(r)!;
    rep.parts[r] = { value: f.value, side: f.layer[0]!, at: [f.x, f.y, f.rot], anchor: anchors.has(r), fixed: isFixed(r), pads: Object.keys(f.pins).length };
  }
  const nets = [...new Set(goneHere.flatMap((r) => Object.values(fps.get(r)!.pins).filter(Boolean)))].sort();
  const segByNet = new Map<string, number>();
  for (const s of board.segments) segByNet.set(s.net, (segByNet.get(s.net) ?? 0) + length(s));
  const viaByNet = new Map<string, number>();
  for (const v of board.vias) viaByNet.set(v.net, (viaByNet.get(v.net) ?? 0) + 1);
  const dead: string[] = [];
  const single: string[] = [];
  for (const n of nets) {
    const left = (byNet.get(n) ?? []).filter((p) => !gone.has(p.ref));
    const status = !left.length ? "deleted" : left.length === 1 ? "single" : "reduced";
    rep.nets[n] = { pads_before: (byNet.get(n) ?? []).length, pads_after: left.length, status, copper_mm: round(segByNet.get(n) ?? 0, 1), vias: viaByNet.get(n) ?? 0 };
    if (status === "deleted") dead.push(n);
    else if (status === "single") {
      single.push(n);
      rep.unconnected_pins.push(`${left[0]!.ref}.${left[0]!.pad} (${n})`);
    }
  }
  rep.copper = {
    delete_on_nets: [...dead, ...single],
    delete_mm: round([...dead, ...single].reduce((a, n) => a + rep.nets[n]!.copper_mm, 0), 1),
    delete_vias: [...dead, ...single].reduce((a, n) => a + rep.nets[n]!.vias, 0),
    prune_on_nets: nets.filter((n) => rep.nets[n]!.status === "reduced"),
  };
  // cascade: parts whose every non-rail net becomes single/deleted (they would serve nothing)
  const deadOrSingle = new Set([...dead, ...single]);
  for (const [r, f] of fps) {
    if (gone.has(r)) continue;
    const sig = new Set(Object.values(f.pins).filter((n) => n && !RAIL.test(n)));
    if (sig.size && [...sig].every((n) => deadOrSingle.has(n)) && !/^(U|IC)\d/.test(r)) rep.cascade_candidates.push(`${r} (${f.value}): all its signal nets lose their other end`);
  }
  // requirements naming the parts or nets
  const names = new Set([...gone, ...nets.filter((n) => !(rep.nets[n]!.status === "reduced" && RAIL.test(n)))]);
  const rqDir = join(env.projectDir, ".fabdesk", "board", "requirements");
  for (const f of readdirSync(rqDir).filter((n) => n.endsWith(".json")).sort()) {
    const t = readFileSync(join(rqDir, f), "utf8");
    const hits = [...names].filter((n) => t.includes(`"${n}"`)).sort();
    if (hits.length) rep.requirements[f] = hits;
  }
  const pairsHit = pairsOf(env.req).filter((p) => p.some((n) => deadOrSingle.has(n)));
  if (pairsHit.length) rep.requirements["acceptance.json pairs to drop"] = pairsHit;
  // interconnect contracts: entries naming a removed part's identity
  const ident = new Set<string>();
  for (const r of goneHere) for (const i of identityOf(sheets, r, fps.get(r)!.value)) ident.add(i);
  if (env.contracts.length && ident.size)
    for (const ent of env.contracts) {
      const blob = JSON.stringify(ent);
      const why = [...ident].filter((m) => blob.includes(m)).sort();
      if (why.length) rep.contracts.push({ id: ent["id"], boards: ent["boards"], matched: why });
    }
  rep.identity = [...ident].sort();
  // schematic symbols
  for (const [name, t] of [...sheets.texts].sort(([a], [b]) => (a < b ? -1 : 1))) for (const r of gone) if (t.includes(`(property "Reference" "${r}"`) || t.includes(`(reference "${r}")`)) rep.schematic.push(`${name}: ${r}`);
  // review list (decisions the agent/owner must make, each with what to look at)
  for (const [r, p] of Object.entries(rep.parts)) if (p.anchor) rep.review.push(`${r} is a mechanical anchor: removing it frees the anchor; mechanical.json loses it`);
  if (rep.unconnected_pins.length) rep.review.push("pins left on single-pad nets (accept in plan.accept_unconnected after checking the datasheet): " + rep.unconnected_pins.join(", "));
  if (rep.cascade_candidates.length) rep.review.push("parts that would serve nothing; add to remove or keep with a reason");
  for (const [n, v] of Object.entries(rep.nets)) if (v.status === "reduced" && RAIL.test(n)) rep.review.push(`${n} keeps ${v.pads_after} pads: its design current/width may now be lower (rules)`);
  if (rep.contracts.length) rep.review.push("interconnect contract entries name this connector: update the contracts (release check) or record why not");
  // swap / add / net
  const boardNets = new Set(board.pads.map((p) => p.net));
  for (const sw of plan.swap ?? []) {
    const r = sw.ref;
    const f = fps.get(r);
    if (!f) {
      rep.review.push(`FAIL swap ${r}: not on the board`);
      continue;
    }
    const ent: Record<string, unknown> = { ref: r, value: [f.value, sw.value ?? f.value], fields: sw.fields ?? {} };
    if (sw.footprint) {
      let lib: { text: string; src: string } | null = null;
      try {
        lib = libFootprint(env.projectDir, sw.footprint);
      } catch (e) {
        if (!(e instanceof EditStop)) throw e;
        rep.review.push(e.message);
        continue;
      }
      const newPads = new Set([...lib.text.matchAll(/\(pad "([^"]*)"/g)].map((m) => m[1]!));
      const lost = Object.entries(f.pins).filter(([p, n]) => n && !newPads.has(p) && !n.startsWith("unconnected-")).map(([p]) => p).sort();
      ent["footprint"] = [f.lib, sw.footprint];
      ent["library_file"] = lib.src;
      ent["pads_lost"] = lost;
      if (lost.length) rep.review.push(`FAIL swap ${r}: new footprint has no pad for [${lost.map((p) => `'${p}'`).join(", ")}] (nets would be lost)`);
      for (const n of [...new Set(Object.values(f.pins).filter(Boolean))].sort())
        rep.nets[n] = { status: "reconnect (swap)", pads_before: (byNet.get(n) ?? []).length, pads_after: (byNet.get(n) ?? []).length, copper_mm: 0, vias: 0 };
      if (sw.height_mm === undefined) rep.review.push(`swap ${r}: give height_mm (datasheet/3D model) for the height screen, or it is reported unscreened`);
    }
    (rep.swaps ??= []).push(ent);
  }
  for (const ad of plan.add ?? []) {
    const r = ad.ref;
    if (fps.has(r)) rep.review.push(`FAIL add ${r}: reference already on the board`);
    const sym = sheets.symbol(ad.like);
    if (!sym) {
      let hint = "";
      const near = typeof ad.near === "string" ? ad.near.split(".")[0]! : "";
      const nsym = near ? sheets.symbol(near) : null;
      const inst = sheets.names.filter((n) => sheets.texts.get(n)!.includes(`(reference "${ad.like}")`));
      if (nsym) {
        const kind = /^[A-Za-z]+/.exec(r)?.[0] ?? "";
        const cands = [...sheets.texts.get(nsym.name)!.matchAll(new RegExp(`\\(property "Reference" "(${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+)"`, "g"))].map((m) => m[1]!).slice(0, 5);
        hint = ` (${inst.length ? `it is placed through a sheet used several times: ${inst[0]}; ` : ""}a template from ${near}'s sheet ${nsym.name}: ${cands.join(", ") || "none of that kind"})`;
      }
      rep.review.push(`FAIL add ${r}: template symbol ${ad.like} not found as a single schematic symbol${hint}`);
    }
    try {
      if (ad.symbol) projectLibSymbol(env.projectDir, ad.symbol);
      const fp = libFootprint(env.projectDir, ad.footprint!, text);
      if (fp.src.includes("not installed")) rep.review.push(`add ${r}: footprint from ${fp.src}`);
    } catch (e) {
      if (!(e instanceof EditStop)) throw e;
      rep.review.push(e.message);
    }
    const newNets = [...new Set(Object.values(ad.pins))].filter((n) => !boardNets.has(n)).sort();
    if (newNets.length) rep.review.push(`add ${r}: new nets [${newNets.map((n) => `'${n}'`).join(", ")}] (classes/rules apply by name patterns only)`);
    if (ad.height_mm === undefined) rep.review.push(`add ${r}: give height_mm (datasheet/3D model) for the height screen`);
    (rep.adds ??= []).push({ ref: r, like: ad.like, footprint: ad.footprint, pins: ad.pins, near: ad.near ?? null });
  }
  for (const nc of plan.net ?? []) {
    const [r, pd] = splitPin(nc.pin);
    const f = fps.get(r);
    if (!f || !(pd in f.pins)) {
      rep.review.push(`FAIL net ${nc.pin}: no such pad`);
      continue;
    }
    const oldN = f.pins[pd]!;
    const left = (byNet.get(oldN) ?? []).filter((q) => !(q.ref === r && q.pad === pd));
    if (left.length === 1) rep.unconnected_pins.push(`${left[0]!.ref}.${left[0]!.pad} (${oldN})`);
    if (!boardNets.has(nc.to)) rep.review.push(`net ${nc.pin}: ${nc.to} is a new net`);
    (rep.net_changes ??= []).push({ pin: nc.pin, from: oldN, to: nc.to, old_net_pads_left: left.length });
  }
  // moves / relocations: poses are the plan's; everything else is computed
  let moveStop: string | null = null;
  if (plan.move?.length) {
    const pairs = pairsOf(env.req);
    try {
      let mtext = text;
      for (const sw of plan.swap ?? []) if (sw.side && sw.footprint) mtext = swapFootprint(mtext, env.projectDir, sw.ref, sw.footprint, sw.side).text;
      const { led } = planMoves(mtext, (r) => env.fixed.has(r), plan.move, plan.displace, pairs);
      rep.moves = led;
      for (const m of led.moved) if (m.fixed && !m.anchor) rep.review.push(`${m.ref} is a fixed part: say anchor true (its new pose becomes the anchor) or why not`);
      rep.review.push(...led.review);
      if (led.displaced.length) {
        rep.review.push("displaced parts re-seated nearby: " + led.displaced.map((d) => `${d.ref} ${d.shift_mm} mm`).join(", "));
        const disp = new Set(led.displaced.map((d) => d.ref));
        const ind = [...disp].filter((r) => /(^|_)L\d+$/.test(r)).sort();
        if (ind.length) rep.review.push(`switching/templated parts displaced (layout quality: check loops, or move the whole block, or re-place): inductors [${ind.map((r) => `'${r}'`).join(", ")}], template members []`);
      }
      const movedIds = new Set<string>();
      for (const m of led.moved) for (const i of identityOf(sheets, m.ref, fps.get(m.ref)!.value)) movedIds.add(i);
      for (const ent of env.contracts) {
        const blob = JSON.stringify(ent);
        const refsNamed = led.moved.map((m) => m.ref).filter((r) => refPat(r).test(blob));
        if (refsNamed.length) {
          rep.contracts.push({ id: ent["id"], boards: ent["boards"], matched: refsNamed, why: "moved connector" });
          rep.review.push(`${ent["id"]}: moved connector [${refsNamed.map((r) => `'${r}'`).join(", ")}]: check the cable path to the mating board (board_review action=cable)`);
        }
      }
    } catch (e) {
      if (!(e instanceof EditStop)) throw e;
      moveStop = e.message;
    }
  }
  const accepted = new Set(plan.accept_unconnected ?? []);
  const unacked = rep.unconnected_pins.filter((u) => !accepted.has(u.split(" ")[0]!));
  const fails = rep.review.filter((x) => x.startsWith("FAIL"));
  if (fails.length) rep.verdict = fails[0]!;
  else if (moveStop) rep.verdict = /^(STOP|FAIL)/.test(moveStop) ? moveStop : "FAIL " + moveStop;
  else rep.verdict = missing.length ? "FAIL refs not on board: " + missing.join(", ") : unacked.length ? "STOP review: unconnected pins not accepted in the plan: " + unacked.join(", ") : "PASS impact";
  return rep;
}

/** The report as the lines `edit.py impact` prints. */
export function impactLines(rep: ImpactReport): string[] {
  const out: string[] = [];
  for (const [r, p] of Object.entries(rep.parts)) out.push(`part  ${r} '${p.value}' side ${p.side} anchor ${py(p.anchor)} fixed ${py(p.fixed)} pads ${p.pads}`);
  for (const [n, v] of Object.entries(rep.nets)) out.push(`net   ${v.status.padEnd(8)} ${n.padEnd(30)} pads ${v.pads_before}->${v.pads_after}  copper ${pyNum0(v.copper_mm)} mm, ${v.vias} vias`);
  out.push(`copper delete ${pyNum0(rep.copper.delete_mm)} mm + ${rep.copper.delete_vias} vias; prune on ${pyList(rep.copper.prune_on_nets)}`);
  for (const [k, v] of Object.entries(rep.requirements)) out.push(`req   ${k}: ${pyAny(v)}`);
  for (const c of rep.contracts) out.push(`contract ${pyAny(c)}`);
  for (const s of rep.schematic) out.push(`sch   ${s}`);
  for (const c of rep.cascade_candidates) out.push(`cascade ${c}`);
  const mv = rep.moves;
  if (mv) {
    for (const m of mv.moved) out.push(`move  ${m.ref} ${pyAny(m.from)} -> ${pyAny(m.to)}  fixed ${py(m.fixed)} anchor ${py(m.anchor)}`);
    for (const m of mv.carried) out.push(`carry ${m.ref} with ${m.with} -> ${pyAny(m.to)}`);
    for (const m of mv.near) out.push(`near  ${m.ref} ${pyAny(m.from)} -> ${pyAny(m.to)} (${pyNum(m.shift_mm)} mm): ${m.why.join("; ")}`);
    for (const m of mv.displaced) out.push(`displace ${m.ref} ${pyAny(m.from)} -> ${pyAny(m.to)} (${pyNum(m.shift_mm)} mm): ${m.why.join("; ")}`);
    out.push(`copper: fan-out/landing cut ${mv.copper_removed} items + ${mv.pruned} pruned, ${mv.copper_moved} carried; nets to route again ${mv.cut_nets.length}: ${pyList(mv.cut_nets)}`);
    if (mv.landing_removed_nets.length) out.push(`landing: other nets cut under the new footprints: ${pyList(mv.landing_removed_nets)}`);
    for (const [r, b] of Object.entries(mv.new_courtyards)) out.push(`court ${r} ${pyAny(b)}`);
  }
  for (const r of rep.review) out.push(`REVIEW ${r}`);
  out.push(rep.verdict);
  return out;
}

const py = (b: boolean) => (b ? "True" : "False");
/** Python prints the int 0 where a sum over nothing was rounded (`round(sum([]), 1)`). */
const pyNum0 = (x: number) => (x === 0 ? "0" : pyNum(x));
const pyNum = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
const pyList = (l: string[]) => `[${l.map((s) => `'${s}'`).join(", ")}]`;
/** Python's repr for the JSON-ish values the impact lines print. */
function pyAny(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? `${v}.0` : String(v);
  if (typeof v === "string") return `'${v}'`;
  if (typeof v === "boolean") return py(v);
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyAny).join(", ")}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `'${k}': ${pyAny(x)}`).join(", ")}}`;
}

/**
 * Review checks, one function per check. Each takes the run context and returns a CheckResult.
 *
 * Layers: L0 identity, L1 native, L2 semantics, L3 physics, L4 mechanical, L5 interconnect, L6 fab/assembly data,
 * L8 expert pack. A check that cannot run returns status "error"; the gate never passes it.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { checkAcceptance, profile, pyRound, type DrcInput } from "../accept";
import { kids, type SNode } from "../sexpr";
import { BUILTIN_CARDS, INTERFACE_PROFILES } from "./data";
import { Fetch, EDA_URL, edaPinNames, fetchCacheDir } from "./fetch";
import { cut, f, g, s } from "./fmt";
import { boardOutline, mouthOf, pouredNets } from "./geometry";
import * as I from "./impedance";
import { lcsc, loadNetlist, type Comp } from "./netlist";
import * as P from "./pinsense";
import { applyCards } from "./rulecards";
import { ReviewCtx, reviewHome } from "./context";
import { SEVERITIES, findingId, makeFinding, newResult, type CheckResult, type Finding, type FindingInput, type Severity } from "./types";
import { exists } from "../files";

const FIND = (x: FindingInput) => makeFinding(x);
const pyList = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
const tup = (a: readonly number[]) => `(${a.map(s).join(", ")})`;

/** json.dumps with Python's default separators, for evidence text that reads the same on both sides. */
export function pyDumps(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (typeof x === "string") return JSON.stringify(x);
  if (typeof x === "number") return Number.isFinite(x) ? String(x) : "NaN";
  if (typeof x === "boolean") return x ? "true" : "false";
  if (Array.isArray(x)) return `[${x.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(x as object).map(([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`).join(", ")}}`;
}

// ---------------------------------------------------------------- shared classification data

const ERC_QUESTION = new Set(["pin_not_connected", "pin_not_driven", "power_pin_not_driven", "pin_to_pin", "no_connect_connected", "multiple_net_names", "different_unit_net", "similar_labels", "single_global_label", "label_dangling", "global_label_dangling", "hier_label_mismatch", "isolated_pin_label", "same_local_global_label", "duplicate_pins", "missing_power_pin", "missing_unit", "unit_value_mismatch", "net_not_bus_member", "bus_to_bus_conflict", "duplicate_reference", "unannotated"]);
const ERC_ENV = new Set(["lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues", "footprint_filter", "simulation_model_issue"]);
const DRC_QUESTION = new Set(["courtyards_overlap", "solder_mask_bridge", "track_dangling", "via_dangling", "footprint_type_mismatch", "lib_footprint_mismatch", "copper_edge_clearance", "hole_clearance", "clearance", "missing_courtyard", "malformed_courtyard", "npth_inside_courtyard", "pth_inside_courtyard", "item_on_disabled_layer", "footprint_symbol_mismatch", "shorting_items", "tracks_crossing", "hole_to_hole", "annular_width", "drill_out_of_range", "via_diameter", "track_width", "connection_width", "diff_pair_gap_out_of_range"]);
const DRC_ENV = new Set(["lib_footprint_issues"]);
const EXAMPLES = 4;
const PWR_PROXY_RE = /rule 'PWR_\d+ (outer width|inner width|neck in courtyard)'/;

interface RawItem {
  description?: string;
  pos?: { x?: number; y?: number };
}
interface RawViolation {
  type: string;
  severity: string;
  description?: string;
  items?: RawItem[];
}
interface Judged {
  type: string;
  match: string | RegExp;
  by: string;
  reason: string;
}

const items = (v: RawViolation) => cut((v.items ?? []).map((i) => i.description ?? "").join("; "), 220);
const pos = (v: RawViolation) => {
  for (const i of v.items ?? []) if (i.pos) return `(${s(i.pos.x ?? 0)}, ${s(i.pos.y ?? 0)})`;
  return "";
};

/** One finding per (severity, type): count + a few examples. Native output is grouped, never itemised. */
function group(violations: RawViolation[], source: string, layer: string, rule: string, sevFor: (sev: string, typ: string) => Severity | null, judged: Judged[] = []): Finding[] {
  const groups = new Map<string, { sev: string; typ: string; vs: RawViolation[] }>();
  const notes: Array<[RawViolation, Judged]> = [];
  for (const v of violations) {
    const why = judged.find((j) => v.type === j.type && new RegExp(j.match).test(v.description ?? ""));
    if (why) {
      notes.push([v, why]);
      continue;
    }
    const k = `${v.severity}\u0000${v.type}`;
    (groups.get(k) ?? groups.set(k, { sev: v.severity, typ: v.type, vs: [] }).get(k)!).vs.push(v);
  }
  const out: Finding[] = [];
  for (const k of [...groups.keys()].sort()) {
    const { sev, typ, vs } = groups.get(k)!;
    const sv = sevFor(sev, typ);
    if (sv === null) continue;
    const ex = vs.slice(0, EXAMPLES).map((v) => `${items(v)} ${pos(v)}`.trim());
    out.push(FIND({ layer, rule, severity: sv, claim: `${source} ${sev} ${typ}: ${vs.length} item(s) - ${vs[0]!.description ?? ""}`, key: `${sev}-${typ}`, evidence: ex.map((e) => ({ source: source.toLowerCase(), detail: e })) }));
  }
  const byRule = new Map<string, [RawViolation, Judged, number]>();
  for (const [v, why] of notes) {
    const e = byRule.get(why.by) ?? byRule.set(why.by, [v, why, 0]).get(why.by)!;
    e[2]++;
  }
  for (const [by, [v, why, n]] of byRule) out.push(FIND({ layer, rule, severity: "note", claim: `${n} ${source} ${v.type} item(s) judged by ${by}: ${why.reason}`, key: `judged-${by}` }));
  return out;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function spawn(cmd: string[], cwd?: string, timeoutMs = 60_000, verbatim = false): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}), timeout: timeoutMs, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) {
    return { code: 127, out: "", err: String(e) };
  }
}

// ---------------------------------------------------------------- L0 identity

export async function checkIdentity(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("identity", "L0");
  const b = ctx.project;
  const missing = Object.entries(ctx.files).filter(([, h]) => h === "MISSING").map(([k]) => k);
  for (const m of missing) r.findings.push(FIND({ layer: "L0", rule: "FILES", severity: "must-fix", claim: `design file listed in the config is missing: ${m}`, key: basename(m) }));
  if (!(await exists(b.pcb)) || !(await exists(b.sch))) {
    r.status = "error";
    r.detail = `board or schematic missing: ${b.pcb} / ${b.sch}`;
    return r;
  }
  // git identity of the design files (release from a committed state)
  const top = await spawn(["git", "-C", b.dir, "rev-parse", "--show-toplevel"]);
  if (top.code === 0) {
    const root = top.out.trim();
    const head = (await spawn(["git", "-C", root, "rev-parse", "HEAD"])).out.trim();
    const rel: string[] = [];
    for (const k of Object.keys(ctx.files)) {
      const abs = isAbsolute(k) ? k : join(b.dir, k);
      if ((await exists(abs)) && abs.startsWith(root + "/")) rel.push(abs.slice(root.length + 1));
    }
    const st = rel.length ? (await spawn(["git", "-C", root, "status", "--porcelain", "--", ...rel])).out.split("\n").filter(Boolean) : [];
    r.artifacts["git"] = { top: root, head, dirty: st };
    if (st.length)
      r.findings.push(FIND({ layer: "L0", rule: "GIT", severity: "question", claim: `${st.length} design file(s) differ from git HEAD ${head.slice(0, 10)}: the review covers files nobody can check out`, key: "dirty", evidence: st.slice(0, 8).map((x) => ({ source: "git status", detail: x })), suggest: "commit the design before release review" }));
  } else r.artifacts["git"] = null;
  r.detail = `hash ${ctx.hash.slice(0, 12)}, ${Object.keys(ctx.files).length} files, ${ctx.env.kicadVersion}`;
  return r;
}

export async function checkNetlist(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("netlist", "L0");
  const out = join(ctx.out, "netlist.xml");
  const p = await ctx.env.kicad(["sch", "export", "netlist", "--format", "kicadxml", "-o", out, ctx.project.sch]);
  if (p.exitCode !== 0 || !(await exists(out))) {
    r.status = "error";
    r.detail = `netlist export failed: ${p.stdout.slice(-300)} ${p.stderr.slice(-300)}`;
    return r;
  }
  ctx.comps = loadNetlist(await readFile(out, "utf8"));
  r.artifacts["netlist"] = out;
  r.detail = `${ctx.comps.size} parts`;
  return r;
}

// ---------------------------------------------------------------- L1 native

export async function checkErc(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("erc", "L1");
  const out = join(ctx.out, "erc.json");
  await ctx.env.kicad(["sch", "erc", "--format", "json", "--severity-all", "-o", out, ctx.project.sch]);
  const d = await readJson<{ sheets?: Array<{ violations?: RawViolation[] }> }>(out);
  if (!d) {
    r.status = "error";
    r.detail = "ERC produced no report";
    return r;
  }
  const vs = (d.sheets ?? []).flatMap((sh) => sh.violations ?? []);
  const sev = (sv: string, t: string): Severity | null => {
    if (sv === "exclusion") return null;
    if (sv === "error" && !ERC_ENV.has(t)) return "must-fix";
    if (ERC_ENV.has(t)) return "note";
    return ERC_QUESTION.has(t) ? "question" : "note";
  };
  r.findings = group(vs, "ERC", "L1", "ERC", sev);
  r.artifacts["erc"] = out;
  r.detail = `${vs.filter((v) => v.severity === "error").length} errors, ${vs.filter((v) => v.severity === "warning").length} warnings`;
  return r;
}

export async function checkDrc(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("drc", "L1");
  const out = join(ctx.out, "drc.json");
  await ctx.env.kicad(["pcb", "drc", "--format", "json", "--severity-all", "--schematic-parity", "--refill-zones", "-o", out, ctx.project.pcb]);
  const d = await readJson<{ violations?: RawViolation[]; unconnected_items?: RawViolation[]; schematic_parity?: RawViolation[] }>(out);
  if (!d) {
    r.status = "error";
    r.detail = "DRC produced no report";
    return r;
  }
  const judged: Judged[] = [...(ctx.project.cfg.native?.judged_elsewhere ?? [])];
  if (ctx.acceptance && !judged.some((j) => j.type === "track_width"))
    // a board with requirements: its acceptance (A7) owns the PWR_* proxy findings
    judged.push({ type: "track_width", match: PWR_PROXY_RE, by: "A7", reason: "generated PWR_* class-width rules are a courtyard proxy for the neck rule; A7 judges power widths" });
  const sev = (sv: string, t: string): Severity | null => {
    if (sv === "exclusion") return null;
    if (sv === "error") return "must-fix";
    if (DRC_ENV.has(t)) return "note";
    return DRC_QUESTION.has(t) ? "question" : "note";
  };
  r.findings = group(d.violations ?? [], "DRC", "L1", "DRC", sev, judged);
  const un = d.unconnected_items ?? [];
  if (un.length) r.findings.push(FIND({ layer: "L1", rule: "OPEN", severity: "must-fix", claim: `${un.length} unconnected item(s)`, key: "unconnected", evidence: un.slice(0, EXAMPLES).map((v) => ({ source: "drc", detail: items(v) })) }));
  const par = d.schematic_parity ?? [];
  r.findings.push(...group(par, "PARITY", "L1", "PARITY", (sv) => (sv !== "exclusion" ? "must-fix" : null)));
  r.artifacts["drc"] = out;
  ctx.drc = out;
  const nerr = (d.violations ?? []).filter((v) => v.severity === "error").length;
  r.detail = `${nerr} errors (${r.findings.filter((x) => x.key.startsWith("judged")).length} groups judged elsewhere), ${un.length} unconnected, ${par.length} parity`;
  return r;
}

export async function checkAcceptanceLayer(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("acceptance", "L1");
  if (!ctx.requirements || !ctx.drc) {
    r.status = "skipped";
    r.detail = ctx.acceptance ? "no DRC report to read" : "no requirements (board_check onboards them)";
    return r;
  }
  const raw = await readJson<{ violations?: RawViolation[]; unconnected_items?: unknown[]; schematic_parity?: unknown[] }>(ctx.drc);
  const drc: DrcInput = {
    violations: (raw?.violations ?? []).map((v) => ({ rule: v.type, severity: v.severity, description: v.description ?? "" })),
    unconnected: (raw?.unconnected_items ?? []).length,
    parity: (raw?.schematic_parity ?? []).length,
  };
  const req = ctx.requirements!;
  const d = checkAcceptance(ctx.board, req, drc, { boardPath: ctx.project.pcb });
  await writeFile(join(ctx.out, "acceptance.json"), JSON.stringify(d, null, 1) + "\n");
  const layer: Record<string, string> = { A1: "L1", A2: "L1", A3: "L1", A4: "L2", A5: "L4", A6: "L3", A7: "L3", A8: "L3", A9: "L4" };
  const names = d.names as Record<string, string>;
  for (const [k, ok] of Object.entries(d.summary)) {
    const a = k.split("_")[0]!;
    if (!ok) {
      const det = cut(pyDumps((d.results as Record<string, unknown>)[k]), 400);
      r.findings.push(FIND({ layer: layer[a] ?? "L1", rule: a, severity: "must-fix", claim: `acceptance ${names[a] ?? k} (${a}) fails`, key: k, evidence: [{ source: "check_acceptance", detail: det }] }));
    }
  }
  // reported-but-not-gating numbers: pair skew over the class limit
  const coupling = ((d.results.A8_pairs as unknown as { coupling?: Record<string, Record<string, unknown>> }).coupling ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pair, c] of Object.entries(coupling)) {
    const lim = c["skew_limit_mm"] as number | undefined, diff = c["length_difference_mm"] as number | undefined;
    if (lim !== undefined && diff !== undefined && diff > lim)
      r.findings.push(FIND({ layer: "L3", rule: "SKEW", severity: "question", claim: `pair ${pair}: length difference ${s(diff)} mm > ${s(lim)} mm (${c["class"]}, coupled ${c["coupled_share"]}); A8 reports it, does not gate`, net: pair.split(" / ")[0]!, key: pair, suggest: "tune the pair, or record why this skew is acceptable at its data rate" }));
  }
  r.artifacts["acceptance"] = join(ctx.out, "acceptance.json");
  r.detail = Object.entries(d.summary)
    .map(([k, v]) => `${names[k.split("_")[0]!] ?? k}${v ? "" : " FAIL"}${(d.results as Record<string, { applies?: boolean }>)[k]?.applies === false ? " (not set)" : ""}`)
    .join(", ");
  return r;
}

// ---------------------------------------------------------------- L2 semantics

function fetcher(ctx: ReviewCtx, offline = ctx.offline): Fetch {
  return new Fetch(fetchCacheDir(), offline, ctx.env.signal);
}

export async function checkPinsense(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("pinsense", "L2");
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist";
    return r;
  }
  const fx = fetcher(ctx);
  const res = await P.review(ctx.comps, fx);
  ctx.oraclePins = {};
  for (const x of res.confirmed) {
    const ref = x.slice(0, x.lastIndexOf("."));
    ctx.oraclePins[ref] = (ctx.oraclePins[ref] ?? 0) + 1;
  }
  const suggest: Record<string, string> = {
    G: "use a real symbol, or confirm every pin against the datasheet table",
    F: "route it to a reader (GPIO/LED/test point) or record why it may stay silent",
    O: "settle with the datasheet (third source); record which source was wrong",
    R: "check the pin map against the datasheet",
  };
  for (const x of res.raw) {
    const sv: Severity = x.rule === "R" && x.severity === "error" ? "must-fix" : "question";
    r.findings.push(FIND({ layer: "L2", rule: x.rule, severity: sv, claim: x.message, ref: x.ref, pad: x.pin !== "*" ? String(x.pin) : "", net: String(x.evidence["net"] ?? ""), evidence: [{ source: x.rule !== "O" ? "netlist" : `jlc-symbol ${x.evidence["lcsc"]}`, detail: pyDumps(x.evidence) }], suggest: suggest[x.rule] ?? "" }));
  }
  r.detail = `${res.raw.length} findings, LCSC fetches ${fx.calls}` + (res.skipped.length ? `, ${res.skipped.length} oracle pins skipped by errata` : "");
  return r;
}

export async function loadProjectCards(dir: string) {
  const folder = join(reviewHome(dir), "cards");
  const cards = [...BUILTIN_CARDS];
  for (const n of (await readdir(folder).catch(() => [] as string[])).filter((x) => x.endsWith(".json")).sort()) {
    const c = await readJson<Omit<(typeof BUILTIN_CARDS)[number], "_file">>(join(folder, n));
    if (c) {
      const i = cards.findIndex((x) => x._file === n);
      const card = { ...c, _file: n };
      if (i >= 0) cards[i] = card;
      else cards.push(card);
    }
  }
  return cards.sort((a, b) => (a._file < b._file ? -1 : 1));
}

export async function checkCards(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("cards", "L2");
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist";
    return r;
  }
  const cards = await loadProjectCards(ctx.project.dir);
  const res = await applyCards(ctx.comps, cards, fetcher(ctx), ctx.project.name);
  ctx.cardsMatched = res.matched;
  for (const x of res.findings)
    r.findings.push(FIND({ layer: "L2", rule: "CARD", severity: x.severity, claim: x.message, ref: x.ref, pad: x.pad, key: x.card.replace(".json", "") + (!x.pad ? `-${x.pad}` : ""), evidence: [{ source: `card ${x.card} (${x.pins_from})`, detail: x.source }], suggest: "check the circuit against the datasheet; if the card is wrong, fix the card (and say so)" }));
  r.detail = `${cards.length} cards, ${res.evaluated} rules evaluated, ${res.findings.length} failed`;
  return r;
}

const EVIDENCE_REF = /(?:^|_)(U|IC|Q|J|CN|USB|P|Y)\d+$/;

export async function checkEvidence(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("evidence", "L2");
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist";
    return r;
  }
  const fx = fetcher(ctx, true);
  const ds = new Map<string, string | undefined>();
  for (const rec of ctx.bom?.records ?? []) for (const ref of Array.isArray(rec.refs) ? rec.refs : []) ds.set(ref, rec.checks?.datasheet);
  const cards = ctx.cardsMatched;
  const tally: Record<string, number> = { datasheet: 0, "jlc symbol": 0, card: 0, none: 0 };
  for (const [ref, c] of [...ctx.comps].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!EVIDENCE_REF.test(ref) || c.pins.size < 2) continue;
    const netted = [...c.pins.values()].map((v) => v.net).filter((n) => n && !n.startsWith("unconnected-"));
    if (!netted.length) continue;
    const src: string[] = [];
    const url = ds.get(ref) || c.fields["Datasheet"] || "";
    if (url.startsWith("http")) src.push("datasheet");
    const code = lcsc(c);
    if (code) {
      const rec = await fx.get(`eda-${code}`, EDA_URL(code));
      if (rec && Object.keys(edaPinNames(rec)).length) src.push("jlc symbol");
    }
    if (cards.has(ref)) src.push("card");
    for (const k of src) tally[k] = (tally[k] ?? 0) + 1;
    if (!src.length) {
      tally["none"] = (tally["none"] ?? 0) + 1;
      const power = [...new Set(netted.filter((n) => /5V|3V3|VBAT|VBUS|PACK_PLUS|VSYS|\+\d/i.test(n)))].sort();
      r.findings.push(FIND({ layer: "L2", rule: "EVIDENCE", severity: "note", claim: `UNVERIFIED ${ref} (${c.value}): no outside source for its pinout (no datasheet link, no JLC symbol, no rule card)` + (power.length ? `; carries ${power.slice(0, 3).join(", ")}` : ""), ref, suggest: "add a datasheet link, an LCSC code, or a bench card (review/cards, source_kind measurement)" }));
    }
  }
  r.detail = Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ") + " (advisory: never blocks)";
  return r;
}

// ---------------------------------------------------------------- L3 physics

const SUPPLY = /^(VCC|VDD|AVDD|DVDD|VDDIO|IOVDD|VDDA|VDDD|VIN|PVIN|VBAT|VSYS|AVCC|VCCIO|VCCA|VCCB|VDD\d+\w*|VCC\d+\w*|VD\d\d\w*|V\d?P\d\w*|VDD_\w+|VCC_\w+|VREG\w*|VBUS)$/;
const BULK_PIN = new Set(["VIN", "PVIN", "VBUS", "VBAT", "VSYS"]);
const ESD = /USBLC|TPD\d|ESD|PESD|TVS|SRV05|RCLAMP|PRTR/i; // protection arrays: VBUS pin is a reference, not a supply
const CAP_REF = /(?:^|_)C\d+$/;
const IC_REF = /(?:^|_)(U|IC)\d+$/;

export function capValue(v: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*([pnuµm]?)F?/i.exec(v || "");
  if (!m) return null;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, "": 1e-6 };
  return Number(m[1]) * mult[m[2]!.toLowerCase()]!;
}

export async function checkDecoupling(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("decoupling", "L3");
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist";
    return r;
  }
  const parts = ctx.parts();
  const padsByNet = new Map<string, Array<[(typeof parts)[number], (typeof parts)[number]["pads"][number]]>>();
  for (const p of parts) for (const q of p.pads) if (q.net) (padsByNet.get(q.net) ?? padsByNet.set(q.net, []).get(q.net)!).push([p, q]);
  const xy = new Map<string, [number, number]>();
  for (const p of parts) for (const q of p.pads) xy.set(`${p.ref}\u0000${q.n}`, [q.x, q.y]);
  const cfg = ctx.project.cfg.decoupling ?? {};
  const lim = cfg.max_mm ?? 5.0, limBulk = cfg.max_mm_bulk ?? 8.0;
  let checked = 0;
  for (const [ref, c] of ctx.comps) {
    if (!IC_REF.test(ref) || c.pins.size < 4 || ESD.test(c.value || "")) continue;
    const bad: Array<[string, Record<string, unknown>]> = [];
    const ownGnd = new Set<string>();
    for (const v of c.pins.values()) if (/^(GND|VSS|AGND|PGND|DGND|EP|EPAD|DAP|PAD|VSS\d*|GND\d*)(\/|$)/.test(P.stripNum(P.norm(v.name)) || "")) ownGnd.add(v.net);
    for (const [pad, v] of c.pins) {
      const nm = P.stripNum(P.norm(v.name));
      const at = xy.get(`${ref}\u0000${pad}`);
      if (!SUPPLY.test(nm) || P.isGndNet(v.net) || ownGnd.has(v.net) || v.nodes <= 1 || !at) continue;
      checked++;
      let best: [string, number] | null = null;
      for (const [p, q] of padsByNet.get(v.net) ?? []) {
        if (!CAP_REF.test(p.ref || "") || p.flags.includes("dnp")) continue;
        const val = capValue(p.value);
        if (val !== null && val > 22.5e-6) continue;
        if (!p.pads.some((o) => o !== q && (P.isGndNet(o.net) || ownGnd.has(o.net)))) continue;
        const d = Math.hypot(at[0] - q.x, at[1] - q.y);
        if (best === null || d < best[1]) best = [p.ref, d];
      }
      const limit = BULK_PIN.has(nm) ? limBulk : lim;
      const data = { pin: pad, name: v.name, net: v.net, xy: at.map((c_) => (Math.round(c_ * 1000) / 1000)), limit, cap: best ? best[0] : null, dist: best ? Math.round(best[1] * 100) / 100 : null };
      if (best === null) bad.push([`pin ${pad} ${v.name} (${v.net}): no capacitor to ground on this net`, data]);
      else if (best[1] > limit) bad.push([`pin ${pad} ${v.name}: nearest ${best[0]} at ${f(best[1], 1)} mm (> ${g(limit)})`, data]);
    }
    if (bad.length)
      r.findings.push(FIND({ layer: "L3", rule: "DECAP", severity: "question", claim: `${ref} (${c.value}): ` + bad.slice(0, 4).map((b) => b[0]).join("; ") + (bad.length > 4 ? ` (+${bad.length - 4})` : ""), ref, evidence: bad.map(([b, dt]) => ({ source: "board geometry + netlist pin names", detail: b, data: dt })), suggest: "move the capacitor to the pin, or record why the distance is fine (shared plane, bulk pin)" }));
  }
  r.detail = `${checked} supply pins checked, limits ${lim}/${limBulk} mm`;
  return r;
}

/** Cross-section (mil^2) carrying i_a at rise_c of heating: the IPC-2152 baseline fit. */
const area2152 = (iA: number, riseC: number) => (117.555 * riseC ** -0.913 + 1.15) * iA ** (0.84 * riseC ** -0.108 + 1.159);

export function traceRiseC(iA: number, wMm: number, tMm: number): number {
  const area = (wMm / 0.0254) * (tMm / 0.0254);
  if (iA <= 0 || area <= 0) return 0;
  let lo = 1e-3, hi = 1e4;
  if (area2152(iA, hi) > area) return hi;
  for (let k = 0; k < 80; k++) {
    const mid = Math.sqrt(lo * hi);
    if (area2152(iA, mid) > area) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function widthFor(iA: number, riseC: number, tMm: number, method = "ipc2152", inner = false): number {
  if (method === "ipc2221") {
    const k = inner ? 0.024 : 0.048;
    return ((iA / (k * riseC ** 0.44)) ** (1 / 0.725) / (tMm / 0.0254)) * 0.0254;
  }
  return (area2152(iA, riseC) / (tMm / 0.0254)) * 0.0254;
}

export function rise2221(iA: number, wMm: number, tMm: number, inner: boolean): number {
  const area = (wMm / 0.0254) * (tMm / 0.0254);
  const k = inner ? 0.024 : 0.048;
  return area > 0 && iA > 0 ? (iA / (k * area ** 0.725)) ** (1 / 0.44) : 0;
}

const POWER_PIN = /^(VIN|PVIN|VOUT|OUT|IN|SW|VBUS|VSYS|SYS|PMID|BAT|VBAT|VCC|VDD|VREG|PPHV|VAC\d?|ACP|ACN|SRP|SRN|PACK|LX|PH|BOOT_?VIN)/;

class Heap {
  private a: Array<[number, number]> = [];
  push(x: [number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, rr = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (rr < a.length && a[rr]![0] < a[m]![0]) m = rr;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/** A connector's reference (J1, USB701, CN2, BT1, P3, X1). */
const CONNECTOR_REF = /^(J|USB|CN|BT|P|X)\d/;
/** A supply net by name (VBUS_USB2.0, +5V, M2_3V3, HDMI_+5V, VIN, +BATT) ... */
const SUPPLY_NET = /(VBUS|VIN|VCC|VDD|VSYS|VBAT|BATT?)|(^|[^A-Za-z0-9])\+?\d+V\d*|_\d+V\d*$/i;
/** ... and not a control signal named after one (VBUS_EN, PWR_BUT, nLED_PWR, VBUS_DET, PGOOD). */
const SUPPLY_CONTROL = /(_EN$|EN$|_BUT|LED|SENSE|_OK$|PGOOD|_PG$|DET|_ID$|_CC\d?$|SCL|SDA|IRQ|INT\b|SYNC|GPIO|BAD|RST|RESET|CLK|_TX|_RX|MISO|MOSI|~\{)/i;

/** IPC-2221 external-layer ampacity (A) of a track: width and thickness in mm, rise in degrees C. */
export function ipc2221ExternalAmps(widthMm: number, thicknessMm: number, riseC: number): number {
  const areaMil2 = (widthMm / 0.0254) * (thicknessMm / 0.0254);
  return 0.048 * riseC ** 0.44 * areaMil2 ** 0.725;
}

/**
 * Supply nets (a supply name, a capacitor on the net, no control/signal token) that enter through a connector, carry
 * no declared current, and are routed at signal width: at least
 * 80 % of at least 5 mm of track at or below the board's length-weighted median track width. On cm5_minima this is
 * the seeded 0.15 mm VBUS and nothing on the unseeded board (its supplies run at 0.25 mm and up; 0.15 mm stretches on
 * +1V8 / +3V3_PI are short IC fan-outs on nets no connector feeds).
 */
export function signalWidthSupplies(ctx: ReviewCtx, declared: Set<string>, riseC = 20): Finding[] {
  const board = ctx.board;
  const len = (sg: { a: [number, number]; b: [number, number] }) => Math.hypot(sg.a[0] - sg.b[0], sg.a[1] - sg.b[1]);
  const all = board.segments.map((sg) => [sg.w, len(sg)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const total = all.reduce((t, [, l]) => t + l, 0);
  if (!total) return [];
  let acc = 0, signalW = all[all.length - 1]![0];
  for (const [w, l] of all) if ((acc += l) >= total / 2) { signalW = w; break; }
  const fed = new Map<string, Set<string>>();
  for (const p of board.pads) if (p.net && CONNECTOR_REF.test(p.ref)) (fed.get(p.net) ?? fed.set(p.net, new Set()).get(p.net)!).add(p.ref);
  // a rail has decoupling: a capacitor on the net (signals named after their IO voltage, I2C0_SCL_1V8, do not)
  const capped = new Set(board.pads.filter((p) => p.net && /^C\d/.test(p.ref)).map((p) => p.net));
  const out: Finding[] = [];
  for (const [net, refs] of [...fed].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (declared.has(net) || !SUPPLY_NET.test(net) || SUPPLY_CONTROL.test(net) || !capped.has(net)) continue;
    const segs = board.segments.filter((sg) => sg.net === net);
    const L = segs.reduce((t, sg) => t + len(sg), 0);
    const narrow = segs.filter((sg) => sg.w <= signalW + 1e-6).reduce((t, sg) => t + len(sg), 0);
    if (L < 5 || narrow / L < 0.8) continue;
    const wmin = Math.min(...segs.map((sg) => sg.w));
    const amps = ipc2221ExternalAmps(wmin, 0.035, riseC);
    const via = [...refs].sort().join(", ");
    out.push(
      FIND({
        layer: "L3",
        rule: "SUPPLY_WIDTH",
        severity: "question",
        ref: [...refs].sort()[0]!,
        net,
        key: `supply-width-${net}`,
        claim: `${net} enters through ${via} and is routed at signal width: ${Math.round((100 * narrow) / L)}% of ${pyRound(L, 1)} mm at or below ${signalW} mm (narrowest ${wmin} mm, about ${pyRound(amps, 2)} A at ${riseC} C rise on 35 um outer copper, IPC-2221); no current is declared for it`,
        evidence: [{ source: "board", detail: `track widths on ${net}: ${[...new Set(segs.map((sg) => sg.w))].sort((a, b) => a - b).join(", ")} mm; board median track width ${signalW} mm` }],
        suggest: `declare ${net}'s current (review.currents) so the current check sizes it, or widen it to what ${via} can deliver`,
      }),
    );
  }
  return out;
}

export async function checkCurrent(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("current", "L3");
  const acc = ctx.acceptance;
  const nc = (acc?.net_classes ?? {}) as Partial<NonNullable<typeof acc>["net_classes"]>;
  const cur: Record<string, number> = {};
  for (const cl of Object.values(nc.classes ?? {})) if (cl.current_max_A) for (const n of cl.nets ?? []) cur[n] = Number(cl.current_max_A);
  for (const [k, v] of Object.entries(nc.net_current_A ?? {})) cur[k] = Number(v);
  for (const [k, v] of Object.entries(ctx.project.cfg.currents ?? {})) cur[k] = Number(v);
  const cfg = ctx.project.cfg.current_check ?? {};
  const riseMax = cfg.rise_max_c ?? 20.0, dropPct = cfg.drop_max_pct ?? 2.0, minLen = cfg.min_track_mm ?? 2.0;
  // supply nets without a declared current are still looked at: one that enters through a connector and is routed at
  // signal width is a question (a narrowed VBUS passes DRC, ERC and A1-A9; the eval's seeded review fault)
  r.findings.push(...signalWidthSupplies(ctx, new Set(Object.keys(cur)), riseMax));
  if (!Object.keys(cur).length) {
    r.status = "skipped";
    r.detail = "no currents declared (acceptance net_current_A / class current_max_A / review.currents)";
    r.findings.push(FIND({ layer: "L3", rule: "CURRENT", severity: "note", claim: "no design currents declared: trace heating and voltage drop were not checked", key: "no-currents", suggest: "declare currents per power net (review.currents in the board entry)" }));
    return r;
  }
  const text = ctx.pcbText;
  const thick: Record<string, number> = {};
  const st = text.indexOf("(stackup");
  for (const m of (st >= 0 ? text.slice(st, st + 20000) : "").matchAll(/\(layer "([^"]+\.Cu)"\s*\(type "copper"\)\s*\(thickness ([\d.]+)\)/g)) thick[m[1]!] = Number(m[2]);
  const poured = pouredNets(ctx.root);
  const board = ctx.board;
  const segsByNet = new Map<string, typeof board.segments>();
  for (const sg of board.segments) (segsByNet.get(sg.net) ?? segsByNet.set(sg.net, []).get(sg.net)!).push(sg);
  const padsByNet = new Map<string, typeof board.pads>();
  for (const p of board.pads) (padsByNet.get(p.net) ?? padsByNet.set(p.net, []).get(p.net)!).push(p);
  const rho = 1.72e-8;
  let checked = 0;
  const method = cfg.method ?? (String((nc as { basis?: string }).basis ?? "").includes("IPC-2221") ? "ipc2221" : "ipc2152");
  const len = (sg: { a: [number, number]; b: [number, number] }) => Math.hypot(sg.a[0] - sg.b[0], sg.a[1] - sg.b[1]);

  const carries = (ref: string, pad: string): boolean => {
    const kind = (ref ? ref.split("_").pop()! : "").replace(/\d.*$/, "");
    if (["J", "L", "F", "Q", "D", "BT", "TP", "P", "CN", "USB", "FB"].includes(kind)) return true;
    if (kind === "R") {
      // only a current-sense resistor sits in the trunk
      const v = (board.footprints.get(ref)?.value ?? "").toLowerCase();
      return /(\d+(\.\d+)?\s*m(ohm|r|\b)|^0r?\b|^0\.0\d|r0\d)/.test(v);
    }
    if (kind === "U" || kind === "IC") {
      const c_ = ctx.comps?.get(ref);
      if (!c_) return true;
      const nm = (c_.pins.get(pad)?.name ?? "").toUpperCase();
      return POWER_PIN.test(nm.replace(/[^A-Z0-9_]/g, ""));
    }
    return false;
  };
  for (const [net, iA] of Object.entries(cur).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tr = segsByNet.get(net) ?? [];
    if (!tr.length) continue;
    checked++;
    const tOf = (lay: string) => thick[lay] ?? (lay === "F.Cu" || lay === "B.Cu" ? 0.035 : 0.0175);
    const nodes = new Map<string, number>();
    const keyPts: Array<[number, number]> = [];
    const edges = new Map<number, Array<[number, number, number]>>();
    const nid = (pt: [number, number]) => {
      const k: [number, number] = [pyRound(pt[0], 2), pyRound(pt[1], 2)];
      const ks = `${k[0]},${k[1]}`;
      let id = nodes.get(ks);
      if (id === undefined) {
        id = nodes.size;
        nodes.set(ks, id);
        keyPts.push(k);
      }
      return id;
    };
    tr.forEach((sg, k_) => {
      const a = nid(sg.a), b = nid(sg.b);
      const res = (rho * (len(sg) / 1000)) / ((sg.w / 1000) * (tOf(sg.layer) / 1000));
      (edges.get(a) ?? edges.set(a, []).get(a)!).push([b, res, k_]);
      (edges.get(b) ?? edges.set(b, []).get(b)!).push([a, res, k_]);
    });
    let pn: number[] = [];
    for (const p of padsByNet.get(net) ?? []) {
      if (!carries(p.ref, p.pad)) continue;
      let best = -1, bd = Infinity;
      keyPts.forEach((k, idx) => {
        const d = Math.hypot(k[0] - p.x, k[1] - p.y);
        if (d < bd) {
          bd = d;
          best = idx;
        }
      });
      if (best >= 0 && bd <= p.r + 0.3) pn.push(best);
    }
    pn = [...new Set(pn)].sort((a, b) => a - b);
    let worstR = 0;
    const trunk = new Set<number>();
    for (const src of pn.slice(0, 16)) {
      const dist = new Map<number, number>([[src, 0]]);
      const via = new Map<number, [number, number]>();
      const hq = new Heap();
      hq.push([0, src]);
      for (let it = hq.pop(); it; it = hq.pop()) {
        const [d0, n0] = it;
        if (d0 > (dist.get(n0) ?? 1e18)) continue;
        for (const [n1, er, k_] of edges.get(n0) ?? [])
          if (d0 + er < (dist.get(n1) ?? 1e18)) {
            dist.set(n1, d0 + er);
            via.set(n1, [n0, k_]);
            hq.push([d0 + er, n1]);
          }
      }
      for (let x of pn)
        if (dist.has(x)) {
          worstR = Math.max(worstR, dist.get(x)!);
          while (via.has(x)) {
            const [px, k_] = via.get(x)!;
            x = px;
            trunk.add(k_);
          }
        }
    }
    const inner = (lay: string) => lay !== "F.Cu" && lay !== "B.Cu";
    const riseOf = (sg: (typeof tr)[number]) => (method === "ipc2221" ? rise2221(iA, sg.w, tOf(sg.layer), inner(sg.layer)) : traceRiseC(iA, sg.w, tOf(sg.layer)));
    const long_ = [...trunk].sort((a, b) => a - b).map((k_) => tr[k_]!).filter((sg) => len(sg) >= minLen);
    let worst: (typeof tr)[number] | null = null;
    let worstRise = -Infinity;
    for (const sg of long_) {
      const rs = riseOf(sg);
      if (rs > worstRise) {
        worstRise = rs;
        worst = sg;
      }
    }
    const rise = worst ? worstRise : 0;
    const dropMv = worstR * iA * 1000;
    const vm = /(\d+)V(\d*)/.exec(net.toUpperCase().replaceAll("VBUS", "5V"));
    const volts = vm ? Number(`${vm[1]}.${vm[2] || 0}`) : null;
    const pour = poured.has(net);
    const sev: Severity = pour ? "note" : "question";
    if (worst && rise > riseMax) {
      const need = widthFor(iA, riseMax, tOf(worst.layer), method, inner(worst.layer));
      const alt = method === "ipc2221" ? traceRiseC(iA, worst.w, tOf(worst.layer)) : rise2221(iA, worst.w, tOf(worst.layer), inner(worst.layer));
      r.findings.push(FIND({ layer: "L3", rule: "HEAT", severity: sev, claim: `${net}: ${g(iA)} A heats its ${g(worst.w)} mm ${worst.layer} track (${f(len(worst), 1)} mm long) by about ${f(rise, 0)} C (limit ${g(riseMax)} C); needs >= ${f(need, 2)} mm` + (pour ? " (net also has a copper pour: advisory)" : ""), net, key: net, evidence: [{ source: `${method} (the board's declared basis)`, detail: `trunk track at ${tup(worst.a)} - ${tup(worst.b)}; ${method === "ipc2221" ? "IPC-2152 baseline" : "IPC-2221"} gives ${f(alt, 0)} C` }], suggest: `widen to >= ${f(need, 2)} mm (raise the class width, then last-mile a7), or pour it` }));
    }
    if (volts && dropMv > (dropPct / 100) * volts * 1000)
      r.findings.push(FIND({ layer: "L3", rule: "DROP", severity: sev, claim: `${net}: ${f(dropMv, 0)} mV worst-path copper drop at ${g(iA)} A (${f(dropMv / (volts * 10), 1)} % of ${g(volts)} V; limit ${g(dropPct)} %)` + (pour ? " (pour not counted)" : ""), net, key: net, evidence: [{ source: "track resistance graph", detail: `${f(worstR * 1000, 1)} mOhm` }], suggest: "widen or shorten the path, add a pour, or record why the drop is fine for the load" }));
  }
  const cu = [...new Set(Object.values(thick))].sort((a, b) => a - b);
  r.detail = `${checked} nets with declared currents; trunk only (current-carrying pads); method ${method}; copper ${cu.length ? `[${cu.map(s).join(", ")}]` : "default"} mm; limits ${g(riseMax)} C / ${g(dropPct)} %`;
  return r;
}

export async function checkImpedance(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("impedance", "L3");
  const acc = ctx.acceptance;
  const classes = Object.fromEntries(Object.entries(acc?.net_classes?.classes ?? {}).filter(([, v]) => v.pairs?.length && v.diff_pair_gap !== undefined && v.diff_pair_gap !== null));
  if (!Object.keys(classes).length) {
    r.status = "skipped";
    r.detail = "no differential pair classes in the board acceptance";
    return r;
  }
  const st = I.stackup(ctx.pcbText);
  if (!st.length) {
    r.status = "skipped";
    r.detail = "no stack-up in the board file";
    r.findings.push(FIND({ layer: "L3", rule: "ZDIFF", severity: "note", claim: "board file has no stack-up: impedance not estimated", key: "no-stackup", suggest: "define the stack-up in the board setup (thicknesses, er)" }));
    return r;
  }
  const planes = profile(acc!).planes;
  const cfg = ctx.project.cfg.impedance ?? {};
  const modelUnc = cfg.model_uncertainty_pct ?? 10.0;
  const byNet = new Map<string, typeof ctx.board.segments>();
  for (const sg of ctx.board.segments) (byNet.get(sg.net) ?? byNet.set(sg.net, []).get(sg.net)!).push(sg);
  const vcount = new Map<string, number>();
  for (const v of ctx.board.vias) vcount.set(v.net, (vcount.get(v.net) ?? 0) + 1);
  const len = (sg: { a: [number, number]; b: [number, number] }) => Math.hypot(sg.a[0] - sg.b[0], sg.a[1] - sg.b[1]);
  let nPairs = 0;
  const rows: Array<[string, string, number, number | null]> = [];
  for (const [cname, cl] of Object.entries(classes)) {
    const [tgt, tol, prof] = I.targetOf(cname, cl as { target?: unknown }, INTERFACE_PROFILES);
    const w = Number(cl.diff_pair_width || cl.track_width), s_ = Number(cl.diff_pair_gap);
    const minRun = Math.max(Number(cl.escape_allowance_mm || 0), cfg.min_run_mm ?? 3.0);
    for (const [pNet, nNet] of cl.pairs ?? []) {
      const ps = byNet.get(pNet) ?? [], ns = byNet.get(nNet) ?? [];
      if (!ps.length || !ns.length) continue;
      nPairs++;
      const meas = I.measuredGap(ps, ns, w, s_);
      const run = new Map<string, number>();
      for (const sg of ps) run.set(sg.layer, (run.get(sg.layer) ?? 0) + len(sg));
      for (const [lay, L] of [...run].sort((a, b) => b[1] - a[1])) {
        if (L < minRun) continue;
        const geo = I.reference(st, lay, planes);
        if (!geo || geo.kind === "none") {
          r.findings.push(FIND({ layer: "L3", rule: "ZREF", severity: "question", claim: `${pNet}/${nNet} runs ${f(L, 1)} mm on ${lay}, which has no reference plane`, net: pNet, key: `${pNet}:${lay}`, suggest: "move the pair to a layer next to a plane" }));
          continue;
        }
        const zDesign = I.zdiff(w, s_, geo);
        const mg = meas[lay]?.gap_mm;
        const mw = meas[lay]?.w_mm ?? w;
        const zRouted = mg && mg > 0 ? I.zdiff(mw, mg, geo) : null;
        rows.push([pNet, lay, pyRound(zDesign, 1), zRouted ? pyRound(zRouted, 1) : null]);
        if (tgt === null) continue;
        for (const [label, z] of [["as routed", zRouted], ["class geometry", zDesign]] as Array<[string, number | null]>) {
          if (z === null) continue;
          const dev = ((z - tgt) / tgt) * 100;
          let sev: Severity;
          if (Math.abs(dev) > tol + modelUnc) sev = "question";
          else if (Math.abs(dev) > tol) sev = "note";
          else continue;
          const geoJson = Object.fromEntries(Object.entries(geo).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1000) / 1000 : v]));
          r.findings.push(FIND({ layer: "L3", rule: "ZDIFF", severity: sev, claim: `${pNet}/${nNet} on ${lay} (${f(L, 1)} mm, ${geo.kind}): about ${f(z, 0)} ohm ${label} (w ${g(label === "as routed" ? mw : w)}, gap ${g(label === "as routed" ? (mg ?? 0) : s_)} mm) vs ${g(tgt)} ohm +/-${g(tol)} %` + (sev === "note" ? " — within the estimate uncertainty; confirm with a field solver" : ""), net: pNet, key: `${pNet}:${lay}:${label.split(" ")[0]}`, evidence: [{ source: `closed-form ${geo.kind} (IPC-2141A/Wadell), stack-up from the board file`, detail: pyDumps(geoJson) }], suggest: "set the class width/gap for this layer from the stack-up, or re-route the pair at class spacing" }));
          break; // report the as-routed figure when there is one
        }
      }
      const pv = vcount.get(pNet) ?? 0, nv = vcount.get(nNet) ?? 0;
      if (pv !== nv) r.findings.push(FIND({ layer: "L3", rule: "PAIRVIA", severity: "question", claim: `${pNet}/${nNet}: ${pv} vs ${nv} vias (P/N unbalanced: skew and mode conversion)`, net: pNet, key: `${pNet}:balance`, suggest: "give both nets the same layer changes" }));
      const mx = prof ? INTERFACE_PROFILES[prof]?.max_vias_per_net : undefined;
      if (mx && Math.max(pv, nv) > mx) r.findings.push(FIND({ layer: "L3", rule: "PAIRVIA", severity: "note", claim: `${pNet}/${nNet}: ${Math.max(pv, nv)} vias per net (profile ${prof}: <= ${mx})`, net: pNet, key: `${pNet}:count` }));
    }
  }
  ctx.impedanceRows = rows;
  r.detail = `${nPairs} pairs in ${Object.keys(classes).length} classes; ${rows.length} layer runs estimated; model uncertainty +/-${g(modelUnc)} %`;
  return r;
}

/** A net's working voltage: declared by the board (exact name or regex), else read from its name; 0 for ground; null when unknown. */
export function netVolts(net: string, declared: Record<string, number>): number | null {
  for (const [k, v] of Object.entries(declared)) if (k === net || ([..."^$*["].some((ch) => k.includes(ch)) && new RegExp(k).test(net))) return Number(v);
  if (P.isGndNet(net)) return 0.0;
  const m = /(?<![A-Z0-9.])\+?(\d{1,2})V(\d{1,2})?(?![0-9])/.exec(net.toUpperCase());
  return m ? Number(`${m[1]}.${m[2] || 0}`) : null;
}

function valueOhm(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)(?:Ω|R|ohm)?(\d*)/.exec(v || "");
  if (!m) return null;
  const mult: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, m: 1e-3, "": 1.0 };
  let x = Number(m[1]) * mult[m[2]!]!;
  if (m[3]) x += Number("0." + m[3]) * mult[m[2]!]!;
  return x;
}

export async function checkRatings(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("ratings", "L3");
  if (!ctx.comps) {
    r.status = "error";
    r.detail = "no netlist";
    return r;
  }
  const declared = ctx.project.cfg.net_voltages ?? {};
  const desc = new Map<string, string>();
  for (const rec of ctx.bom?.records ?? []) for (const ref of Array.isArray(rec.refs) ? rec.refs : []) desc.set(ref, (rec.checks?.description ?? "") + " " + (rec.value ?? ""));
  const pkgW: Array<[string, number]> = [["0201", 0.05], ["0402", 0.0625], ["0603", 0.1], ["0805", 0.125], ["1206", 0.25], ["1210", 0.5], ["2010", 0.75], ["2512", 1.0]];
  let nC = 0, nR = 0;
  for (const [ref, c] of ctx.comps) {
    const kind = (ref.split("_").pop() ?? "").replace(/\d.*$/, "");
    if ((kind !== "C" && kind !== "R") || c.pins.size !== 2) continue;
    const nets = [...c.pins.values()].map((v) => v.net);
    const vs = nets.map((n) => netVolts(n, declared));
    if (vs.includes(null)) continue;
    const [v0, v1] = vs as [number, number];
    const dv = Math.abs(v0 - v1);
    const text = (desc.get(ref) || "") + " " + c.value + " " + c.footprint;
    const hi = v0 >= v1 ? nets[0]! : nets[1]!;
    if (kind === "C" && dv > 0) {
      const m = /(\d+(?:\.\d+)?)\s*V(?![a-z])/.exec(text);
      if (!m) continue;
      nC++;
      const vr = Number(m[1]);
      const mlcc = /X5R|X7R|X6S|X7S|Y5V|C0G|NP0|Ceramic/i.test(text);
      const margin = mlcc && !/C0G|NP0/i.test(text) ? 1.5 : 1.25;
      if (vr < dv) r.findings.push(FIND({ layer: "L3", rule: "VRATING", severity: "question", claim: `${ref} (${c.value}) is rated ${g(vr)} V but sees ${g(dv)} V (${hi})`, ref, net: hi, evidence: [{ source: "LCSC description / value", detail: cut(text.trim(), 160) }], suggest: "use a part rated above the working voltage (bomcheck lists in-stock alternates)" }));
      else if (vr < margin * dv) r.findings.push(FIND({ layer: "L3", rule: "VRATING", severity: "note", claim: `${ref} (${c.value}) rated ${g(vr)} V at ${g(dv)} V: under the ${g(margin)}x derating` + (margin === 1.5 ? " (ceramic loses capacitance under DC bias)" : ""), ref, net: hi }));
    }
    if (kind === "R" && dv > 0) {
      const ohm = valueOhm(c.value);
      if (!ohm) continue;
      nR++;
      const m = /(\d+(?:\.\d+)?)\s*(mW|W)\b/.exec(text);
      const rating = m ? Number(m[1]) / (m[2] === "mW" ? 1000 : 1) : pkgW.find(([k]) => text.includes(k))?.[1];
      const p = (dv * dv) / ohm;
      if (rating && p > 0.5 * rating)
        r.findings.push(FIND({ layer: "L3", rule: "PRATING", severity: "question", claim: `${ref} (${c.value}) dissipates ${f(p * 1000, 0)} mW across ${g(dv)} V; rating ${f(rating * 1000, 0)} mW (${p > rating ? "over" : "above half"})`, ref, net: hi, suggest: "larger package or higher value, or record why the duty cycle keeps it cool" }));
    }
  }
  r.detail = `${nC} capacitors and ${nR} resistors between nets of known voltage` + (Object.keys(declared).length ? `; ${Object.keys(declared).length} declared voltages` : "");
  if (!(nC || nR)) r.status = "skipped";
  return r;
}

export async function checkManual(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("manual", "L3");
  const its = [...(((ctx.acceptance as { manual_review?: string[] } | null)?.manual_review) ?? []), ...(ctx.project.cfg.manual_review ?? [])];
  for (const it of its) {
    const k = createHash("sha1").update(it).digest("hex").slice(0, 8);
    r.findings.push(FIND({ layer: "L3", rule: "MANUAL", severity: "question", claim: `manual review: ${it}`, key: k, suggest: "dispose with the evidence (render, measurement, solver output) in the reason" }));
  }
  r.detail = `${its.length} manual items`;
  if (!its.length) r.status = "skipped";
  return r;
}

// ---------------------------------------------------------------- L4 mechanical

const CONN_REF = /(?:^|_)(J|USB|CN|P)\d+$/;

export async function checkMouth(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("mouth", "L4");
  const cfg = ctx.project.cfg.mouth ?? {};
  const edgeMm = cfg.edge_mm ?? 3.0, skip = new Set(cfg.skip ?? []), okInward = cfg.inward_ok ?? {};
  const ol = boardOutline(ctx.root);
  if (!ol) {
    r.status = "error";
    r.detail = "no Edge.Cuts outline";
    return r;
  }
  const [x0, y0, x1, y1] = ol;
  const raw = new Map<string, SNode>();
  for (const fp of kids(ctx.root, "footprint")) {
    const ref = kids(fp, "property").find((p) => p[1] === "Reference")?.[2];
    if (typeof ref === "string") raw.set(ref, fp);
  }
  let nChecked = 0;
  const names: Record<string, string> = { "-1,0": "left", "1,0": "right", "0,-1": "top", "0,1": "bottom" };
  for (const ref of [...raw.keys()].sort()) {
    if (!ref || !CONN_REF.test(ref) || skip.has(ref)) continue;
    const fp = raw.get(ref)!;
    const m = mouthOf(fp);
    if (!m) continue; // no signal pads / no courtyard: nothing to infer
    const { box, sig, point, normal: n } = m;
    const off = Math.hypot((box[0] + box[2]) / 2 - sig.reduce((a, q) => a + q[0], 0) / sig.length, (box[1] + box[3]) / 2 - sig.reduce((a, q) => a + q[1], 0) / sig.length);
    if (off < (cfg.min_offset_mm ?? 0.5)) continue; // body centred on its pins (header, vertical part): no mouth to infer
    const gaps: Array<[[number, number], number]> = [[[-1, 0], box[0] - x0], [[1, 0], x1 - box[2]], [[0, -1], box[1] - y0], [[0, 1], y1 - box[3]]];
    let [edge, gap] = gaps[0]!;
    for (const [e, gp] of gaps) if (gp < gap) [edge, gap] = [e, gp];
    if (gap > edgeMm) continue; // an interior connector: no edge to face
    nChecked++;
    const nm = names[`${edge[0]},${edge[1]}`]!;
    const dot = n[0] * edge[0] + n[1] * edge[1];
    const mouthGap = ({ "-1,0": point[0] - x0, "1,0": x1 - point[0], "0,-1": point[1] - y0, "0,1": y1 - point[1] } as Record<string, number>)[`${edge[0]},${edge[1]}`]!;
    if (dot <= 0 && !(ref in okInward))
      r.findings.push(FIND({ layer: "L4", rule: "MOUTH", severity: "must-fix", claim: (gap < 0 ? `${ref} overhangs the ${nm} edge by ${f(-gap, 1)} mm` : `${ref} sits ${f(gap, 1)} mm from the ${nm} edge`) + ` but its mouth faces ${names[`${Math.round(n[0])},${Math.round(n[1])}`] ?? tup(n)} (into the board): mating side and copper disagree`, ref, evidence: [{ source: "footprint courtyard vs contact pads (cablepath.mouth)", detail: `mouth ${tup(point.map((v) => Math.round(v * 100) / 100))} normal ${tup(n)}, edge ${nm}` }], suggest: "check the footprint against the vendor drawing/STEP (not a project-made model) and the placement rotation" }));
    else if (dot > 0 && mouthGap > edgeMm)
      r.findings.push(FIND({ layer: "L4", rule: "MOUTH", severity: "question", claim: `${ref} faces the ${nm} edge but its mouth is ${f(mouthGap, 1)} mm inside it`, ref, suggest: "move it to the edge, or record why the plug clears the board" }));
  }
  r.detail = `${nChecked} edge connectors checked (edge <= ${edgeMm} mm), outline ${f(x1 - x0, 1)} x ${f(y1 - y0, 1)} mm`;
  return r;
}

// ---------------------------------------------------------------- L5 interconnect

/** The interconnect release gate: a contract hook. A standalone project has none, so this is skipped unless a host provides one. */
export async function checkInterconnect(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("interconnect", "L5");
  const v = ctx.env.interconnect ? await ctx.env.interconnect(ctx) : null;
  if (!v) {
    r.status = "skipped";
    r.detail = "no interconnect gate (none for this project)";
    return r;
  }
  await writeFile(join(ctx.out, "interconnect.txt"), v.text);
  if (v.state !== "PASS") {
    for (const e of v.blocked)
      r.findings.push(FIND({ layer: "L5", rule: "GATE", severity: "must-fix", claim: `interconnect ${e.id} BLOCKED: ${cut(e.body, 260)}`, key: e.id, evidence: [{ source: "interconnect release gate", detail: cut(e.body, 1500) }], suggest: "resolve the contract entry; never bypass the gate" }));
    if (!r.findings.length) r.findings.push(FIND({ layer: "L5", rule: "GATE", severity: "must-fix", claim: `interconnect gate ${v.state}`, key: "gate" }));
  }
  r.detail = `gate ${v.state}`;
  return r;
}

// ---------------------------------------------------------------- L6 fab / assembly

export async function checkBom(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("bom", "L6");
  const d = ctx.env.bom ? await ctx.env.bom(ctx) : null;
  if (!d) {
    r.status = "skipped";
    r.detail = "no BOM decisions (the release stage's bomcheck writes them)";
    return r;
  }
  if (d.stale) {
    // decisions of another board are not evidence for this one: one must-fix, none of its lines trusted
    r.findings.push(FIND({ layer: "L6", rule: "BOM", severity: "must-fix", claim: `BOM decisions are stale: ${d.stale}; their lines were not checked`, key: "stale", suggest: "run board_release bom again on this board" }));
    r.detail = `BOM decisions stale: ${d.stale}`;
    return r;
  }
  ctx.bom = d;
  for (const rec of d.records) {
    const st = rec.status;
    if (st && ["RISK", "OWNER", "PROPOSED", "UNRESOLVED"].includes(st)) {
      const refs = Array.isArray(rec.refs) ? rec.refs : [];
      const suggest: Record<string, string> = { OWNER: "owner decision", UNRESOLVED: "give the part an LCSC identity (edit swap fields)", PROPOSED: "write the proposed part into the schematic fields" };
      r.findings.push(FIND({ layer: "L6", rule: "BOM", severity: st === "UNRESOLVED" ? "must-fix" : "question", claim: `${st} ${rec.line} ${rec.value ?? ""} (${refs.slice(0, 4).join(", ")}${refs.length > 4 ? "..." : ""}): ${rec.reason ?? st}`, ref: refs[0] ?? "", key: rec.line, evidence: [{ source: "bomcheck", detail: pyDumps(rec.risks ?? []) + " " + pyDumps(rec.owner ?? []), url: (rec.evidence ?? [""])[0] ?? "" }], suggest: suggest[st] ?? "check against the datasheet / JLC preview" }));
    }
  }
  const bare = (ref: string) => {
    const c = ctx.comps?.get(ref);
    if (!c) return false;
    const fl = Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k.toLowerCase(), (v || "").trim()]));
    return !lcsc(c) && !["mpn", "manufacturer part number", "mfr part", "part number"].some((k) => fl[k]);
  };
  const viaOrder = d.records.filter((rec) => rec.status !== "UNRESOLVED" && Array.isArray(rec.refs) && rec.refs.length && rec.refs.every(bare));
  if (viaOrder.length) {
    const refs = viaOrder.flatMap((rec) => rec.refs as string[]);
    r.findings.push(FIND({ layer: "L6", rule: "IDENTITY", severity: "question", claim: `${viaOrder.length} BOM line(s) (${refs.length} parts) take their part number from outside the design (agent overrides): the schematic alone does not say what gets built`, key: "ordering-file", evidence: [{ source: "bomcheck code_source", detail: refs.slice(0, 30).join(", ") }], suggest: "write LCSC/MPN fields into the schematic so identity travels with the design" }));
  }
  r.detail = `${d.lines} lines / ${d.placements} placements: ${pyDumps(d.summary)}`;
  return r;
}

/** A part the assembler places: not DNP/excluded, netted (or a connector/switch/IC), with pads. */
export function assembled(p: { ref: string; flags: string[]; pads: Array<{ net: string }> }): boolean {
  if (["dnp", "exclude_from_bom", "board_only"].some((x) => p.flags.includes(x))) return false;
  if (!p.pads.some((q) => q.net && !q.net.startsWith("unconnected-")) && !/^(J|SW|U|IC)/.test(p.ref.split("_").pop() ?? "")) return false;
  return p.pads.length > 0;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = rows.shift() ?? [];
  return rows.map((r_) => Object.fromEntries(head.map((h, i) => [h, r_[i] ?? ""])));
}

export async function checkCoverage(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("coverage", "L6");
  const cfg = ctx.project.cfg.assembly ?? {};
  const sides = new Set(cfg.sides ?? ["F", "B"]);
  const post = new Set(Object.keys(cfg.post_assembly ?? {}));
  const need: ReturnType<ReviewCtx["parts"]> = [];
  const unfitted: string[] = [];
  for (const p of ctx.parts()) {
    const netted = p.pads.some((q) => q.net && !q.net.startsWith("unconnected-"));
    if (assembled(p)) need.push(p);
    else if (netted && !/^(H|MH|FIT|TP|FID|MECH|LOGO|G)/.test(p.ref.split("_").pop() ?? "")) unfitted.push(p.ref);
  }
  const sorted = (xs: Iterable<string>) => [...xs].sort();
  for (const p of need.filter((p_) => !sides.has(p_.side) && !post.has(p_.ref)))
    r.findings.push(FIND({ layer: "L6", rule: "COVER", severity: "question", claim: `${p.ref} (${p.value}) is on ${p.side} but the order assembles only ${pyList(sorted(sides))} and it is not listed for hand assembly`, ref: p.ref, suggest: "add the side to the order, list it in assembly.post_assembly, or mark DNP" }));
  if (unfitted.length)
    r.findings.push(FIND({ layer: "L6", rule: "COVER", severity: "note", claim: `${unfitted.length} netted part(s) not fitted (DNP / excluded): ${sorted(unfitted).slice(0, 20).join(", ")}${unfitted.length > 20 ? "..." : ""}`, key: "unfitted" }));
  const cpl = cfg.cpl;
  if (cpl) {
    const rows = parseCsv(await readFile(cpl, "utf8"));
    const key = rows.length ? Object.keys(rows[0]!).find((k) => ["designator", "ref", "reference"].includes(k.toLowerCase())) : undefined;
    const have = new Set(key ? rows.map((row) => row[key]!) : []);
    const want = new Set(need.filter((p) => sides.has(p.side) && !post.has(p.ref)).map((p) => p.ref));
    for (const ref of sorted(want)) if (!have.has(ref)) r.findings.push(FIND({ layer: "L6", rule: "CPL", severity: "must-fix", claim: `${ref} must be assembled but is missing from ${basename(cpl)}`, ref }));
    for (const ref of sorted(have)) if (!want.has(ref)) r.findings.push(FIND({ layer: "L6", rule: "CPL", severity: "question", claim: `${ref} is in ${basename(cpl)} but not an assembled part on the board`, ref }));
  }
  r.detail = `${need.length} assembled parts, sides ${pyList(sorted(sides))}, ${post.size} hand-assembly, ${unfitted.length} unfitted`;
  return r;
}

// ---------------------------------------------------------------- custom checks (data)

/** Shells a custom check can ask for; without one it runs in the platform shell. */
export const CUSTOM_SHELLS = ["sh", "bash", "cmd", "powershell", "pwsh"] as const;
export type CustomShell = (typeof CUSTOM_SHELLS)[number];

/**
 * How a custom check's command line is started: the declared `shell`, else the platform shell (`/bin/sh -c` on Linux
 * and macOS, `cmd.exe /d /s /c` on Windows). `verbatim` is for cmd.exe: the command goes in one quoted argument that
 * Windows must not re-escape (what Node does for `shell: true`). An unknown shell name is an error string.
 */
export function customCheckArgv(cmd: string, shell: string | undefined, platform: NodeJS.Platform = process.platform): { argv: string[]; verbatim: boolean } | string {
  const win = platform === "win32";
  const sh = shell?.trim().toLowerCase() || (win ? "cmd" : "sh");
  switch (sh) {
    case "sh":
      return { argv: [win ? "sh" : "/bin/sh", "-c", cmd], verbatim: false };
    case "bash":
      return { argv: ["bash", "-c", cmd], verbatim: false };
    case "cmd":
      return win ? { argv: [process.env["ComSpec"] || "cmd.exe", "/d", "/s", "/c", `"${cmd}"`], verbatim: true } : `shell "cmd" runs only on Windows`;
    case "powershell":
    case "pwsh":
      return { argv: [sh === "powershell" && win ? "powershell.exe" : "pwsh", "-NoProfile", "-NonInteractive", "-Command", cmd], verbatim: false };
    default:
      return `unknown shell "${shell}" (one of ${CUSTOM_SHELLS.join(", ")})`;
  }
}

/**
 * One substituted value quoted for the shell that runs the command, so a space, `$()`, `;` or a quote in a path is
 * data, never shell syntax: POSIX single quotes for sh/bash, PowerShell single quotes (quote characters doubled),
 * double quotes for cmd.exe, which cannot quote `"`, `%` or `!` safely (null: refuse).
 */
export function quoteForShell(v: string, sh: CustomShell): string | null {
  switch (sh) {
    case "sh":
    case "bash":
      return `'${v.replace(/'/g, `'\\''`)}'`;
    case "powershell":
    case "pwsh":
      return `'${v.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
    case "cmd":
      return /["%!\r\n]/.test(v) ? null : `"${v}"`;
  }
}

/**
 * The command line of a custom check with `{pcb}`, `{project}` ... replaced by quoted values. A placeholder the owner
 * already wrapped in quotes (`"{pcb}"`, `'{pcb}'`) loses those quotes for ours. An error string when a value cannot be
 * quoted for the shell.
 */
export function customCommand(template: string, subs: Record<string, string>, shell: string | undefined, platform: NodeJS.Platform = process.platform): string | { error: string } {
  const sh = (shell?.trim().toLowerCase() || (platform === "win32" ? "cmd" : "sh")) as CustomShell;
  if (!(CUSTOM_SHELLS as readonly string[]).includes(sh)) return template; // customCheckArgv reports the unknown shell
  let bad: string | null = null;
  const cmd = template.replace(/(["']?)\{(pcb|sch|project|netlist|spec|out)\}\1/g, (_m, _q: string, k: string) => {
    const q = quoteForShell(subs[k] ?? "", sh);
    if (q === null) {
      bad ??= `{${k}} (${subs[k]}) has characters ${sh} cannot quote safely`;
      return "";
    }
    return q;
  });
  return bad ? { error: bad } : cmd;
}

/**
 * Checks added as data: `.fabdesk/board/review/checks.d/*.json` (all boards, optional "boards" filter) and `review.custom`
 * in the project's review config. Each: {"name", "layer", "run": "cmd with {pcb} {sch} {project} {netlist} {spec} {out}",
 * "timeout", "shell"?}. `run` goes to the platform shell (`/bin/sh` on Linux and macOS, `cmd.exe` on Windows) unless
 * "shell" names one ("sh", "bash", "cmd", "powershell", "pwsh"). The command prints a JSON list of findings: {"rule",
 * "severity", "claim", "ref"?, "pad"?, "net"?, "key"?, "suggest"?}. A command that fails or prints something else is an error, never a pass. The commands are the project
 * owner's own and run only when the caller trusts them (`trustCustom`).
 */
export async function checkCustom(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("custom", "L*");
  const dir = join(reviewHome(ctx.project.dir), "checks.d");
  const specs: Array<{ name: string; layer?: string; run: string; timeout?: number; shell?: string; _src: string }> = [];
  for (const n of (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith(".json")).sort()) {
    const d = await readJson<{ name: string; layer?: string; boards?: string[]; run: string; timeout?: number; shell?: string }>(join(dir, n));
    if (d && (!d.boards?.length || d.boards.includes(ctx.project.name))) specs.push({ ...d, _src: n });
  }
  for (const d of ctx.project.cfg.custom ?? []) specs.push({ ...d, _src: "board entry" });
  if (!specs.length) {
    r.status = "skipped";
    r.detail = "no custom checks";
    return r;
  }
  if (!ctx.env.trustCustom) {
    r.status = "skipped";
    r.detail = `${specs.length} owner check(s) not run (trustCustom off): they execute shell commands from the project's data files; pass trustCustom to run them`;
    r.artifacts = { not_run: specs.length };
    return r;
  }
  const subs: Record<string, string> = { pcb: ctx.project.pcb, sch: ctx.project.sch, project: ctx.project.dir, netlist: join(ctx.out, "netlist.xml"), spec: "", out: ctx.out };
  const errs: string[] = [];
  let n = 0;
  for (const sp of specs) {
    const cmd = customCommand(sp.run, subs, sp.shell);
    if (typeof cmd !== "string") {
      errs.push(`${sp.name}: ${cmd.error}`);
      continue;
    }
    const how = customCheckArgv(cmd, sp.shell);
    if (typeof how === "string") {
      errs.push(`${sp.name}: ${how}`);
      continue;
    }
    const p = await spawn(how.argv, ctx.project.dir, Number(sp.timeout ?? 600) * 1000, how.verbatim);
    let list: Array<Record<string, unknown>>;
    try {
      list = JSON.parse(p.out || "null");
      if (!Array.isArray(list)) throw new Error("not a list");
    } catch {
      errs.push(`${sp.name}: rc ${p.code}, output not a JSON list: ${(p.out + p.err).slice(-200)}`);
      continue;
    }
    for (const x of list) {
      n++;
      const sev = (SEVERITIES as readonly string[]).includes(String(x["severity"])) ? (x["severity"] as Severity) : "question";
      r.findings.push(FIND({ layer: sp.layer ?? "L2", rule: String(x["rule"] ?? sp.name), severity: sev, claim: cut(String(x["claim"] ?? ""), 300), ref: String(x["ref"] ?? ""), pad: String(x["pad"] ?? ""), net: String(x["net"] ?? ""), key: String(x["key"] || (!x["ref"] ? sp.name : "")), evidence: [{ source: `custom check ${sp.name} (${sp._src})`, detail: String(x["evidence"] ?? "") }], suggest: String(x["suggest"] ?? "") }));
    }
  }
  if (errs.length) r.status = "error";
  r.detail = `${specs.length} custom checks, ${n} findings` + (errs.length ? `; errors: ${errs.join("; ")}` : "");
  return r;
}

// ---------------------------------------------------------------- L8 expert pack

const EXPERT_BRIEF = (o: { name: string; hash: string; project: string; nparts: number; nnets: number; manual: string }) => `# Expert review brief: ${o.name}

You are an independent senior PCB/electronics reviewer. You did not design this board. Review the evidence in this
folder like a design review before ordering. Look for what the tools cannot see: wrong part choices, missing
protection or support parts, power sequencing, return paths, connector or cable problems, thermal, bring-up blind
spots, and anything in the renders that looks wrong (a connector mouth facing inward, parts off the board, tall parts
on the low side).

Rules:
- Change nothing. Write findings only.
- Do not repeat the tool findings in \`findings.json\` unless you have new evidence about them.
- Every finding names a ref (and pin or net if it applies) and its evidence: datasheet page or section, a
  measurement from the files, or a render. A PROBLEM without evidence counts as a QUESTION.
- At most 12 findings, most important first. Say "no problems" if that is your conclusion.

Write \`expert.json\` as:
\`\`\`json
{"reviewer": "<model/session>", "findings": [
  {"severity": "PROBLEM|QUESTION|NOTE", "ref": "U5", "pad": "", "net": "", "claim": "one line",
    "evidence": "datasheet section / measurement / render file", "suggest": "what would fix or settle it"}]}
\`\`\`
Then the agent imports it: \`board_review {"action": "import_expert", "file": "expert.json"}\`.

## Board
- design hash: \`${o.hash}\`
- project: \`${o.project}\`
- parts: ${o.nparts}; nets: ${o.nnets}
- files here: \`renders/*.png\`, \`findings.json\` (tool findings so far), \`parts.json\` (ref, value, LCSC, datasheet,
  pins/nets), \`netlist.xml\`, \`acceptance.json\` / \`drc.json\` / \`erc.json\` if present, \`requirements/\` (copied).
${o.manual}
`;

/** Evidence pack for an independent (fresh-context) reviewer: renders, parts with datasheets, tool findings. Starting that reviewer is the owner's call. */
export async function checkPack(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("pack", "L8");
  const pack = join(ctx.out, "pack");
  await mkdir(join(pack, "renders"), { recursive: true });
  const views: Record<string, string[]> = { top: ["--side", "top"], bottom: ["--side", "bottom"], iso: ["--side", "top", "--rotate", "-45,0,45", "--perspective"] };
  const rendered: string[] = [];
  for (const [name, args] of Object.entries(views)) {
    const png = join(pack, "renders", `${name}.png`);
    await ctx.env.kicad(["pcb", "render", "-o", png, "--width", "1800", "--height", "1200", "--quality", "basic", ...args, ctx.project.pcb]);
    if (await exists(png)) rendered.push(name);
  }
  const ds = new Map<string, string | undefined>();
  for (const rec of ctx.bom?.records ?? []) for (const ref of Array.isArray(rec.refs) ? rec.refs : []) ds.set(ref, rec.checks?.datasheet);
  const parts = [...(ctx.comps ?? [])]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ref, c]) => ({ ref, value: c.value, lcsc: lcsc(c), datasheet: ds.get(ref) || c.fields["Datasheet"], pins: Object.fromEntries([...c.pins].map(([p, v]) => [p, [v.name, v.net]])) }));
  await writeFile(join(pack, "parts.json"), JSON.stringify(parts, null, 0));
  await writeFile(join(pack, "findings.json"), JSON.stringify(ctx.findingsSoFar().map((x) => ({ ...x, id: findingId(x) })), null, 1));
  for (const name of ["netlist.xml", "drc.json", "erc.json", "acceptance.json"]) if (await exists(join(ctx.out, name))) await copyFile(join(ctx.out, name), join(pack, name));
  const reqDir = join(ctx.project.dir, ".fabdesk", "board", "requirements");
  if (await exists(reqDir)) {
    await mkdir(join(pack, "requirements"), { recursive: true });
    for (const n of await readdir(reqDir)) await copyFile(join(reqDir, n), join(pack, "requirements", n)).catch(() => {});
  }
  const manual = ((ctx.acceptance as { manual_review?: string[] } | null)?.manual_review) ?? [];
  const nets = new Set([...(ctx.comps ?? new Map<string, Comp>()).values()].flatMap((c) => [...c.pins.values()].map((v) => v.net)));
  await writeFile(join(pack, "EXPERT-BRIEF.md"), EXPERT_BRIEF({ name: ctx.project.name, hash: ctx.hash, project: ctx.project.dir, nparts: parts.length, nnets: nets.size, manual: manual.length ? "\n## Manual review items the owner tracks\n" + manual.map((m) => `- ${m}`).join("\n") : "" }));
  r.findings.push(FIND({ layer: "L8", rule: "EXPERT", severity: "question", claim: "independent expert review not imported yet", key: "pending", suggest: `have a fresh-context reviewer (the owner's call) work from ${pack}/EXPERT-BRIEF.md, then board_review import_expert` }));
  r.artifacts["pack"] = pack;
  r.detail = `renders ${pyList(rendered)}, ${parts.length} parts, ${[...ds.values()].filter(Boolean).length} datasheets`;
  if (rendered.length < Object.keys(views).length) {
    r.status = "error";
    r.detail += " (render failed)";
  }
  return r;
}

export const REGISTRY: Array<[string, (ctx: ReviewCtx) => Promise<CheckResult>]> = [
  ["identity", checkIdentity],
  ["netlist", checkNetlist],
  ["erc", checkErc],
  ["drc", checkDrc],
  ["acceptance", checkAcceptanceLayer],
  ["pinsense", checkPinsense],
  ["cards", checkCards],
  ["decoupling", checkDecoupling],
  ["current", checkCurrent],
  ["impedance", checkImpedance],
  ["manual", checkManual],
  ["mouth", checkMouth],
  ["interconnect", checkInterconnect],
  ["bom", checkBom],
  ["ratings", checkRatings],
  ["coverage", checkCoverage],
  ["evidence", checkEvidence],
  ["custom", checkCustom],
  ["pack", checkPack],
];


/**
 * bomcheck: every BOM line to a manufacturable part, with evidence; JLC placement rotation predicted per part.
 *
 * For each assembled footprint: identity (LCSC code from the footprint, else MPN -> JLC parts search), live LCSC / JLC
 * data, JLC's own footprint against ours by pad number (rotation, residual, origin offset), the 3D model and the height.
 * Each line gets a decision record {choice, evidence, reason, risk, status}: RESOLVED, RISK (buildable with a named
 * risk), OWNER (needs an owner decision), PROPOSED, UNRESOLVED. No purchases, no messages: read-only public lookups.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { pyRound } from "../accept";
import { parseSexpr } from "../sexpr";
import { parseCsv, toCsv } from "./csv";
import { align, alignGeometry, polarRenumber, type Alignment } from "./footprint-fit";
import { Fetch, LCSC_URL, edaPads, edaPinNames, jlcSearch, type FetchOptions, type JsonObj } from "./lookup";
import { assembled, boardParts, copperOnlyShape, LCSC_FIELDS, type BomPart } from "./parts";

export const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const CODE_KEYS: readonly string[] = LCSC_FIELDS;

export interface Override {
  lcsc: string;
  mpn?: string | undefined;
  reason?: string | undefined;
}

export interface BomRecord {
  line: string;
  refs: string[];
  qty_per_board: number;
  value: string | null;
  mpn_board: string | null;
  checks: Record<string, any>;
  evidence: string[];
  risks: string[];
  owner: string[];
  status?: string;
  lcsc?: string | null;
  code_source?: string | null;
  choice?: string;
  reason?: string;
  notes?: string[];
  copper_only?: boolean;
  proposal?: { lcsc: string; mpn: string | null; like: string; package: string | null; why: string };
}

export interface CplRow {
  ref: string;
  side: "F" | "B";
  kicad_rot: number;
  jlc_offset: number;
  jlc_rot: number;
  origin_offset_mm: [number, number];
  rms_mm: number;
  lcsc: string;
}

export interface BomOptions {
  /** Project folder holding `<stem>.kicad_pcb` and the schematic sheets. */
  project: string;
  stem: string;
  /** Output folder (bom-decisions.json/csv, swap-fields.json, cpl-jlc.csv, cache/). */
  out: string;
  ordering?: string;
  boards?: number;
  fMax?: number;
  bMax?: number;
  heights?: string;
  offline?: boolean;
  overrides?: Record<string, Override>;
  /** An existing placement CSV (Ref,Val,Package,PosX,PosY,Rot,Side) to compare with the JLC prediction. */
  cpl?: string;
  fetch?: FetchOptions;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, what: string) => void;
}

export interface BomResult {
  project: string;
  stem: string;
  boards: number;
  lines: number;
  placements: number;
  summary: Record<string, number>;
  fetch_calls: number;
  records: BomRecord[];
  rotation_offsets: number;
  bottom_side_placements: number;
  cpl_compare?: { file: string; compared: number; mismatch: Array<Record<string, unknown>> };
  /** Not part of bom-decisions.json: the CPL prediction rows and counters. */
  cplRows: CplRow[];
  reused: number;
}

export function lcscCode(p: Pick<BomPart, "ref" | "props" | "value">, ordering: Record<string, Record<string, string>>, overrides: Record<string, Override>): { code: string | null; source: string | null } {
  const ov = overrides[p.ref];
  const written = new Set(CODE_KEYS.map((k) => (p.props[k] ?? "").trim()));
  if (ov && !written.has(ov.lcsc)) return { code: ov.lcsc, source: `agent decision (not yet in the schematic): ${ov.reason ?? ""}` };
  for (const k of CODE_KEYS) {
    const v = (p.props[k] ?? "").trim();
    if (/^C\d{3,}$/.test(v)) return { code: v, source: `footprint property ${k}` };
  }
  const m = /\b(C\d{4,})\b/.exec(p.value ?? "");
  if (m) return { code: m[1]!, source: "code in the value field" };
  const v = (ordering[p.ref]?.["LCSC"] ?? "").trim();
  if (/^C\d{3,}$/.test(v)) return { code: v, source: "ordering list" };
  return { code: null, source: null };
}

export function mpnOf(p: Pick<BomPart, "ref" | "props">, ordering: Record<string, Record<string, string>>): string | null {
  const o = ordering[p.ref] ?? {};
  for (const v of [o["AssemblyMPN"], o["MPN"], p.props["MPN"], p.props["Manufacturer_Part_Number"], p.props["MPN_ID"]]) if (v && v.trim()) return v.trim();
  return null;
}

/** Our schematic symbol for REF: pad number -> upper-cased pin name (lib_symbols cache of the sheet that holds it). */
export function boardPinNames(sheets: string[], ref: string): Record<string, string> {
  for (const t of sheets) {
    const i = t.indexOf(`(property "Reference" "${ref}"`);
    if (i < 0) continue;
    const s = t.lastIndexOf('(lib_id "', i);
    const libId = t.slice(s + 9, t.indexOf('"', s + 9));
    const j = t.indexOf(`(symbol "${libId}"`, t.indexOf("(lib_symbols"));
    if (j < 0) return {};
    const indent = t.slice(t.lastIndexOf("\n", j) + 1, j); // the next lib symbol at the same depth ends this one
    const k = t.indexOf("\n" + indent + '(symbol "', j + 10);
    const blk = t.slice(j, k > 0 ? k : j + 20000);
    const out: Record<string, string> = {};
    for (const m of blk.matchAll(/\(name "([^"]*)"[\s\S]*?\(number "([^"]*)"/g)) out[m[2]!] = m[1]!.trim().toUpperCase();
    return out;
  }
  return {};
}

const KICAD_MODEL_ROOTS = ["/usr/share/kicad-nightly/3dmodels", "/usr/share/kicad/3dmodels"];

function extraModelRoots(): string[] {
  const out = ["/usr/share/kicad/3dmodels"];
  try {
    const bend = join(homedir(), ".backplane-bend", "kicad");
    for (const v of readdirSync(bend).sort()) out.push(join(bend, v, "share", "kicad", "3dmodels"));
  } catch {
    /* none */
  }
  return out;
}

export function modelPath(m: string, project: string): string | null {
  const sub = (name: string): string => process.env[name] || (/^KICAD\d+_3DMODEL_DIR$/.test(name) ? KICAD_MODEL_ROOTS.find((d) => existsSync(d)) : undefined) || `\${${name}}`;
  let p = m.replace(/\$\{(\w+)\}/g, (_x, name: string) => (name === "KIPRJMOD" ? project : sub(name)));
  if (!isAbsolute(p)) p = join(project, p);
  const cands = [p];
  const m2 = /^\$\{KICAD\d+_3DMODEL_DIR\}\/(.*)/.exec(m);
  if (m2) for (const r of extraModelRoots()) cands.push(join(r, m2[1]!));
  for (const c0 of cands) {
    const stem = c0.replace(/\.[^./]*$/, "");
    for (const cand of [c0, stem + ".step", stem + ".stp", stem + ".wrl"]) if (existsSync(cand)) return cand;
  }
  return null;
}

export async function stepHeight(path: string): Promise<number | null> {
  let t: string;
  try {
    t = await readFile(path, "latin1");
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const m of t.matchAll(/CARTESIAN_POINT\(\s*'[^']*'\s*,\s*\(\s*[-\d.Ee+]+\s*,\s*[-\d.Ee+]+\s*,\s*([-\d.Ee+]+)\s*\)/g)) {
    const z = Number(m[1]);
    if (Number.isFinite(z) && (max === null || z > max)) max = z;
  }
  return max === null ? null : pyRound(max, 3);
}

const mod360 = (r: number) => ((r % 360) + 360) % 360;

const vkey = (v: string | null) => {
  const m = /^\s*([\d.]+\s*[pnuµmkKMR]?[FHΩ]?)/.exec((v ?? "").replace(/Ω/g, ""));
  return m ? m[1]!.replace(/ /g, "").toLowerCase() : (v ?? "").toLowerCase();
};

export async function bomCheck(o: BomOptions): Promise<BomResult> {
  const boards = o.boards ?? 5;
  await mkdir(o.out, { recursive: true });
  const fx = new Fetch(join(o.out, "cache"), { ...(o.offline ? { offline: true } : {}), ...(o.signal ? { signal: o.signal } : {}), ...o.fetch });
  const ordering: Record<string, Record<string, string>> = {};
  if (o.ordering) for (const row of parseCsv(await readFile(o.ordering, "utf8"))) ordering[row["Reference"] || row["Ref"] || ""] = row;
  const overrides = o.overrides ?? {};
  const screens: Record<string, number | null> = {};
  if (o.heights) for (const e of (JSON.parse(await readFile(o.heights, "utf8")) as { entries: JsonObj[] }).entries) screens[e["ref"]] = e["height_above_surface_mm"] ?? null;
  const sheets: string[] = [];
  for (const n of readdirSync(o.project).filter((x) => x.endsWith(".kicad_sch")).sort()) sheets.push(await readFile(join(o.project, n), "utf8"));
  const parts = boardParts(parseSexpr(await readFile(join(o.project, `${o.stem}.kicad_pcb`), "utf8"))).filter(assembled);

  type Line = { refs: string[]; code: string | null; code_source: string | null; mpn: string | null; value: string | null; parts: BomPart[] };
  const lines = new Map<string, Line>();
  for (const p of [...parts].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    const { code, source } = lcscCode(p, ordering, overrides);
    const mpn = mpnOf(p, ordering);
    const key = code ?? (mpn ? `MPN:${norm(mpn)}` : `VAL:${p.value}|${p.lib}`);
    let L = lines.get(key);
    if (!L) lines.set(key, (L = { refs: [], code, code_source: source, mpn, value: p.value, parts: [] }));
    L.refs.push(p.ref);
    L.parts.push(p);
  }
  const recs: BomRecord[] = [];
  const cplRows: CplRow[] = [];
  let done = 0;
  for (const [key, L] of lines) {
    if (o.signal?.aborted) throw new Error("cancelled");
    o.onProgress?.(done++, lines.size, key);
    const qty = L.refs.length;
    const need = Math.ceil(qty * boards * 1.1) + 2;
    const rec: BomRecord = { line: key, refs: L.refs, qty_per_board: qty, value: L.value, mpn_board: L.mpn, checks: {}, evidence: [], risks: [], owner: [] };
    let code = L.code;
    if (!code && L.mpn) {
      const { hits, raw } = await jlcSearch(fx, L.mpn);
      const exact = hits.filter((h) => norm(h["componentModelEn"]) === norm(L.mpn));
      exact.sort((a, b) => Number(a["componentBrandEn"] === "JLCPCB Assembly") - Number(b["componentBrandEn"] === "JLCPCB Assembly") || (b["stockCount"] || 0) - (a["stockCount"] || 0));
      if (exact.length) {
        code = exact[0]!["componentCode"];
        rec.code_source = `JLC parts search for MPN ${L.mpn}`;
        rec.evidence.push(`${raw?.url} (POST keyword ${L.mpn})`);
      }
    } else rec.code_source = L.code_source;
    rec.lcsc = code;
    const p0 = L.parts[0]!;
    if (!code && !L.mpn && copperOnlyShape(p0)) {
      rec.status = "RESOLVED";
      rec.choice = "copper only (test pad / solder jumper): nothing to buy or place";
      rec.reason = `${p0.pads.length} SMD pad(s), no 3D model, no part number; exclude from BOM/CPL`;
      rec.copper_only = true;
      recs.push(rec);
      continue;
    }
    if (!code) {
      rec.status = "UNRESOLVED";
      rec.reason = L.mpn ? "no LCSC code on the footprint and no exact JLC match for the MPN" : "no LCSC code and no MPN";
      recs.push(rec);
      continue;
    }
    const det = await fx.get(`lcsc-${code}`, LCSC_URL(code));
    const d = (((det?.body as JsonObj | null)?.result as JsonObj | undefined) ?? {}) as JsonObj;
    const hasD = Object.keys(d).length > 0;
    rec.evidence.push(`https://www.lcsc.com/product-detail/${code}.html`);
    if (!hasD) rec.risks.push("LCSC detail unavailable");
    const mpnL: string | undefined = d["productModel"];
    rec.checks["mpn"] = { lcsc: mpnL ?? null, brand: d["brandNameEn"] ?? null, board: L.mpn, match: L.mpn && mpnL ? norm(mpnL) === norm(L.mpn) : null };
    if (L.mpn && mpnL && norm(mpnL) !== norm(L.mpn) && !norm(mpnL).startsWith(norm(L.mpn).slice(0, 8))) rec.risks.push(`board MPN ${L.mpn} != LCSC ${mpnL}`);
    rec.checks["package"] = d["encapStandard"] ?? null;
    rec.checks["description"] = d["productDescEn"] || d["productNameEn"] || null;
    rec.checks["lifecycle"] = d["productCycle"] ?? null;
    if (hasD && d["productCycle"] !== "normal" && d["productCycle"] !== null && d["productCycle"] !== undefined) rec.owner.push(`lifecycle ${d["productCycle"]}`);
    rec.checks["jlc_class"] = d["smtLabel"] ?? null;
    rec.checks["datasheet"] = d["pdfUrl"] ?? null;
    const { hits } = await jlcSearch(fx, code);
    const jh = hits.find((h) => h["componentCode"] === code);
    rec.checks["stock"] = { lcsc: d["stockNumber"] ?? null, jlc: jh ? (jh["stockCount"] ?? null) : null, jlc_library: jh ? (jh["componentLibraryType"] ?? null) : null, need_for_boards: need };
    let stock: number | null | undefined = jh?.["stockCount"];
    if (stock === null || stock === undefined) stock = d["stockNumber"];
    rec.checks["stock"].boards_covered = stock !== null && stock !== undefined && qty ? Math.floor(stock / qty) : null;
    if (stock === null || stock === undefined || stock < need) rec.owner.push(`stock ${stock ?? "None"} < ${need} for ${boards} boards: choose an alternate or consign`);
    rec.checks["alternates"] = ((d["alternatePartList"] as JsonObj[] | undefined) ?? []).slice(0, 6).map((al) => ({ code: al["productCode"] ?? null, mpn: al["productModel"] ?? null, stock: al["stockNumber"] ?? null }));
    // footprint against JLC's footprint
    const eda = await edaPads(fx, code);
    if (eda.pads && eda.pads.length) {
      const rn = polarRenumber(eda.pads, edaPinNames(eda.raw), boardPinNames(sheets, p0.ref));
      const ep = rn.pads;
      if (rn.renumbered) (rec.notes ??= []).push("JLC pad numbers mean the opposite pins (its symbol A/K vs ours): rotation matched by polarity, not pad number");
      let al: Alignment | null = align(p0.pads, ep);
      if (al === null || al.rms_mm > 0.3) {
        // numbering differs (land-size differences stay < 0.3 mm): fit by position
        const g = alignGeometry(p0.pads, ep);
        if (g) {
          g.number_fit = al ? { rotation: al.rotation, rms_mm: al.rms_mm } : null;
          (rec.notes ??= []).push(`pad numbers differ from JLC's footprint (number fit rms ${al ? al.rms_mm : "None"} mm): rotation by pad position, pin 1 onto JLC pin 1: ${g.pin1_to_pin1 ? "True" : "False"}`);
          al = g;
        }
      }
      rec.checks["footprint"] = { ...(al ?? {}), jlc_footprint: eda.title, kicad_footprint: p0.lib };
      rec.evidence.push(eda.raw!.url);
      if (!al) rec.risks.push("no pad numbers in common with the JLC footprint: check the land pattern against the datasheet");
      else {
        if (al.rms_mm > 0.15 || al.unmatched_kicad.length || al.unmatched_jlc.length)
          rec.risks.push(`pads differ from JLC's footprint (rms ${al.rms_mm} mm, unmatched ${pyList(al.unmatched_kicad)}/${pyList(al.unmatched_jlc)}): datasheet check`);
        for (const pp of L.parts)
          cplRows.push({
            ref: pp.ref,
            side: pp.side,
            kicad_rot: pp.rot,
            jlc_offset: al.rotation,
            // JLC footprint E = R(r) K (align), placed KiCad pads R(rot) K = R(rot - r) E. Bottom: JLC sees the part from
            // below (kicad-jlcpcb-tools: 180 - angle), so 180 - rot - r; checked part by part by jlcsim against the copper.
            jlc_rot: mod360(pp.side === "F" ? pp.rot - al.rotation : 180 - pp.rot - al.rotation),
            origin_offset_mm: al.origin_offset_mm,
            rms_mm: al.rms_mm,
            lcsc: code,
          });
      }
    } else rec.risks.push("JLC footprint data unavailable: rotation not predicted");
    // model and height
    const mp = p0.models.map((m) => modelPath(m, o.project));
    rec.checks["model"] = { referenced: p0.models.slice(0, 2), present: mp.map((m) => m ?? null).slice(0, 2) };
    rec.notes ??= [];
    if (!p0.models.length) rec.notes.push("no 3D model referenced");
    else if (!mp.some(Boolean)) rec.notes.push("3D model file not installed on this machine");
    let h: number | null | undefined = screens[p0.ref];
    let hsrc = "height screen";
    if (h === null || h === undefined) {
      let hm: number | null = null;
      for (const m of mp) if (m && /\.(step|stp)$/i.test(m)) { hm = await stepHeight(m); break; }
      h = hm;
      hsrc = "STEP Z extent (approximate)";
    }
    const lim = p0.side === "F" ? o.fMax : o.bMax;
    rec.checks["height"] = { mm: h ?? null, source: hsrc, side: p0.side, limit: lim ?? null };
    if ((h === null || h === undefined) && lim !== undefined) rec.risks.push("height not verified (no height screen and no 3D model)");
    if (h !== null && h !== undefined && lim !== undefined && h > lim + 1e-6) rec.owner.push(`height ${h} mm > ${p0.side} limit ${lim}`);
    rec.status = rec.owner.length ? "OWNER" : rec.risks.length ? "RISK" : "RESOLVED";
    if (String(rec.code_source ?? "").startsWith("agent decision") && rec.status !== "OWNER") rec.status = "PROPOSED"; // becomes RESOLVED once written into the schematic
    rec.choice = `${code} ${mpnL ?? L.mpn} (${d["brandNameEn"]}, ${d["encapStandard"]}, JLC ${rec.checks["stock"].jlc_library || d["smtLabel"]})`;
    rec.reason = [...rec.owner, ...rec.risks].join("; ") || "identity, stock, lifecycle, JLC footprint, model and height checked";
    recs.push(rec);
  }
  // proposals for lines without identity: a resolved line on this board with the same value and package
  const pkg = (r: BomRecord): string | null => {
    const p_ = parts.find((pp) => pp.ref === r.refs[0]);
    if (!p_) return null;
    const m = /(0201|0402|0603|0805|1206|1210|2512)/.exec(`${p_.props["AssemblyPackage"] ?? ""} ${p_.lib} ${p_.models.join(" ")}`);
    return m ? m[1]! : null;
  };
  const doneRecs = recs.filter((r) => (r.status === "RESOLVED" || r.status === "RISK") && r.lcsc);
  const prefix = (r: BomRecord) => r.refs[0]!.split("_").pop()![0];
  for (const r of recs) {
    if (r.status !== "UNRESOLVED") continue;
    const tol = /(\d+(?:\.\d+)?)\s*%/.exec(r.value ?? "");
    const tolOk = (dd: BomRecord) => {
      if (!tol) return true;
      const m = /±\s*(\d+(?:\.\d+)?)\s*%/.exec(dd.checks["description"] ?? "");
      return !!m && Number(m[1]) <= Number(tol[1]);
    };
    const sib = doneRecs.filter((dd) => vkey(dd.value) === vkey(r.value) && pkg(dd) && pkg(dd) === pkg(r) && prefix(dd) === prefix(r) && tolOk(dd));
    if (sib.length) {
      let s = sib[0]!;
      const sc = (x: BomRecord) => [Number(x.checks["jlc_class"] === "BASE"), x.checks["stock"]?.jlc || 0] as const;
      for (const x of sib.slice(1)) if (sc(x)[0] > sc(s)[0] || (sc(x)[0] === sc(s)[0] && sc(x)[1] > sc(s)[1])) s = x;
      r.proposal = {
        lcsc: s.lcsc!,
        mpn: s.checks["mpn"].lcsc,
        like: s.refs[0]!,
        package: pkg(r),
        why: `same value (${r.value}) and package (${pkg(r)}) as ${s.refs[0]}; check voltage/dielectric rating against the net`,
      };
      r.status = "PROPOSED";
      r.reason += `; proposed ${s.lcsc} (${s.checks["mpn"].lcsc}) like ${s.refs[0]}: write LCSC/MPN into the schematic (edit swap fields)`;
    }
  }
  const summary: Record<string, number> = {};
  for (const r of recs) summary[r.status!] = (summary[r.status!] ?? 0) + 1;
  const result: BomResult = {
    project: o.project,
    stem: o.stem,
    boards,
    lines: recs.length,
    placements: parts.length,
    summary,
    fetch_calls: fx.calls,
    records: recs,
    rotation_offsets: cplRows.filter((r) => r.jlc_offset).length,
    bottom_side_placements: cplRows.filter((r) => r.side === "B").length,
    cplRows,
    reused: fx.reused,
  };
  await writeFile(join(o.out, "bom-decisions.csv"), toCsv(["status", "line", "qty", "refs", "choice", "reason", "evidence"], recs.map((r) => [r.status, r.line, r.qty_per_board, r.refs.join(" "), r.choice ?? "", r.reason ?? "", r.evidence.slice(0, 2).join(" ")])));
  const swaps: Array<{ ref: string; fields: Record<string, string> }> = [];
  for (const r of recs) {
    if (r.status !== "PROPOSED") continue;
    const code = r.lcsc || r.proposal?.lcsc;
    const mpn = r.lcsc ? r.checks["mpn"]?.lcsc : r.proposal?.mpn;
    if (code) for (const ref of r.refs) swaps.push({ ref, fields: { LCSC: code, ...(mpn ? { MPN: mpn } : {}) } });
  }
  await writeFile(join(o.out, "swap-fields.json"), JSON.stringify({ swap: swaps, basis: "bomcheck PROPOSED lines" }, null, 1) + "\n");
  await writeFile(join(o.out, "cpl-jlc.csv"), cplCsv(cplRows));
  if (o.cpl) {
    const pred = new Map(cplRows.map((r) => [r.ref, r]));
    const cmp: Array<Record<string, unknown>> = [];
    for (const row of parseCsv(await readFile(o.cpl, "utf8"))) {
      const ref = row["Ref"] || row["Designator"] || "";
      const pr = pred.get(ref);
      if (!pr) continue;
      const given = mod360(Number(row["Rot"] || row["Rotation"] || 0));
      const want = pr.jlc_rot;
      const kic = pr.kicad_rot;
      const ang = (a: number, b: number) => Math.abs(mod360(a - b + 180) - 180);
      cmp.push({ ref, side: pr.side, cpl_rot: given, kicad_rot: kic, jlc_needs: want, status: ang(given, want) < 1 ? "ok" : ang(given, kic) >= 1 ? "cpl corrected differently" : "cpl = KiCad, JLC differs" });
    }
    result.cpl_compare = { file: o.cpl, compared: cmp.length, mismatch: cmp.filter((r) => r["status"] !== "ok") };
  }
  const { cplRows: _c, reused: _r, ...rest } = result;
  await writeFile(join(o.out, "bom-decisions.json"), JSON.stringify(rest, null, 1) + "\n");
  return result;
}

const pyList = (a: string[]) => `[${a.map((s) => `'${s}'`).join(", ")}]`;

export function cplCsv(rows: CplRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return toCsv(["ref", "lcsc", "side", "kicad_rot", "jlc_offset", "jlc_rot", "origin_offset_mm", "rms_mm"], sorted.map((r) => ({ ...r, origin_offset_mm: `[${r.origin_offset_mm[0]}, ${r.origin_offset_mm[1]}]` })));
}

export function readCplJlc(text: string): Map<string, { ref: string; lcsc: string; side: string; jlc_rot: number }> {
  return new Map(parseCsv(text).map((r) => [r["ref"]!, { ref: r["ref"]!, lcsc: r["lcsc"]!, side: r["side"]!, jlc_rot: Number(r["jlc_rot"]) }]));
}

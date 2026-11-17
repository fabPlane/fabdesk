import { bomCurrency } from "../stages";
import { currentReviewHash } from "../review/store";
/**
 * Fabrication package for a released board. Refuses, writing nothing (no package folder, no zip), unless every gate
 * passes in order (the package is built in a temporary folder beside the destination and renamed into place only when
 * every check passed):
 *   1. the interconnect gate (a hook; none for a standalone project);
 *   2. the review gate: a current review of this exact board, every finding settled;
 *   3. the board's acceptance checks A1-A9 with schematic parity (an exception only with an owner decision, recorded);
 *   4. via-in-pad and microvia fill/cap bindings set natively.
 *   5. for an assembly order (the default), a current BOM check covers every fitted part with a resolved choice (or
 *      named risk); a bare-board order (assembly: false) skips the BOM, CPL and placement check and says so.
 * Then CAM is exported twice and the files must match after the date lines; the Gerbers are drawn by an independent
 * reader and compared with KiCad's plot (gerbcheck); JLC BOM/CPL are written from the BOM check's decisions and rotation
 * predictions, with every CPL row simulated against JLC's own footprint on our copper (jlcsim).
 */
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { runKicadCli, type KicadCli } from "@fabdesk/kicad";
import { CHECK_KEYS } from "../accept";
import { parseSexpr } from "../sexpr";
import { confineToProject } from "../files";
import { boardPinNames, readCplJlc, type BomResult } from "./bomcheck";
import { assembled, boardParts } from "./parts";
import { exportCam, requiredLayers, reproducible, sha256, type Reproducibility } from "./cam";
import { parseCsv, toCsv } from "./csv";
import { gerbCheck, type GerbCheckResult } from "./gerbcheck";
import { gerberPads, parseGerber } from "./gerber";
import { padCentre, simulatePlacement, type CplRowIn, type SimResult } from "./jlcsim";
import type { FetchRecord } from "./lookup";
import { classifyVias, viaBindings } from "./viaproc";
import { zipFiles } from "./zip";

export type ReviewGateInfo = { state: "none" | "stale" | "open" | "errors" | "pass"; open?: number; mustFix?: number; at?: string };

export class ReleaseStop extends Error {
  constructor(
    readonly gate: "interconnect" | "review" | "acceptance" | "vias" | "cam" | "gerbcheck" | "placement" | "bom" | "output",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ReleaseStop";
  }
}

export interface AcceptException {
  check: string;
  decision: string;
  text: string;
}

export interface FabInput {
  project: string;
  stem: string;
  pcb: string;
  /** The root schematic (for the KiCad BOM). */
  schematic: string | null;
  /** Package folder; must not exist. */
  out: string;
  cli: KicadCli;
  gates: {
    /** The interconnect release gate; absent = a standalone project (recorded, not bypassed). */
    interconnect?: () => Promise<{ pass: boolean; text: string }>;
    review: () => Promise<ReviewGateInfo>;
    acceptance: () => Promise<{ summary: Record<string, boolean>; designHash?: string; record?: string }>;
    /**
     * The acceptance's net classes and rules applied to the project before A1-A9 (toolkit fab.py: apply_netclasses);
     * null when there is nothing to apply. A change is a STOP: the design the review saw changed.
     */
    rules?: () => Promise<{ changed: boolean; text: string } | null>;
  };
  /** Owner-accepted exceptions to failing acceptance checks: named, evidenced, never silent. */
  accept?: AcceptException[];
  /** Folder of a BOM check made on this board (bom-decisions.json, cpl-jlc.csv, cache/). */
  bomDir?: string;
  /** The board file hash the BOM check was made on (a BOM from another board is refused). */
  bomBoardSha?: string | null;
  /** A reviewed placement file (KiCad pos CSV with hand corrections) used instead of the generated CPL. */
  cpl?: string;
  /** {LCSC: {proxy, why}}: same-package stand-ins where JLC has no footprint. */
  proxies?: Record<string, { proxy: string; why?: string | undefined }>;
  step?: boolean;
  /** false: a bare-board order. No BOM check is required and no JLC BOM/CPL is written (recorded in the manifest). */
  assembly?: boolean;
  gerbDpi?: number;
  signal?: AbortSignal;
  progress?: (note: string) => void;
}

export interface JlcFiles {
  bom_lines: number;
  placements: number;
  no_lcsc_code: string[];
  rotation_differs_from_kicad: Array<{ ref: string; kicad: number; jlc: number; lcsc: string | null }>;
  moved_to_pad_centre: Array<{ ref: string; from: [number, number]; to: [number, number]; mm: number }>;
  source: string;
  skipped?: string;
  placement_check?: SimResult["summary"];
  cpl_source?: Record<string, string>;
}

export interface FabResult {
  out: string;
  manifest: Record<string, unknown>;
  gates: string[];
}

const reviewStop = (g: ReviewGateInfo): string | null => {
  if (g.state === "pass") return null;
  if (g.state === "none") return "no review recorded for this design: run the review (board_review run) first";
  if (g.state === "stale") return "the review is of an earlier design (board, schematics, project files or requirements changed since): run the review again (board_review run)";
  if (g.state === "errors") return "the review had check errors: fix them and run the review again (board_review run)";
  return `review: ${g.open ?? "?"} findings open (${g.mustFix ?? 0} must-fix): settle each with evidence`;
};

export async function resolveException(spec: string, baseDir: string): Promise<AcceptException> {
  const [check, ref] = [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)];
  if (!check || !ref.includes("#")) throw new ReleaseStop("acceptance", `--accept ${spec}: expected CHECK=FILE#ID`);
  const [file, id] = [ref.slice(0, ref.indexOf("#")), ref.slice(ref.indexOf("#") + 1)];
  // the decision file is the project's own record: never a file outside the project
  const path = await confineToProject(baseDir, file, "decision file").catch((e: unknown) => {
    throw new ReleaseStop("acceptance", `STOP --accept ${spec}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const doc = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  const lists = Array.isArray(doc) ? [doc] : doc && typeof doc === "object" ? Object.values(doc) : [];
  const recs = lists.filter(Array.isArray).flat().filter((r) => r && typeof r === "object") as Array<Record<string, unknown>>;
  const rec = recs.find((r) => r["id"] === id);
  if (!rec || !String(rec["by"] ?? "").includes("owner")) throw new ReleaseStop("acceptance", `STOP --accept ${spec}: no owner decision with id ${id} in ${file}`);
  return { check, decision: `${file}#${id}`, text: String(rec["decision"] ?? "") };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const layerFile = (names: string[], layer: string) => names.find((n) => new RegExp(`-${layer}\\.\\w+$`).test(n));

async function padMaps(gerberDir: string) {
  const names = await readdir(gerberDir);
  const read = async (layer: string) => {
    const f = layerFile(names, layer);
    return f ? gerberPads(parseGerber(await readFile(join(gerberDir, f), "latin1"))) : new Map<string, Array<[number, number]>>();
  };
  return { top: await read("F_Cu"), bottom: await read("B_Cu") };
}

const mod360 = (r: number) => ((r % 360) + 360) % 360;

type PadsBySide = Map<string, Record<string, Array<[number, number]>>>;

/** Our copper pads (from the Gerber X2 attributes) grouped by reference, for the pad-centre positions. */
export function padsByRef(m: Map<string, Array<[number, number]>>): PadsBySide {
  const by: PadsBySide = new Map();
  for (const [k, pts] of m) {
    const [rf, pad] = k.split("\u0000");
    (by.get(rf!) ?? by.set(rf!, {}).get(rf!)!)[pad ?? ""] = pts;
  }
  return by;
}

export interface JlcRows extends Omit<JlcFiles, "source"> {
  bom: string[][];
  cpl: string[][];
}

/**
 * JLC-format BOM and CPL rows from the BOM check's decisions (LCSC codes) and rotation predictions: the position is the
 * centre of the soldered pads in our copper, the rotation the one JLC's own footprint needs (assume JLC draws it like
 * ours where it has none; bottom parts are seen from below). Parts without an LCSC code are listed, not guessed.
 */
export function jlcRows(dec: Pick<BomResult, "records">, cpl: ReturnType<typeof readCplJlc>, pos: Map<string, Record<string, string>>, copper: { top: PadsBySide; bottom: PadsBySide }): JlcRows {
  const bomRows: string[][] = [];
  const placed = new Set<string>();
  const noCode: string[] = [];
  const diffs: JlcFiles["rotation_differs_from_kicad"] = [];
  const moved: JlcFiles["moved_to_pad_centre"] = [];
  for (const r of dec.records) {
    if (r.copper_only) continue;
    const refs = r.refs.filter((x) => pos.has(x));
    if (!refs.length) continue;
    const code = r.lcsc;
    if (!code) {
      noCode.push(...refs);
      continue;
    }
    bomRows.push([r.value ?? "", refs.join(","), (r.checks?.["package"] as string | null) || pos.get(refs[0]!)!["Package"]!, code]);
    for (const x of refs) placed.add(x);
  }
  const rows: string[][] = [];
  for (const ref of [...placed].sort()) {
    const p = pos.get(ref)!;
    const bottom = p["Side"] === "bottom";
    let rot = mod360(Number(p["Rot"]));
    const c = cpl.get(ref);
    const jr = c ? mod360(c.jlc_rot) : !bottom ? rot : mod360(180 - rot);
    if (Math.abs(jr - rot) > 0.01) diffs.push({ ref, kicad: rot, jlc: jr, lcsc: c ? c.lcsc : null });
    rot = jr;
    let [x, y] = [Number(p["PosX"]), Number(p["PosY"])];
    const mine = (bottom ? copper.bottom : copper.top).get(ref);
    if (mine && Object.keys(mine).length) {
      const [cx, cy] = padCentre(mine);
      if (Math.hypot(cx - x, cy - y) > 0.005) moved.push({ ref, from: [x, y], to: [Math.round(cx * 1e4) / 1e4, Math.round(cy * 1e4) / 1e4], mm: Math.round(Math.hypot(cx - x, cy - y) * 1e3) / 1e3 });
      [x, y] = [cx, cy];
    }
    rows.push([ref, x.toFixed(6), y.toFixed(6), bottom ? "Bottom" : "Top", String(rot)]);
  }
  return { bom: bomRows, cpl: rows, bom_lines: bomRows.length, placements: placed.size, no_lcsc_code: [...new Set(noCode)].sort(), rotation_differs_from_kicad: diffs, moved_to_pad_centre: moved };
}

export const JLC_BOM_FIELDS = ["Comment", "Designator", "Footprint", "LCSC Part #"] as const;
export const JLC_CPL_FIELDS = ["Designator", "Mid X", "Mid Y", "Layer", "Rotation"] as const;

/** Step 6: write `<stem>-jlc-bom.csv` and `<stem>-jlc-cpl.csv` from the BOM check and the package's position file and copper. */
export async function jlcFiles(out: string, bomDir: string, stem: string, gerberDir: string): Promise<JlcFiles> {
  const dec = JSON.parse(await readFile(join(bomDir, "bom-decisions.json"), "utf8")) as BomResult;
  const cpl = readCplJlc(await readFile(join(bomDir, "cpl-jlc.csv"), "utf8"));
  const pos = new Map(parseCsv(await readFile(join(out, `${stem}-pos.csv`), "utf8")).map((r) => [r["Ref"]!, r]));
  const maps = await padMaps(gerberDir);
  const { bom, cpl: rows, ...rest } = jlcRows(dec, cpl, pos, { top: padsByRef(maps.top), bottom: padsByRef(maps.bottom) });
  await writeFile(join(out, `${stem}-jlc-bom.csv`), toCsv(JLC_BOM_FIELDS, bom));
  await writeFile(join(out, `${stem}-jlc-cpl.csv`), toCsv(JLC_CPL_FIELDS, rows));
  return { ...rest, source: bomDir };
}

export { padMaps };

/** Missing/unsettled choices cannot disappear from a gated assembly handoff. */
export function assertReleaseBom(decisions: Pick<BomResult, "records">, pcbText: string): void {
  if (!Array.isArray(decisions?.records)) throw new ReleaseStop("bom", "STOP BOM decisions are missing or malformed: run board_release bom again");
  const byRef = new Map<string, BomResult["records"][number]>();
  for (const record of decisions.records) {
    if (!record || !Array.isArray(record.refs) || !record.refs.length || record.refs.some(ref => typeof ref !== "string" || !ref)) throw new ReleaseStop("bom", "STOP BOM decisions contain malformed references: run board_release bom again");
    for (const ref of record.refs) {
      if (byRef.has(ref)) throw new ReleaseStop("bom", `STOP BOM decisions duplicate ${ref}: run board_release bom again`);
      byRef.set(ref, record);
    }
  }
  const blocked = boardParts(parseSexpr(pcbText)).filter(assembled).filter(part => {
    const record = byRef.get(part.ref);
    return !record || (record.status !== "RESOLVED" && record.status !== "RISK") ||
      (record.copper_only ? record.status !== "RESOLVED" : typeof record.lcsc !== "string" || !/^C\d+$/.test(record.lcsc));
  });
  if (blocked.length) throw new ReleaseStop("bom", `STOP BOM check has missing or unsettled fitted parts: ${blocked.map(part => `${part.ref} (${byRef.get(part.ref)?.status ?? "missing"})`).join(", ")}. Resolve choices and run board_release bom again`);
}

/** Every CPL row simulated against JLC's own footprint on our copper. */
export async function placementCheck(out: string, bomDir: string, stem: string, sheets: string[], proxies?: FabInput["proxies"]): Promise<SimResult> {
  const cplRows = parseCsv(await readFile(join(out, `${stem}-jlc-cpl.csv`), "utf8")) as CplRowIn[];
  const codes: Record<string, string | undefined> = {};
  for (const row of parseCsv(await readFile(join(out, `${stem}-jlc-bom.csv`), "utf8")))
    for (const d of (row["Designator"] ?? "").split(",")) codes[d.trim()] = row["LCSC Part #"] || row["LCSC"];
  const maps = await padMaps(join(out, "gerbers"));
  const cache = new Map<string, FetchRecord | null>();
  const eda = (code: string): FetchRecord | null => {
    if (!cache.has(code)) {
      try {
        cache.set(code, JSON.parse(readFileSync(join(bomDir, "cache", `eda-${code}.json`), "utf8")) as FetchRecord);
      } catch {
        cache.set(code, null);
      }
    }
    return cache.get(code)!;
  };
  return simulatePlacement({ cpl: cplRows, codes, top: maps.top, bottom: maps.bottom, eda, pinNames: (ref) => boardPinNames(sheets, ref), ...(proxies ? { proxies } : {}) });
}

export async function releaseFab(inp: FabInput): Promise<FabResult> {
  const note = inp.progress ?? (() => {});
  const gates: string[] = [];
  if (await stat(inp.out).then(() => true, () => false)) throw new ReleaseStop("output", `${inp.out} exists`);
  // 1. interconnect gate
  note("interconnect gate");
  const ic = inp.gates.interconnect ? await inp.gates.interconnect() : { pass: true, text: "interconnect: none (standalone project, no contract gate)" };
  if (!ic.pass) throw new ReleaseStop("interconnect", `STOP release gate: ${ic.text}`);
  gates.push(ic.text);
  // 2. review gate
  note("review gate");
  const rg = await inp.gates.review();
  const rstop = reviewStop(rg);
  if (rstop) throw new ReleaseStop("review", `STOP review gate: ${rstop}`, rg);
  // 3. acceptance, with parity, on the acceptance's rules (a no-op for a board that keeps its native rules)
  if (inp.gates.rules) {
    note("acceptance rules on the project");
    const r = await inp.gates.rules();
    if (r?.changed)
      throw new ReleaseStop(
        "acceptance",
        `STOP acceptance rules: the project's net classes and rules did not follow the acceptance (it does not keep native rules), not applied (${r.text}); run board_check {applyRules:true}, then board_review run, then release`,
        r,
      );
  }
  note("acceptance A1-A9 with schematic parity");
  const acc = await inp.gates.acceptance();
  const exceptions = new Map((inp.accept ?? []).map((e) => [e.check, e]));
  const failing = CHECK_KEYS.filter((k) => acc.summary[k] === false || acc.summary[k] === undefined);
  const unaccepted = failing.filter((k) => !exceptions.has(k) && !exceptions.has(k.slice(0, 2)));
  if (unaccepted.length) throw new ReleaseStop("acceptance", `STOP acceptance: failing ${unaccepted.join(", ")}`, acc.summary);
  const pcbText = await readFile(inp.pcb, "utf8");
  // 4. via-in-pad and microvia bindings
  note("via process bindings");
  const { record: viaRec, missing } = viaBindings(inp.pcb, classifyVias(pcbText));
  if (missing.length)
    throw new ReleaseStop("vias", `STOP via bindings: ${missing.length} via(s) in pads or microvias lack (filling yes) (capping yes): ${missing.slice(0, 6).map((v) => `${v.net}@${v.xy.join(",")}`).join("; ")}. First record the owner decision manufacturing_rules.filled_capped_vias with a reason. Set fabrication attributes with board_release {"action": "vias", "apply": true} (the order must then ask for filled and capped vias), release stops for any geometry change: make it a separate named edit task, then run checks and review again`, viaRec.counts);
  // An assembly order: a missing, stale or incomplete BOM refuses before anything is exported. A bare-board order
  // needs no BOM. Ungated CAM is a separate action.
  const assembly = inp.assembly !== false;
  const hasCplJlc = assembly && !!inp.bomDir && (await stat(join(inp.bomDir, "cpl-jlc.csv")).then(() => true, () => false));
  let bomDecisions: BomResult | null = null;
  if (assembly) {
    if (!inp.bomDir || !hasCplJlc) throw new ReleaseStop("bom", "STOP no current BOM check: run board_release bom first (assembly: false for a bare-board order; board_release cam for ungated CAM only)");
    if (bomCurrency(inp.bomBoardSha ?? null, sha256(await readFile(inp.pcb))) !== "current")
      throw new ReleaseStop("bom", "STOP BOM check is of an earlier board (the board changed since): run board_release bom again");
    bomDecisions = await readFile(join(inp.bomDir, "bom-decisions.json"), "utf8")
      .then(text => JSON.parse(text) as BomResult)
      .catch(() => { throw new ReleaseStop("bom", "STOP BOM decisions are missing or malformed: run board_release bom again"); });
    assertReleaseBom(bomDecisions, pcbText);
  }
  // CAM: built in a temporary folder beside the destination, renamed into place only when every check passed
  const final = inp.out;
  const parent = dirname(final);
  const parentExisted = await stat(parent).then(() => true, () => false);
  const work = join(parent, `.${basename(final)}.partial-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    await writeFile(join(work, "acceptance-gate.json"), JSON.stringify({ reviewDesignHash: await currentReviewHash(inp.project), summary: acc.summary, ...(acc.designHash ? { designHash: acc.designHash } : {}), ...(acc.record ? { record: acc.record } : {}) }, null, 1) + "\n");
    await writeFile(join(work, "via-process-bindings.json"), JSON.stringify(viaRec, null, 1) + "\n");
    const layers = requiredLayers(pcbText);
    note("CAM export, twice");
    const rep: Reproducibility = await reproducible(inp.cli, inp.pcb, join(work, "repro"), layers, inp.signal);
    if (!rep.pass) throw new ReleaseStop("cam", `STOP CAM export is not reproducible: ${rep.differ.join(", ")}`, rep);
    const g = join(work, "gerbers");
    await mkdir(g, { recursive: true });
    for (const n of await readdir(join(work, "repro", "repro-a"))) await copyFile(join(work, "repro", "repro-a", n), join(g, n));
    const o = { ...(inp.signal ? { signal: inp.signal } : {}) };
    note("positions, BOM, STEP");
    await runKicadCli(inp.cli, ["pcb", "export", "pos", "--output", join(work, `${inp.stem}-pos.csv`), "--format", "csv", "--units", "mm", "--side", "both", inp.pcb], o);
    if (inp.schematic) await runKicadCli(inp.cli, ["sch", "export", "bom", "--output", join(work, `${inp.stem}-bom.csv`), inp.schematic], o);
    if (inp.step !== false) await runKicadCli(inp.cli, ["pcb", "export", "step", "--output", join(work, `${inp.stem}.step`), "--subst-models", inp.pcb], o);
    await rm(join(work, "repro"), { recursive: true, force: true });
    note("Gerber render check");
    const gc: GerbCheckResult = await gerbCheck({ gerbers: g, pcb: inp.pcb, out: join(work, "gerbcheck"), cli: inp.cli, dpi: inp.gerbDpi ?? 400, ...(inp.signal ? { signal: inp.signal } : {}) });
    if (!gc.pass) throw new ReleaseStop("gerbcheck", `STOP Gerber render check: ${Object.entries(gc.layers).filter(([, v]) => !v.pass).map(([k, v]) => `${k} ${v.error ?? `${((v.diff_share ?? 0) * 100).toFixed(3)} % beyond 1 px`}`).join("; ")}`, gc);
    const names = (await readdir(g)).sort();
    await writeFile(join(work, `${inp.stem}-gerbers.zip`), zipFiles(await Promise.all(names.map(async (n) => ({ name: n, data: new Uint8Array(await readFile(join(g, n))) })))));
    // JLC files
    let jlc: JlcFiles | { skipped: string } = { skipped: assembly ? "no BOM check for this board (board_release bom): no JLC BOM/CPL" : "bare-board order (assembly: false): no BOM, CPL or placement check" };
    const sheets: string[] = [];
    for (const n of (await readdir(inp.project)).filter((x) => x.endsWith(".kicad_sch")).sort()) sheets.push(await readFile(join(inp.project, n), "utf8"));
    if (inp.bomDir && hasCplJlc && bomDecisions) {
      note("JLC BOM and CPL");
      const j = await jlcFiles(work, inp.bomDir, inp.stem, g);
      const placedRefs = new Set(parseCsv(await readFile(join(work, `${inp.stem}-jlc-cpl.csv`), "utf8")).map(row => row["Designator"]));
      const copperOnly = new Set(bomDecisions.records.filter(record => record.copper_only).flatMap(record => record.refs));
      const missingPlacements = boardParts(parseSexpr(pcbText)).filter(assembled).filter(part => !part.flags.includes("exclude_from_pos_files") && !copperOnly.has(part.ref) && !placedRefs.has(part.ref));
      if (j.no_lcsc_code.length || missingPlacements.length) throw new ReleaseStop("bom", `STOP JLC handoff omits fitted parts: ${[...new Set([...j.no_lcsc_code, ...missingPlacements.map(part => part.ref)])].join(", ")}`);
      if (inp.cpl) {
        const rows = parseCsv(await readFile(inp.cpl, "utf8"));
        const bomRefs = new Set<string>();
        for (const r of parseCsv(await readFile(join(work, `${inp.stem}-jlc-bom.csv`), "utf8"))) for (const d of (r["Designator"] ?? "").split(",")) bomRefs.add(d);
        const refs = new Set(rows.map((r) => r["Ref"]!));
        const sym = [...refs].filter((r) => !bomRefs.has(r)).concat([...bomRefs].filter((r) => !refs.has(r)));
        if (sym.length) throw new ReleaseStop("bom", `STOP --cpl ${inp.cpl}: refs differ from the JLC BOM: ${sym.sort().slice(0, 10).join(", ")}`);
        await writeFile(join(work, `${inp.stem}-jlc-cpl.csv`), toCsv(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"], [...rows].sort((a, b) => (a["Ref"]! < b["Ref"]! ? -1 : 1)).map((r) => [r["Ref"]!, r["PosX"]!, r["PosY"]!, (r["Side"] ?? "").toLowerCase() === "bottom" ? "Bottom" : "Top", String(mod360(Number(r["Rot"])))])));
        j.cpl_source = { reviewed: inp.cpl, sha256: sha256(await readFile(inp.cpl)), note: "reviewed placement used as-is; bomcheck rotation predictions kept in rotation_differs_from_kicad for the preview check" };
      }
      note("placement check (JLC footprint on our copper)");
      const sim = await placementCheck(work, inp.bomDir, inp.stem, sheets, inp.proxies);
      await writeFile(join(work, "placement-check.json"), JSON.stringify({ summary: sim.summary, convention: sim.convention, cpl: join(final, `${inp.stem}-jlc-cpl.csv`), parts: sim.parts }, null, 1) + "\n");
      j.placement_check = sim.summary;
      const bad = sim.parts.filter((p) => p.verdict !== "PASS");
      if (bad.length)
        throw new ReleaseStop("placement", "STOP placement check (JLC footprint simulated on our copper): " + bad.map((p) => `${p.ref} ${p.verdict} (rot ${p.cpl_rot}: land ${p.land_rms} same-pin ${p.same_pin}${p.solved ? `; fits at ${p.solved.rot} moved ${p.solved.moved_mm} mm` : ""})`).join(", "), sim.summary);
      jlc = j;
    }
    const man = {
      release_gate: ic.text,
      acceptance: acc.summary,
      jlc,
      layers: layers,
      accepted_exceptions: Object.fromEntries(failing.map((k) => [k, exceptions.get(k) ?? exceptions.get(k.slice(0, 2))])),
      reproducible: rep,
      gerbcheck: { gerbers: join(final, "gerbers"), pcb: gc.pcb, dpi: gc.dpi, drill: gc.drill, pass: gc.pass },
      sources: { pcb: sha256(await readFile(inp.pcb)), ...(inp.schematic ? { schematic_root: sha256(await readFile(inp.schematic)) } : {}) },
      review: { gate: rg.state, open: rg.open ?? 0, mustFix: rg.mustFix ?? 0, ...(rg.at ? { at: rg.at } : {}) },
      files: {} as Record<string, string>,
    };
    for (const f of (await walk(work)).sort()) man.files[relative(work, f)] = sha256(await readFile(f));
    await writeFile(join(work, "manifest.json"), JSON.stringify(man, null, 1) + "\n");
    await rename(work, final).catch((e: unknown) => {
      throw new ReleaseStop("output", `${final} could not be written (${e instanceof Error ? e.message : String(e)})`);
    });
    return { out: final, manifest: man, gates: [ic.text, "review gate passes", `acceptance ${failing.length ? `with ${failing.length} accepted exception(s)` : "A1-A9 pass"}`, `vias: ${viaRec.counts.require_fill_cap} bound`] };
  } catch (e) {
    // a refusal leaves nothing behind: no half-package, no uploadable zip
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (!parentExisted) await rmdir(parent).catch(() => {});
    throw e;
  }
}

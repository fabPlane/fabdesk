/**
 * board_release: the release stage. One tool, four actions:
 *   bom    every BOM line to a manufacturable part with evidence, and the CPL rotation JLC's own footprint needs
 *   gerb   do the Gerbers show the board? (independent reader's render against KiCad's plot, drill counts)
 *   check  release readiness without writing a package; with `package`, JLC's footprint simulated on that package's copper
 *   fab    the fabrication package, refusing unless every gate passes in order
 *
 * Overlaps `export_pos` (JLC rotations and pad-centre positions are emitted there too), `export_gerbers`/`export_drill`/
 * `export_zip` (fab exports twice, proves the files reproducible and checks them) and `release_build`'s fabrication
 * export (that one stays a non-blocking record; this is the hard gate). Nothing here shells out to a toolkit.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { CHECK_KEYS, locateProject, readRequirements, release, runAcceptance, type AcceptRun } from "@fabdesk/board-workflow";
import { runDurable } from "../durable";
import { jailPath } from "../fs";
import { boardMemGiB, governor } from "../resources";
import { readAcceptanceState, readReviewGate } from "../board-state";
import { bomDirOf, readBomState, readLastFab, readProxies, releaseHome, sha256Of, writeBomMeta, writeLastFab, writeProxies } from "../release-state";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad, runLiveDrc } from "./common";

/** The interconnect release gate of a host project (contracts between boards). Standalone Fabdesk projects have none. */
type InterconnectGate = (input: { projectDir: string }) => Promise<{ pass: boolean; text: string }>;
let interconnectGate: InterconnectGate | null = null;
export function setInterconnectGate(g: InterconnectGate | null): void {
  interconnectGate = g;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const Proxies = z.record(z.string(), z.object({ proxy: z.string(), why: z.string().optional() }));

const Input = {
  action: z.enum(["bom", "gerb", "check", "fab"]).describe("bom: part identity, stock, lifecycle, JLC footprint fit and CPL rotation per line. gerb: render check of Gerbers against KiCad's plot. check: release readiness (or JLC placement simulation of an existing package). fab: the fabrication package; refuses unless every gate passes."),
  pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the project's only .kicad_pcb."),
  boards: z.number().int().min(1).max(10000).default(5).describe("bom: boards to cover with stock (+10 % and 2 spare)."),
  fMax: z.number().positive().optional().describe("bom: height limit above the top surface in mm (from the board's own limit)."),
  bMax: z.number().positive().optional().describe("bom: height limit below the bottom surface in mm."),
  heights: z.string().optional().describe("bom: a height screen JSON in the project (entries[].ref, height_above_surface_mm); default the board's own requirements/heights.json when present."),
  ordering: z.string().optional().describe("bom: a CSV in the project (Reference, LCSC, MPN, AssemblyMPN) that names parts the footprints do not."),
  overrides: z.record(z.string(), z.object({ lcsc: z.string().regex(/^C\d{3,}$/), mpn: z.string().optional(), reason: z.string().optional() })).optional().describe("bom: your part choice for lines without identity {REF: {lcsc, reason}}; PROPOSED until written into the schematic."),
  offline: z.boolean().default(false).describe("bom: use only the evidence cache (no lookups)."),
  gerbers: z.string().optional().describe("gerb: folder of Gerber and drill files in the project to check; default: export the board's CAM files now."),
  dpi: z.number().int().min(100).max(1200).default(400).describe("gerb/fab: render resolution of the Gerber check."),
  package: z.string().optional().describe("check: a fabrication package folder in the project; runs JLC's footprint on its copper (the proxies check) instead of the readiness report."),
  proxies: Proxies.optional().describe("check/fab: {LCSC: {proxy, why}} same-package stand-ins where JLC has no footprint; saved in the project for later runs."),
  out: z.string().optional().describe("fab: package folder, new, inside the project (default exports/release-<time>)."),
  accept: z.array(z.string()).default([]).describe('fab: owner-accepted exceptions "CHECK=FILE#ID" (e.g. A8_pairs=notes/decisions.json#pair-spacing): a failing acceptance check passes only with an owner decision of that id in the file; recorded in the manifest.'),
  cpl: z.string().optional().describe("fab: a reviewed placement CSV in the project (KiCad pos format with hand corrections) used for the JLC CPL; refs must match the JLC BOM."),
  step: z.boolean().default(true).describe("fab: include the STEP model."),
};

type Args = {
  [K in keyof typeof Input]: z.infer<(typeof Input)[K]>;
};

const lines = (xs: string[], n: number) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);

async function admit(ctx: ToolContext, label: string, paths: string[]) {
  return governor().admit({ cls: "light", label, paths, signal: ctx.signal, memGiB: await boardMemGiB(paths), onWait: (w) => ctx.progress(0, w) });
}

async function bomAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const out = bomDirOf(project.dir);
  const heights = a.heights ? await jailPath(project.dir, a.heights) : await (async () => { const f = join(project.dir, ".fabdesk", "board", "requirements", "heights.json"); return (await sha256Of(f)) ? f : undefined; })();
  const ordering = a.ordering ? await jailPath(project.dir, a.ordering) : undefined;
  const job = await admit(ctx, "board_release bom", [files.pcb]);
  try {
    const r = await release.bomCheck({
      project: project.dir,
      stem: files.stem,
      out,
      boards: a.boards,
      ...(a.fMax !== undefined ? { fMax: a.fMax } : {}),
      ...(a.bMax !== undefined ? { bMax: a.bMax } : {}),
      ...(heights ? { heights } : {}),
      ...(ordering ? { ordering } : {}),
      ...(a.offline ? { offline: true } : {}),
      ...(a.overrides ? { overrides: a.overrides } : {}),
      signal: ctx.signal,
      onProgress: (done, total, what) => ctx.progress(Math.min(0.95, done / Math.max(1, total)), `${done}/${total} ${what}`),
    });
    await writeBomMeta(project.dir, { at: new Date().toISOString(), boardSha256: (await sha256Of(files.pcb)) ?? "", stem: files.stem, boards: a.boards, offline: a.offline, summary: r.summary, lines: r.lines, placements: r.placements });
    const open = r.records.filter((x) => x.status !== "RESOLVED");
    const text = [
      `BOM check: ${r.lines} lines / ${r.placements} placements: ${Object.entries(r.summary).map(([k, v]) => `${k} ${v}`).join(", ")}; JLC rotation differs from KiCad on ${r.rotation_offsets} part(s), ${r.bottom_side_placements} on the bottom; lookups ${r.fetch_calls} live, ${r.reused} from the shared cache.`,
      ...lines(open.map((x) => `- ${x.status} ${x.refs.slice(0, 6).join(",")}${x.refs.length > 6 ? ",..." : ""} (${x.line}): ${x.reason ?? ""}`), 40),
      r.cplRows.filter((x) => x.jlc_offset).length ? `Rotation corrections for JLC: ${r.cplRows.filter((x) => x.jlc_offset).map((x) => `${x.ref} ${x.kicad_rot}->${x.jlc_rot}`).slice(0, 20).join(", ")}` : "No JLC rotation corrections needed.",
      `Evidence and decisions: ${relative(project.dir, out)}/bom-decisions.json (+ .csv, cpl-jlc.csv, swap-fields.json, cache/). PROPOSED lines become RESOLVED once their LCSC/MPN are written into the schematic.`,
    ].join("\n");
    return ok(text, { summary: r.summary, lines: r.lines, placements: r.placements, records: r.records.map((x) => ({ status: x.status, line: x.line, refs: x.refs, choice: x.choice, reason: x.reason, evidence: x.evidence })), rotationOffsets: r.rotation_offsets, dir: out });
  } finally {
    job.release();
  }
}

async function gerbAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const cli = await requireKicad(ctx);
  const work = join(releaseHome(project.dir), `gerb-${stamp()}`);
  const job = await admit(ctx, "board_release gerb", [files.pcb]);
  try {
    let dir: string;
    if (a.gerbers) dir = await jailPath(project.dir, a.gerbers);
    else {
      dir = join(work, "gerbers");
      ctx.progress(0.1, "exporting the CAM files");
      await release.exportCam(cli, files.pcb, dir, release.requiredLayers(await readFile(files.pcb, "utf8")), ctx.signal);
    }
    const r = await release.gerbCheck({ gerbers: dir, pcb: files.pcb, out: join(work, "check"), cli, dpi: a.dpi, signal: ctx.signal, onProgress: (l) => ctx.progress(0.5, `rendering ${l}`) });
    const rows = Object.entries(r.layers).map(([k, v]) => `${k.padEnd(13)} gerber ${v.gerber_px ?? "-"} px  kicad ${v.kicad_px ?? "-"} px  beyond 1 px ${v.beyond_1px ?? "-"} (${((v.diff_share ?? 0) * 100).toFixed(3)} %)  ${v.error ?? (v.pass ? "PASS" : "FAIL")}`);
    const text = [`${r.pass ? "PASS" : "FAIL"} ${Object.values(r.layers).filter((v) => v.pass).length}/${Object.keys(r.layers).length} layers at ${a.dpi} dpi (a layer passes when the differences that survive a 1-pixel band are under 0.1 % of the drawn area)`, ...rows, `drill: ${Object.entries(r.drill).map(([n, d]) => `${n} ${d.holes_or_slots} holes/slots, ${d.tools} tools`).join("; ") || "no drill files"}`, ...(r.unsupported.length ? [`reader limits: ${r.unsupported.join(", ")}`] : []), `Pictures of the differences (red: Gerber only, blue: KiCad only): ${relative(project.dir, join(work, "check"))}/diff-*.png`].join("\n");
    return ok(text, { pass: r.pass, layers: r.layers, drill: r.drill, dir: relative(project.dir, join(work, "check")) });
  } finally {
    job.release();
  }
}

async function checkAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const proxies = { ...(await readProxies(project.dir)), ...(a.proxies ?? {}) };
  if (a.proxies) await writeProxies(project.dir, proxies);
  if (a.package) {
    const pkg = await jailPath(project.dir, a.package);
    const stem = (await readdir(pkg)).find((n) => n.endsWith("-jlc-cpl.csv"))?.replace(/-jlc-cpl\.csv$/, "");
    if (!stem) throw new ToolError(`${a.package} has no <stem>-jlc-cpl.csv`, "not_found");
    const bom = await readBomState(project.dir, files.pcb);
    const sheets = await Promise.all((await readdir(project.dir)).filter((n) => n.endsWith(".kicad_sch")).sort().map((n) => readFile(join(project.dir, n), "utf8")));
    const sim = await release.placementCheck(pkg, bom.dir, stem, sheets, proxies);
    const bad = sim.parts.filter((p) => p.verdict !== "PASS" || p.note);
    const text = [
      `JLC placement check: ${sim.summary.pass}/${sim.summary.placements} pass, ${sim.summary.fail} fail; no JLC footprint: ${sim.summary.no_jlc_footprint.join(", ") || "none"}; checked with a proxy footprint: ${sim.summary.checked_with_proxy_footprint.join(", ") || "none"}`,
      sim.convention,
      ...lines(bad.map((p) => `- ${p.ref} ${p.side} ${p.verdict} rot ${p.cpl_rot} land ${p.land_rms ?? "-"} same-pin ${p.same_pin ?? "-"} pin1 ${p.pin1_on_pin1 ?? "-"} ${p.note ?? p.why ?? ""}${p.solved && p.verdict === "FAIL" ? ` -> fits at rot ${p.solved.rot} moved ${p.solved.moved_mm} mm (${p.solved.verdict})` : ""}`), 40),
    ].join("\n");
    return ok(text, { summary: sim.summary, parts: sim.parts.filter((p) => p.verdict !== "PASS" || p.note) });
  }
  const [acc, gate, bom, vias, last] = await Promise.all([
    readAcceptanceState(project.dir),
    readReviewGate(project.dir),
    readBomState(project.dir, files.pcb),
    readFile(files.pcb, "utf8").then((t) => release.viaBindings(files.pcb, release.classifyVias(t))),
    readLastFab(project.dir),
  ]);
  const ic = interconnectGate ? await interconnectGate({ projectDir: project.dir }) : { pass: true, text: "none (standalone project)" };
  const accText = acc.state === "none" ? "not measured: board_check" : acc.state === "stale" ? "measured on an earlier board: board_check" : acc.pass ? "A1-A9 pass" : `failing ${acc.failing.join(", ")}`;
  const gateText = gate.state === "pass" ? "passes" : gate.state === "none" ? "not run" : gate.state === "stale" ? "stale (the design changed since: board_review run)" : gate.state === "errors" ? "check errors" : `${gate.open ?? "?"} findings open (${gate.mustFix ?? 0} must-fix)`;
  const bomText = bom.state === "none" ? "no BOM check: action bom" : bom.state === "stale" ? "BOM check is of an earlier board: action bom" : `current (${bom.meta!.lines} lines, ${Object.entries(bom.meta!.summary).map(([k, v]) => `${k} ${v}`).join(", ")})`;
  const text = [
    `Release readiness for ${files.stem}:`,
    `1 interconnect gate: ${ic.pass ? "passes" : "STOP"} (${ic.text})`,
    `2 review gate: ${gateText}`,
    `3 acceptance: ${accText}`,
    `4 via-in-pad / microvia bindings: ${vias.record.counts.require_fill_cap} need fill+cap, ${vias.missing.length} missing natively`,
    `BOM / JLC rotations: ${bomText}`,
    last ? `Last package: ${relative(project.dir, last.out)} (${last.boardSha256 === (await sha256Of(files.pcb)) ? "of this board" : "of an earlier board"})` : "No package built yet.",
  ].join("\n");
  const ready = ic.pass && gate.state === "pass" && acc.pass && !vias.missing.length;
  return ok(text, { ready, interconnect: ic, review: gate, acceptance: { state: acc.state, failing: acc.failing, pass: acc.pass }, vias: { ...vias.record.counts }, bom: { state: bom.state, ...(bom.meta ? { summary: bom.meta.summary } : {}) } });
}

async function fabAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const cli = await requireKicad(ctx);
  const out = a.out ? await jailPath(project.dir, a.out) : join(project.dir, "exports", `release-${stamp()}`);
  const proxies = { ...(await readProxies(project.dir)), ...(a.proxies ?? {}) };
  if (a.proxies) await writeProxies(project.dir, proxies);
  const bom = await readBomState(project.dir, files.pcb);
  const accept = await Promise.all(a.accept.map((s) => release.resolveException(s, project.dir)));
  const cpl = a.cpl ? await jailPath(project.dir, a.cpl) : undefined;
  const job = await admit(ctx, "board_release fab", [files.pcb]);
  try {
    const r = await release.releaseFab({
      project: project.dir,
      stem: files.stem,
      pcb: files.pcb,
      schematic: (await sha256Of(join(project.dir, `${files.stem}.kicad_sch`))) ? join(project.dir, `${files.stem}.kicad_sch`) : null,
      out,
      cli,
      gates: {
        ...(interconnectGate ? { interconnect: () => interconnectGate!({ projectDir: project.dir }) } : {}),
        review: () => readReviewGate(project.dir),
        acceptance: async () => {
          if (!(await readRequirements(project.dir))) throw new release.ReleaseStop("acceptance", "STOP acceptance: no requirements for this board: run board_check first");
          const run: AcceptRun = await runAcceptance(project.dir, {
            pcb: files.pcb,
            parity: true,
            drc: async ({ board, parity, outFile }) => {
              const d = await runLiveDrc(ctx, cli, { board, outFile, parity, refill: true, signal: ctx.signal });
              return { violations: d.violations, unconnected: d.unconnected.length, parity: d.schematicParity.length };
            },
          });
          const summary = Object.fromEntries(CHECK_KEYS.map((k) => [k, (run.entry.summary as Record<string, boolean>)[k.slice(0, 2)] ?? false]));
          return { summary, designHash: run.entry.designHash, record: run.entry.file };
        },
      },
      accept,
      ...(bom.state !== "none" ? { bomDir: bom.dir, bomBoardSha: bom.meta!.boardSha256 } : {}),
      ...(cpl ? { cpl } : {}),
      ...(Object.keys(proxies).length ? { proxies } : {}),
      step: a.step,
      gerbDpi: a.dpi,
      signal: ctx.signal,
      progress: (n) => ctx.progress(0.5, n),
    });
    const man = r.manifest as { jlc?: { bom_lines?: number; placements?: number; placement_check?: { pass: number; fail: number; placements: number; no_jlc_footprint: string[] }; no_lcsc_code?: string[]; rotation_differs_from_kicad?: unknown[]; skipped?: string }; reproducible: { files: number }; gerbcheck: { pass: boolean }; files: Record<string, string> };
    await writeLastFab(project.dir, { at: new Date().toISOString(), out, boardSha256: (await sha256Of(files.pcb)) ?? "", manifestSha256: (await sha256Of(join(out, "manifest.json"))) ?? "" });
    const j = man.jlc;
    const text = [
      `RELEASED: fabrication package ${relative(project.dir, out)} (${Object.keys(man.files).length} files)`,
      ...r.gates.map((g) => `gate ok: ${g}`),
      `CAM exported twice: ${man.reproducible.files} files identical after the date lines; Gerber render check passes`,
      j?.skipped ? `JLC files: ${j.skipped}` : `JLC BOM ${j?.bom_lines} lines / CPL ${j?.placements} placements; rotation differs from KiCad on ${j?.rotation_differs_from_kicad?.length ?? 0}; placement check ${j?.placement_check?.pass}/${j?.placement_check?.placements} pass (${j?.placement_check?.no_jlc_footprint.length ?? 0} without JLC footprint); no LCSC code: ${j?.no_lcsc_code?.join(", ") || "none"}`,
      `manifest.json holds the hashes of every file, the board and schematic hashes and the gate records.`,
    ].join("\n");
    return ok(text, { released: true, out, manifest: r.manifest });
  } catch (e) {
    if (e instanceof release.ReleaseStop) return ok(`NOT RELEASED (${e.gate}): ${e.message}`, { released: false, gate: e.gate, reason: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    throw e;
  } finally {
    job.release();
  }
}

export const board_release = defineTool({
  name: "board_release",
  toolset: "board",
  title: "Release: BOM and JLC rotations, Gerber check, readiness, fabrication package",
  description:
    "The release stage. bom: every BOM line to a manufacturable part with evidence (LCSC detail, JLC stock and library type, lifecycle, JLC's own footprint against ours, 3D model, height), RESOLVED / RISK / OWNER / PROPOSED / UNRESOLVED, and the CPL rotation JLC needs per part. gerb: Gerbers read by an independent reader and compared pixel for pixel with KiCad's plot, drill counts. check: where the release stands (interconnect, review, acceptance, via bindings, BOM), or with package: JLC's footprint simulated on that package's copper (proxies = same-package stand-ins). fab: the fabrication package, written only when the gates pass in order: interconnect (none for a standalone project), review settled for this exact board, A1-A9 with parity (an exception only with an owner decision), via-in-pad and microvias filled and capped; then CAM exported twice with identical hashes, Gerber render check, JLC BOM/CPL with every row simulated on our copper. A refused release is a result: it names the gate and writes nothing.",
  inputSchema: Input,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  longRunning: true,
  handler: async (args, ctx) => {
    const a = args as Args;
    return runDurable(ctx, "board_release", (c) => (a.action === "bom" ? bomAction(a, c) : a.action === "gerb" ? gerbAction(a, c) : a.action === "check" ? checkAction(a, c) : fabAction(a, c)));
  },
});

export const boardReleaseTools = [board_release];
void writeFile;

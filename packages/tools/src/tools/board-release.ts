/**
 * board_release: the release stage. One tool, six actions:
 *   bom    every BOM line to a manufacturable part with evidence, and the CPL rotation JLC's own footprint needs
 *   gerb   do the Gerbers show the board? (independent reader's render against KiCad's plot, drill counts)
 *   check  release readiness without writing a package; with `package`, JLC's footprint simulated on that package's copper
 *   fab    the fabrication package, refusing unless every gate passes in order
 *   vias   the vias the fab gate needs filled and capped (via-in-pad, microvias); with `apply`, set them (the toolkit's
 *          viaproc --apply) through adopt
 *   cam    the CAM set without the gates
 *
 * Overlaps `export_pos` (JLC rotations and pad-centre positions are emitted there too), `export_gerbers`/`export_drill`/
 * `export_zip` (fab exports twice, proves the files reproducible and checks them) and `release_build`'s fabrication
 * export (that one stays a non-blocking record; this is the hard gate). Nothing here shells out to a toolkit.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { applyProjectRules, CHECK_KEYS, locateProject, openReviewProject, readRequirements, release, reviewGate, runAcceptance, type AcceptRun } from "@fabdesk/board-workflow";
import { runDurable } from "../durable";
import { jailPath } from "../fs";
import { boardMemGiB, governor } from "../resources";
import { readAcceptanceState, readReviewGate } from "../board-state";
import { bomDirOf, readBomState, readLastFab, readProxies, releaseHome, sha256Of, writeBomMeta, writeLastFab, writeProxies } from "../release-state";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad, runLiveDrc } from "./common";
import { adoptCandidate } from "../board-adopt";
import { runKicadCli } from "@fabdesk/kicad";

/** The interconnect release gate of a host project (contracts between boards). Standalone Fabdesk projects have none. */
type InterconnectGate = (input: { projectDir: string }) => Promise<{ pass: boolean; text: string }>;
let interconnectGate: InterconnectGate | null = null;
export function setInterconnectGate(g: InterconnectGate | null): void {
  interconnectGate = g;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const Proxies = z.record(z.string(), z.object({ proxy: z.string(), why: z.string().optional() }));

const Input = {
  action: z.enum(["bom", "gerb", "check", "fab", "cam", "vias"]).describe("vias: every via whose drill meets SMD pad copper (via-in-pad) and every microvia needs (filling yes) (capping yes) (IPC-4761 Type VII) for the fab gate: lists them, which lack the attributes, and the pads they sit in; with apply: true, writes the two attributes on the missing ones (an attribute only, no geometry) into the project board through adopt (one KiCad commit, checkpointed) and checks the board again. Fill and cap is a fab process the order must name (costlier); moving a via out of the pad (board_edit / last mile) is the alternative. cam: the CAM set in `out` (default fab/) without the release gates, for a board the owner approved as it is or to look at the outputs: Gerbers plotted from a fresh zone fill, PTH/NPTH drill with maps, BOM (one row per value+footprint with its references), placement CSV, the Gerber render check and a README saying it is not a gated release. bom: part identity, stock, lifecycle, JLC footprint fit and CPL rotation per line. gerb: render check of Gerbers against KiCad's plot. check: release readiness (or JLC placement simulation of an existing package). fab: the fabrication package; refuses unless every gate passes."),
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
  out: z.string().optional().describe("fab: package folder, new, inside the project (default exports/release-<time>); cam: new or empty folder (default fab)."),
  accept: z.array(z.string()).default([]).describe('fab: owner-accepted exceptions "CHECK=FILE#ID" (e.g. A8_pairs=notes/decisions.json#pair-spacing): a failing acceptance check passes only with an owner decision of that id in the file; recorded in the manifest.'),
  cpl: z.string().optional().describe("fab: a reviewed placement CSV in the project (KiCad pos format with hand corrections) used for the JLC CPL; refs must match the JLC BOM."),
  step: z.boolean().default(true).describe("fab: include the STEP model."),
  apply: z.boolean().default(false).describe("vias: write (filling yes) (capping yes) on the vias that need them and lack them, into the project board (adopt); default only lists them."),
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
    // copper that fails against a fresh fill but matches the saved fills: the Gerbers were plotted from stale pours
    const badCu = Object.entries(r.layers).filter(([k, v]) => !v.pass && !v.error && k.endsWith("_Cu")).map(([k]) => k);
    let stale: string[] = [];
    if (badCu.length) {
      ctx.progress(0.8, "checking the failing copper against the saved zone fills");
      const r2 = await release.gerbCheck({ gerbers: dir, pcb: files.pcb, out: join(work, "check-saved-fills"), cli, dpi: a.dpi, signal: ctx.signal, checkZones: false, only: badCu });
      stale = badCu.filter((k) => r2.layers[k]?.pass);
    }
    const staleLine = stale.length
      ? [`CAUSE: ${stale.join(", ")} match the board's saved zone fills, not a fresh fill: the Gerbers were plotted from stale pours. Refill the zones before exporting (board_release fab and its CAM export refill; by hand: kicad-cli pcb export gerbers --check-zones, or kicad-cli pcb drc --refill-zones --save-board first). A fab builds what the Gerbers show.`]
      : [];
    const text = [`${r.pass ? "PASS" : "FAIL"} ${Object.values(r.layers).filter((v) => v.pass).length}/${Object.keys(r.layers).length} layers at ${a.dpi} dpi (a layer passes when the differences that survive a 1-pixel band are under 0.1 % of the drawn area)`, ...staleLine, ...rows, `drill: ${Object.entries(r.drill).map(([n, d]) => `${n} ${d.holes_or_slots} holes/slots, ${d.tools} tools`).join("; ") || "no drill files"}`, ...(r.unsupported.length ? [`reader limits: ${r.unsupported.join(", ")}`] : []), `Pictures of the differences (red: Gerber only, blue: KiCad only): ${relative(project.dir, join(work, "check"))}/diff-*.png`].join("\n");
    return ok(text, { pass: r.pass, layers: r.layers, drill: r.drill, dir: relative(project.dir, join(work, "check")), ...(stale.length ? { staleZoneFills: stale } : {}) });
  } finally {
    job.release();
  }
}

/**
 * The CAM set without the release gates (the eval's "approved as it is, produce the package" request: every arm that
 * exported by hand plotted stale zone fills). Same CAM path as `fab` (fresh fill, separate PTH/NPTH, maps), plus KiCad's
 * BOM and placement files and the render check; the README says what was and was not checked.
 */
async function camAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const cli = await requireKicad(ctx);
  const outRel = a.out ?? "fab";
  const out = await jailPath(project.dir, outRel);
  const existing = await readdir(out).catch(() => [] as string[]);
  if (existing.length) throw new ToolError(`${outRel} exists and is not empty: name a new folder with out`, "invalid_args");
  const job = await admit(ctx, "board_release cam", [files.pcb]);
  try {
    const gerbers = join(out, "gerbers"), drill = join(out, "drill"), asm = join(out, "assembly");
    await Promise.all([mkdir(gerbers, { recursive: true }), mkdir(drill, { recursive: true }), mkdir(asm, { recursive: true })]);
    ctx.progress(0.1, "Gerbers (fresh zone fill) and drill");
    await release.exportCam(cli, files.pcb, gerbers, release.requiredLayers(await readFile(files.pcb, "utf8")), ctx.signal);
    ctx.progress(0.4, "render check of the Gerbers against KiCad's plot");
    const chk = await release.gerbCheck({ gerbers, pcb: files.pcb, out: join(releaseHome(project.dir), `cam-${stamp()}`, "check"), cli, dpi: a.dpi, signal: ctx.signal });
    for (const n of await readdir(gerbers)) if (/\.drl$|-drl_map\./i.test(n)) await rename(join(gerbers, n), join(drill, n));
    ctx.progress(0.8, "BOM and placement");
    const sch = join(project.dir, `${files.stem}.kicad_sch`);
    const bom = join(asm, `${files.stem}-bom.csv`), pos = join(asm, `${files.stem}-pos.csv`);
    const o = ctx.signal ? { signal: ctx.signal } : {};
    await runKicadCli(cli, ["sch", "export", "bom", "--fields", "Reference,Value,Footprint,${QUANTITY},LCSC,MPN,Manufacturer", "--labels", "Designators,Value,Footprint,Qty,LCSC,MPN,Manufacturer", "--group-by", "Value,Footprint,LCSC,MPN", "--ref-range-delimiter", "", "--exclude-dnp", "--output", bom, sch], o);
    await runKicadCli(cli, ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp", "--output", pos, files.pcb], o);
    const passed = Object.entries(chk.layers).filter(([, v]) => v.pass).map(([k]) => k);
    const failed = Object.entries(chk.layers).filter(([, v]) => !v.pass).map(([k, v]) => `${k} ${((v.diff_share ?? 0) * 100).toFixed(2)} %`);
    const drills = Object.entries(chk.drill).map(([n, d]) => `${n} ${d.holes_or_slots} holes/slots`);
    const readme = [
      `# CAM set for ${files.stem}`,
      "",
      "Made by board_release cam: not a gated release (the review, A1-A9 acceptance, via processing and BOM part identity were not checked here; board_release fab is the release).",
      "",
      "- gerbers/: every copper, mask, silkscreen and paste layer and the outline, plotted after a fresh zone fill (kicad-cli --check-zones)",
      "- drill/: plated and non-plated Excellon files, separate, with drill maps",
      `- assembly/${files.stem}-bom.csv: one row per value + footprint with its references (DNP excluded)`,
      `- assembly/${files.stem}-pos.csv: reference, value, package, X, Y, rotation, side (mm, DNP excluded)`,
      "",
      `Render check against KiCad's plot of the board (${chk.dpi} dpi): ${chk.pass ? "PASS" : "FAIL"}; passing ${passed.join(", ")}${failed.length ? `; failing ${failed.join(", ")}` : ""}.`,
      `Drill: ${drills.join("; ")}.`,
      "",
    ].join("\n");
    await writeFile(join(out, "README.md"), readme);
    const list = [...(await readdir(gerbers)).map((n) => `gerbers/${n}`), ...(await readdir(drill)).map((n) => `drill/${n}`), `assembly/${files.stem}-bom.csv`, `assembly/${files.stem}-pos.csv`, "README.md"];
    return ok([`CAM set in ${outRel} (not a gated release; board_release fab is the release):`, ...list.map((n) => `  ${n}`), readme.split("\n").slice(-4, -1).join("\n")].join("\n"), { out: outRel, files: list, render: { pass: chk.pass, failing: failed }, drill: chk.drill });
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
    readAcceptanceState(project.dir, files.pcb),
    readReviewGate(project.dir, files.pcb),
    readBomState(project.dir, files.pcb),
    readFile(files.pcb, "utf8").then((t) => release.viaBindings(files.pcb, release.classifyVias(t))),
    readLastFab(project.dir),
  ]);
  const ic = interconnectGate ? await interconnectGate({ projectDir: project.dir }) : { pass: true, text: "none (standalone project)" };
  const accText = acc.state === "none" ? "not measured: board_check" : acc.state === "stale" ? "measured on an earlier board: board_check" : acc.pass ? "A1-A9 pass" : `failing ${acc.failing.join(", ")}`;
  const gateText = gate.state === "pass" ? "passes" : gate.state === "none" ? "not run" : gate.state === "stale" ? "stale (the design changed since: board_review run)" : gate.state === "errors" ? "check errors" : `${gate.open ?? "?"} findings open (${gate.mustFix ?? 0} must-fix)`;
  let bomReady = false;
  let bomProblem = "";
  if (bom.state === "current") {
    try {
      release.assertReleaseBom(JSON.parse(await readFile(join(bom.dir, "bom-decisions.json"), "utf8")), await readFile(files.pcb, "utf8"));
      if (!await sha256Of(join(bom.dir, "cpl-jlc.csv"))) throw new Error("BOM placement predictions missing: action bom");
      bomReady = true;
    } catch (error) { bomProblem = String(error); }
  }
  const bomText = bom.state === "none" ? "no BOM check: action bom" : bom.state === "stale" ? "BOM check is of an earlier board: action bom" : !bomReady ? bomProblem : `current (${bom.meta!.lines} lines, ${Object.entries(bom.meta!.summary).map(([k, v]) => `${k} ${v}`).join(", ")})`;
  const text = [
    `Release readiness for ${files.stem}:`,
    `1 interconnect gate: ${ic.pass ? "passes" : "STOP"} (${ic.text})`,
    `2 review gate: ${gateText}`,
    `3 acceptance: ${accText}`,
    `4 via-in-pad / microvia bindings: ${vias.record.counts.require_fill_cap} need fill+cap, ${vias.missing.length} missing natively`,
    `BOM / JLC rotations: ${bomText}`,
    last ? `Last package: ${relative(project.dir, last.out)} (${last.boardSha256 === (await sha256Of(files.pcb)) ? "of this board" : "of an earlier board"})` : "No package built yet.",
  ].join("\n");
  const ready = ic.pass && gate.state === "pass" && acc.pass && !vias.missing.length && bomReady;
  return ok(text, { ready, interconnect: ic, review: gate, acceptance: { state: acc.state, failing: acc.failing, pass: acc.pass }, vias: { ...vias.record.counts }, bom: { state: bom.state, ...(bom.meta ? { summary: bom.meta.summary } : {}) } });
}

async function fabAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const cli = await requireKicad(ctx);
  const out = a.out ? await jailPath(project.dir, a.out) : join(project.dir, "exports", `release-${stamp()}`);
  const proxies = { ...(await readProxies(project.dir)), ...(a.proxies ?? {}) };
  const bom = await readBomState(project.dir, files.pcb);
  const cpl = a.cpl ? await jailPath(project.dir, a.cpl) : undefined;
  const job = await admit(ctx, "board_release fab", [files.pcb]);
  try {
    // a bad exception (malformed, no owner decision, a file outside the project) is a refusal, not a tool error
    const accept = await Promise.all(a.accept.map((s) => release.resolveException(s, project.dir)));
    const r = await release.releaseFab({
      project: project.dir,
      stem: files.stem,
      pcb: files.pcb,
      schematic: (await sha256Of(join(project.dir, `${files.stem}.kicad_sch`))) ? join(project.dir, `${files.stem}.kicad_sch`) : null,
      out,
      cli,
      gates: {
        ...(interconnectGate ? { interconnect: () => interconnectGate!({ projectDir: project.dir }) } : {}),
        // computed live from the review records of this board (never the saved status reading)
        review: async () => {
          const g = await reviewGate(await openReviewProject(project.dir, files.pcb));
          return { state: g.state, open: g.open, mustFix: g.mustFix };
        },
        // the acceptance's net classes and rules on the project file before A1-A9 (no-op when the board keeps its native rules)
        rules: () => applyProjectRules(project.dir, files.pcb),
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
    // saved with the project only once the release went through (a refused release writes nothing)
    if (a.proxies) await writeProxies(project.dir, proxies);
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

const viaLine = (v: release.ViaClass) => `${v.type} via ${v.net || "(no net)"} @ ${v.xy.join(",")} drill ${v.drill_mm}${v.in_component_lands.length ? ` in ${v.in_component_lands.join(", ")}` : ""}${v.native_filling && v.native_capping ? " (filled+capped)" : ""}`;

/**
 * board_release vias (the toolkit's flow/viaproc.py; `apply` = `--apply`): the vias the fab gate needs filled and capped,
 * and with `apply` the attributes written into the project board as an adopted candidate.
 */
async function viasAction(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const text = await readFile(files.pcb, "utf8");
  const { record, missing } = release.viaBindings(files.pcb, release.classifyVias(text));
  const c = record.counts;
  const head = `Vias: ${c.vias} (${c.through} through, ${c.micro} micro); ${c.via_in_pad} in pads; ${c.require_fill_cap} need fill+cap, ${missing.length} lack it${c.filled_not_required ? `; ${c.filled_not_required} filled or capped without needing it` : ""}.`;
  const rule = `Rule: ${record.rule}`;
  if (!missing.length)
    return ok([head, record.bindings.length ? "Every via that needs fill+cap has it: the fab gate's via step passes." : "No via needs fill+cap.", rule].join("\n"), { counts: c, missing: [], bindings: record.bindings });
  const list = lines(missing.map((v) => `- ${viaLine(v)}`), 30);
  if (!a.apply)
    return ok([head, "Missing (filling yes) (capping yes):", ...list, rule, 'board_release {"action": "vias", "apply": true} writes them into the board (the fab order must then ask for filled and capped vias); or move the vias out of the pads.'].join("\n"), {
      counts: c,
      missing: missing.map(({ span_: _s, ...v }) => v),
      bindings: record.bindings,
    });
  const dir = join(releaseHome(project.dir), "vias");
  await mkdir(dir, { recursive: true });
  const cand = join(dir, `${files.stem}.kicad_pcb`);
  await writeFile(cand, release.applyViaBindings(text, missing));
  const reason = `via fill+cap: (filling yes) (capping yes) on ${missing.length} via(s) in pads or microvias`;
  const ad = await adoptCandidate(ctx, { candidate: cand, board: relative(project.dir, files.pcb), reason });
  const after = release.viaBindings(files.pcb, release.classifyVias(await readFile(files.pcb, "utf8")));
  await writeFile(join(dir, "via-process-bindings.json"), JSON.stringify(after.record, null, 1) + "\n");
  return ok(
    [
      head,
      `${reason}:`,
      ...list,
      ad.text,
      after.missing.length
        ? `STILL MISSING after the adopt: ${after.missing.length} via(s): ${after.missing.slice(0, 6).map(viaLine).join("; ")}`
        : "Checked again: every via that needs fill+cap has it. The fab order must ask for filled and capped vias (IPC-4761 Type VII).",
    ].join("\n"),
    { counts: c, applied: missing.length, stillMissing: after.missing.length, bindings: relative(project.dir, join(dir, "via-process-bindings.json")), adopt: ad.data },
  );
}

export const board_release = defineTool({
  name: "board_release",
  toolset: "board",
  title: "Release: BOM and JLC rotations, Gerber check, readiness, fabrication package",
  description:
    "The release stage. bom: every BOM line to a manufacturable part with evidence (LCSC detail, JLC stock and library type, lifecycle, JLC's own footprint against ours, 3D model, height), RESOLVED / RISK / OWNER / PROPOSED / UNRESOLVED, and the CPL rotation JLC needs per part. gerb: Gerbers read by an independent reader and compared pixel for pixel with KiCad's plot, drill counts. vias: the vias in pads and microvias that need (filling yes) (capping yes), and with apply: true the attributes written into the board (adopt), so the fab gate's via step can pass. check: where the release stands (interconnect, review, acceptance, via bindings, BOM), or with package: JLC's footprint simulated on that package's copper (proxies = same-package stand-ins). fab: the fabrication package, written only when the gates pass in order: interconnect (none for a standalone project), review settled for this exact board, A1-A9 with parity (an exception only with an owner decision), via-in-pad and microvias filled and capped; then CAM exported twice with identical hashes, Gerber render check, JLC BOM/CPL with every row simulated on our copper. A refused release is a result: it names the gate and writes nothing (the package is built in a temporary folder and moved into place only when every check passed; proxies are saved only with a release).",
  inputSchema: Input,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  longRunning: true,
  handler: async (args, ctx) => {
    const a = args as Args;
    return runDurable(ctx, "board_release", (c) => (a.action === "bom" ? bomAction(a, c) : a.action === "gerb" ? gerbAction(a, c) : a.action === "check" ? checkAction(a, c) : a.action === "cam" ? camAction(a, c) : a.action === "vias" ? viasAction(a, c) : fabAction(a, c)));
  },
});

export const boardReleaseTools = [board_release];
void writeFile;

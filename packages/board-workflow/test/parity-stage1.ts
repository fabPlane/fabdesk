/**
 * Stage 1 parity: the toolkit's Python oracle against @fabdesk/board-workflow on one board.
 *
 *   bun packages/board-workflow/test/parity-stage1.ts --board DIR --out DIR [--kicad-cli PATH] [--toolkit DIR]
 *
 * Not part of `bun run test` (it needs the Python toolkit and kicad-cli). One DRC run feeds both sides;
 * a second live run goes through the TypeScript DRC path to prove the wiring. Writes parity.json and
 * stage1-parity.md into --out.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { checkAcceptance, drcInputFromFile, figures, onboard, parseBoard, readRequirements, runAcceptance, type DrcInput, type Requirements } from "../src/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    out: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    drc: { type: "string" },
    "no-stress": { type: "boolean", default: false },
  },
});
if (!a.board || !a.out) throw new Error("--board and --out are required");
const out = a.out;
const toolkit = a.toolkit!;
const cliPath = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
const proj = join(out, "proj");
await mkdir(proj, { recursive: true });
for (const n of await readdir(a.board)) {
  if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty"))
    await cp(join(a.board, n), join(proj, n), { recursive: true });
}
const pcbName = (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!;
const stem = pcbName.replace(/\.kicad_pcb$/, "");
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: cliPath };

async function sh(cmd: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2000)}`);
  return o;
}

const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown) => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 400));
};

// ---- onboard: oracle then TypeScript, on the same board
const pyOut = join(out, "py-onboard");
await sh(["python3", join(toolkit, "bin/pcb"), "onboard", join(proj, pcbName), "parity", "--out", pyOut]);
const tsRes = await onboard(proj, { name: "parity" });
const py = async (f: string) => JSON.parse(await readFile(join(pyOut, "requirements", f), "utf8"));
const PROSE = new Set(["basis", "purpose", "native_project_rules_basis", "tap_rule", "note"]);
function diff(x: unknown, y: unknown, path: string, acc: string[], prose: string[]): void {
  if (typeof x === "number" && typeof y === "number") {
    if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) acc.push(`${path}: ${x} != ${y}`);
  } else if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) acc.push(`${path}: length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diff(x[i], y[i], `${path}[${i}]`, acc, prose);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    const kx = Object.keys(x as object), ky = Object.keys(y as object);
    for (const k of new Set([...kx, ...ky])) {
      if (!(k in (x as object))) acc.push(`${path}.${k}: only in TS`);
      else if (!(k in (y as object))) acc.push(`${path}.${k}: only in oracle`);
      else if (PROSE.has(k) && typeof (x as never)[k] === "string") {
        if ((x as never)[k] !== (y as never)[k]) prose.push(`${path}.${k}`);
      } else diff((x as never)[k], (y as never)[k], `${path}.${k}`, acc, prose);
    }
  } else if (x !== y) acc.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
}
const proseDiffs: string[] = [];
let anchorMax = 0;
for (const k of ["acceptance", "circuit", "mechanical", "heights"] as const) {
  const d: string[] = [];
  const oracle = await py(`${k}.json`);
  if (k === "mechanical")
    // the oracle writes anchors with %g (6 significant digits); TS keeps micron precision. Compare as numbers.
    oracle.anchors.forEach((an: { at: string[]; rotation: string[] }, i: number) => {
      const t = tsRes.requirements.mechanical.anchors[i]!;
      for (const [x, y] of [...an.at.map((v, j) => [v, t.at[j]!]), [an.rotation[0]!, t.rotation[0]]] as Array<[string, string]>) anchorMax = Math.max(anchorMax, Math.abs(Number(x) - Number(y)));
      an.at = [...t.at];
      an.rotation = [...t.rotation];
    });
  diff(oracle, tsRes.requirements[k], k, d, proseDiffs);
  record(`onboard ${k}.json`, d.length === 0, d.slice(0, 10));
}
record("onboard anchor coordinates: max |oracle %g - TS| (mm), tolerance 1e-4", anchorMax < 1e-4, anchorMax);
const pyAcc = await py("acceptance.json");
record("onboard fixed parts", JSON.stringify(tsRes.fixed) === JSON.stringify(pyAcc && (await py("mechanical.json")).anchors.map((x: { reference: string }) => x.reference)), tsRes.fixed.length);

// ---- DRC once (shared), then A1-A9
const drcFile = join(out, "oracle.drc.json");
const t0 = Date.now();
if (a.drc) await cp(a.drc, drcFile);
else await sh([cliPath, "pcb", "drc", "--format", "json", "--schematic-parity", "--refill-zones", "-o", drcFile, join(proj, pcbName)]);
const drcSecs = (Date.now() - t0) / 1000;
const rawDrc = JSON.parse(await readFile(drcFile, "utf8"));
const drcIn: DrcInput = {
  violations: (rawDrc.violations ?? []).map((v: { type: string; severity: string; description: string }) => ({ rule: v.type, severity: v.severity, description: v.description })),
  unconnected: (rawDrc.unconnected_items ?? []).length,
  parity: (rawDrc.schematic_parity ?? []).length,
};

type Variant = { name: string; req: Requirements; pcb: string; note: string };
const variants: Variant[] = [];
const text = await readFile(join(proj, pcbName), "utf8");
const baseReq = (await readRequirements(proj))!;
variants.push({ name: "as-onboarded", req: baseReq, pcb: pcbName, note: "the board against requirements onboarded from it" });

// stressed variant: edited requirements + a mutated board, so the failing paths are compared too
const board0 = parseBoard(text);
const req2: Requirements = JSON.parse(JSON.stringify(baseReq));
const acc2 = req2.acceptance;
const byNet = new Map<string, number>();
for (const s of board0.segments) byNet.set(s.net, (byNet.get(s.net) ?? 0) + 1);
const isPairNet = new Set(Object.values(acc2.net_classes.classes).flatMap((c) => (c.pairs ?? []).flat()));
const powerNets = [...byNet].filter(([n]) => !isPairNet.has(n) && n).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([n]) => n);
const widest = Math.max(...board0.segments.filter((s) => powerNets.includes(s.net)).map((s) => s.w));
acc2.net_classes.classes["PWR_STRESS"] = { source_class: "stress", track_width: widest + 0.2, inner_track_width: widest + 0.2, nets: powerNets, basis: "parity stress" };
acc2.net_classes.tap_pads = { ...acc2.net_classes.tap_pads, [powerNets[0]!]: Object.fromEntries(board0.pads.filter((p) => p.net === powerNets[0]).slice(0, 3).map((p) => [`${p.ref}.${p.pad}`, { width: widest, basis: "stress" }])) };
acc2.net_classes.net_current_A = { [powerNets[1]!]: 1.5 };
acc2.net_classes.neck_scaling = { cap_mm: 3, ref_width_mm: 0.2, ref_current_A: 1 };
const firstPair = Object.values(acc2.net_classes.classes).find((c) => c.pairs?.length)!;
firstPair.diff_pair_width = firstPair.diff_pair_width! + 0.05;
acc2.stack_policy.plane_layers = [board0.copperLayers[1]!];
acc2.stack_policy.no_track_layers = [board0.copperLayers[1]!, board0.copperLayers[2]!];
acc2.stack_policy.via_spans = { through: [board0.copperLayers[0]!, board0.copperLayers[0]!] };
acc2.heights = { F_max_mm: 3, B_max_mm: 2, basis: "stress" };
const refs = [...board0.footprints.keys()];
req2.heights.entries = refs.slice(0, 40).map((r, i) => ({ ref: r, height_above_surface_mm: i % 3 === 0 ? 4.5 : 1.0 }));
acc2.value_exceptions = [refs[3]!];
const anchor = req2.mechanical.anchors[0]!;
req2.mechanical.anchors[1]!.at = [String(Number(req2.mechanical.anchors[1]!.at[0]) + 0.3), req2.mechanical.anchors[1]!.at[1]];
req2.circuit.components[5]!.value = "STRESS-VALUE";
req2.circuit.components[7]!.pins = { ...req2.circuit.components[7]!.pins, "1": "NO_SUCH_NET" };
req2.circuit.components.push({ reference: "ZZ999", value: "x", pins: {} });
void anchor;
if (!a["no-stress"]) variants.push({ name: "stressed", req: req2, pcb: pcbName, note: "edited requirements: power class + tap + currents + neck scaling, pair width, planes/no-track layers, via span, heights, exceptions, moved anchor, changed value/pins, missing part" });

const pyCheck = async (v: Variant) => {
  const dir = join(out, `py-${v.name}`);
  await mkdir(join(dir, "requirements"), { recursive: true });
  const acc = JSON.parse(JSON.stringify(v.req.acceptance));
  for (const k of ["circuit", "mechanical", "heights"] as const) await writeFile(join(dir, "requirements", `${k}.json`), JSON.stringify(v.req[k]));
  await writeFile(join(dir, "requirements", "acceptance.json"), JSON.stringify(acc));
  const spec = join(dir, "spec.json");
  await writeFile(spec, JSON.stringify({ name: v.name, stem, base: proj, requirements: join(dir, "requirements"), fixed: "^$" }));
  const o = join(dir, "accept.json");
  await sh(["python3", join(toolkit, "tools/check_acceptance.py"), join(proj, v.pcb), o, "--drc", drcFile], { FLOW_SPEC: spec, PCB_PROJECT: dir });
  return JSON.parse(await readFile(o, "utf8"));
};
const norm = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? v : v)));
for (const v of variants) {
  const pyR = await pyCheck(v);
  const ts = checkAcceptance(board0, v.req, drcIn, { boardPath: join(proj, v.pcb) });
  const summaryOk = JSON.stringify(pyR.summary) === JSON.stringify(ts.summary);
  record(`${v.name}: summary`, summaryOk, { py: pyR.summary, ts: ts.summary });
  for (const key of Object.keys(pyR.results)) {
    const d: string[] = [];
    diff(pyR.results[key], norm(ts.results[key as keyof typeof ts.results]), key, d, proseDiffs);
    record(`${v.name}: ${key}`, d.length === 0, d.slice(0, 8));
  }
  (v as Variant & { figs?: unknown }).figs = figures(ts);
  (v as Variant & { verdicts?: unknown }).verdicts = ts.summary;
}

// ---- live TypeScript DRC path (kicad-cli through @fabdesk/kicad), recorded as a history entry
const live = { path: cliPath, version: "unknown" };
const t1 = Date.now();
const run = await runAcceptance(proj, a.drc ? { drc: async () => drcIn } : {
  drc: async ({ board, parity, outFile }) => {
      // the DRC board_check runs: project severities, owner-excluded items dropped (same as the oracle's flags)
      await runDrc(live, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
      return drcInputFromFile(outFile);
    },
  });
const liveSecs = (Date.now() - t1) / 1000;
if (!a.drc) {
  // for the record: what `--severity-all` would have given (the old board_check path)
  const allFile = join(out, "severity-all.drc.json");
  await runDrc(live, { board: join(proj, pcbName), outFile: allFile, severity: "all", schematicParity: true, refillZones: true });
  const allIn = await drcInputFromFile(allFile);
  const rawAll = JSON.parse(await readFile(allFile, "utf8"));
  const sev = checkAcceptance(board0, baseReq, { violations: (rawAll.violations ?? []).map((v: { type: string; severity: string; description: string }) => ({ rule: v.type, severity: v.severity, description: v.description })), unconnected: (rawAll.unconnected_items ?? []).length, parity: (rawAll.schematic_parity ?? []).length }, { boardPath: join(proj, pcbName) });
  const oracleA2 = checkAcceptance(board0, baseReq, drcIn, { boardPath: join(proj, pcbName) }).results.A2_drc;
  const liveA2 = run.result.results.A2_drc;
  console.log("A2 oracle DRC:", JSON.stringify(oracleA2), "\nA2 live project severity:", JSON.stringify(liveA2), "\nA2 live --severity-all raw:", JSON.stringify(sev.results.A2_drc), "\nexcluded-filtered --severity-all input A2 count:", allIn.violations.length);
  record("live project-severity A2 equals oracle A2", JSON.stringify(oracleA2) === JSON.stringify(liveA2), { oracle: oracleA2, live: liveA2 });
}
record(`${a.drc ? "recorded" : "live"} TS DRC path: summary equals oracle-DRC summary`, JSON.stringify(run.result.summary) === JSON.stringify(checkAcceptance(board0, baseReq, drcIn).summary), run.result.summary);
const rerun = await runAcceptance(proj, { drc: async () => drcIn });
record("history: second run compares with baseline", !!rerun.baseline || !!rerun.previous, { baseline: rerun.baseline?.newFailures, previous: rerun.previous?.newFailures });

await writeFile(join(out, "parity.json"), JSON.stringify({ rows, proseDiffs, drcSecs, liveSecs, variants: variants.map((v) => ({ name: v.name, note: v.note, verdicts: (v as never as { verdicts: unknown }).verdicts, figures: (v as never as { figs: unknown }).figs })), counts: tsRes.record.counts }, null, 1));
const md = [
  `# Stage 1 parity: ${stem}`,
  "",
  `Board: \`${a.board}\` (${board0.footprints.size} footprints, ${board0.segments.length} segments, ${board0.vias.length} vias). Oracle: ${toolkit}. kicad-cli: ${cliPath}.`,
  `One DRC run (${drcSecs.toFixed(1)} s) feeds both sides; the live TypeScript DRC path took ${liveSecs.toFixed(1)} s end to end.`,
  "",
  "| item | agrees | detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.item} | ${r.agree ? "yes" : "NO"} | ${r.agree ? "" : "`" + JSON.stringify(r.detail).slice(0, 300).replace(/\|/g, "/") + "`"} |`),
  "",
  `Free-text fields that differ (wording only, compared apart): ${proseDiffs.length ? proseDiffs.join(", ") : "none"}.`,
  "",
  ...variants.flatMap((v) => [`## ${v.name}`, v.note, "", "```json", JSON.stringify({ verdicts: (v as never as { verdicts: unknown }).verdicts, figures: (v as never as { figs: unknown }).figs }), "```", ""]),
].join("\n");
await writeFile(join(out, "stage1-parity.md"), md);
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} agree`);
process.exit(rows.every((r) => r.agree) ? 0 : 1);

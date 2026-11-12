/**
 * Pair-op parity: the toolkit's `pairfix.py run --ops X` against the TypeScript tighten step (runTighten) with the same ops,
 * op by op and as the default six-op chain, on one routed board.
 *
 *   bun packages/board-workflow/test/parity-pairops.ts --board DIR --spec SPEC.json --out DIR
 *       [--runs "vias;mirror;mirror-force;retune;skew;vias,mirror,retune,width,tighten,skew"] [--pairs REGEX]
 *       [--toolkit DIR] [--toolkit2 DIR] [--pyseed N] [--kicad-cli PATH]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli). Both sides start from the same scored board (the oracle's
 * `lastmile new`, the TypeScript `Bench.create`) and read the same requirements (the spec's folder). Per run it compares each
 * pass's report (vias, mirror, retune, skew: rounds, applied, refused, skip reasons), the width/tighten rounds and groups, per-pair
 * coupled share and length difference before/after, the scored figures of both edited boards (A8, DRC, open, per pair), the
 * edited boards' segments and vias, and the wall time. --toolkit2 also runs the six-op chain with a second toolkit checkout and
 * compares the two oracles. Writes parity.json and pairops-parity.md into --out.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { lastmile as L } from "../src/index";
import type { Requirements } from "../src/requirements";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    spec: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "vias;mirror;mirror-force;retune;skew;vias,mirror,retune,width,tighten,skew" },
    pairs: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    toolkit2: { type: "string" },
    pyseed: { type: "string" },
  },
});
if (!a.board || !a.out || !a.spec) throw new Error("--board, --spec and --out are required");
const out = a.out;
const tk = a.toolkit!;
const cli = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const spec = JSON.parse(await readFile(a.spec, "utf8"));
const pcb = `${spec.stem ?? "board"}.kicad_pcb`;
// --pyseed N: PYTHONHASHSEED for the oracle (its retune walk starts at the end a Python set yields first; a seed that matches ours writes the chains in our direction)
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: cli, FLOW_SPEC: a.spec, ...(a.pyseed ? { PYTHONHASHSEED: a.pyseed } : {}) };
async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2000)}`);
  return o;
}
const rows: Array<{ run: string; item: string; agree: boolean; detail: unknown }> = [];
const record = (run: string, item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ run, item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} [${run}] ${item}`, agree ? (typeof detail === "string" && detail ? detail : "") : JSON.stringify(detail).slice(0, 900));
};
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
/** Drop timing fields (drc_s, wall_s) anywhere in a report. */
const untimed = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(untimed) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "drc_s" && k !== "wall_s").map(([k, v]) => [k, untimed(v)])) : x;

// ---- requirements as the oracle reads them (the spec's folder)
const rd = spec.requirements as string;
const [acceptance, circuit, mechanical, heights] = await Promise.all(["acceptance", "circuit", "mechanical", "heights"].map(async (k) => JSON.parse(await readFile(join(rd, `${k}.json`), "utf8"))));
const req = { acceptance, circuit, mechanical, heights } as Requirements;
// the toolkit leaves hole_clearance out of every board's figures (the carrier's USB-C shell pads); a board declares that
req.acceptance.lastmile = { ...req.acceptance.lastmile, inherited_drc: ["hole_clearance"] };
const drc: L.DrcFn = async ({ board, parity, outFile }) => {
  const r = await runDrc({ path: cli, version: "" } as never, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
  return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
};
const scorer = L.createScorer(req, drc);
const engine: L.StepEngine = { run: async (step, input) => (step.type === "pairfix" ? L.runTighten({ step, input, req, drc }) : { error: "no router engine in the parity harness" }) };

// ---- the same scored start board on both sides
const pySrc = join(out, "py-src");
await cp(a.board, pySrc, { recursive: true });
const pyWs = join(out, "py-ws");
await sh(["python3", join(tk, "bin/pcb"), "lastmile", "new", pyWs, pySrc]);
const pyState = JSON.parse(await readFile(join(pyWs, "state.json"), "utf8"));
const { bench } = await L.Bench.create(join(out, "ts-ws"), a.board, pcb, { scorer, engine });
const pyFig0 = pyState.history[0].figures as L.Figures;
const figKeys = ["open", "drc", "a7", "a8", "pairs_todo", "pairs"] as const;
for (const k of figKeys) record("start", `figures.${k}`, same(bench.figures[k], pyFig0[k]), k === "pairs" ? "" : { py: pyFig0[k], ts: bench.figures[k] });
record("start", `A8 at start: oracle ${pyFig0.a8}, TypeScript ${bench.figures.a8}`, pyFig0.a8 === bench.figures.a8);

const pyFigures = async (dir: string) =>
  JSON.parse(await sh(["python3", "-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(join(tk, "tools"))}); import lastmile; from pathlib import Path; print(json.dumps(lastmile.figures(Path(${JSON.stringify(dir)}))))`])) as L.Figures;
/** Segments as copper: ends in either order (the oracle walks a retune chain from the end a Python set yields first, which varies with the hash seed). */
const segSet = (t: string) =>
  new Set(L.readSegments(t).map((s) => `${s.net}|${s.layer}|${[s.a, s.b].map((p) => p.map((v) => v.toFixed(3)).join(",")).sort().join("|")}|${s.w}`));
const dirSet = (t: string) => new Set(L.readSegments(t).map((s) => `${s.net}|${s.layer}|${s.a.map((v) => v.toFixed(3))}|${s.b.map((v) => v.toFixed(3))}|${s.w}`));
const viaSet = (t: string) => new Set(L.readVias(t).map((v) => `${v.net}|${v.xy.map((x) => x.toFixed(3))}|${v.size}|${v.layers.join(",")}`));
const diffSets = (x: Set<string>, y: Set<string>) => ({ onlyPy: [...x].filter((v) => !y.has(v)), onlyTs: [...y].filter((v) => !x.has(v)) });

const summary: Array<Record<string, unknown>> = [];
for (const ops of a.runs!.split(";")) {
  const slug = ops.replace(/,/g, "+");
  const pairsArg = a.pairs ? ["--pairs", a.pairs] : [];
  const pyOut = join(out, `py-${slug}`);
  const tp = Date.now();
  await sh(["python3", join(tk, "tools/pairfix.py"), "run", join(pyWs, "s0"), pyOut, "--ops", ops, "--score", ...pairsArg]);
  const pySec = (Date.now() - tp) / 1000;
  const py = JSON.parse(await readFile(join(pyOut, "pairfix.json"), "utf8"));
  const tsOut = join(out, `ts-${slug}`);
  const tt = Date.now();
  const r = await L.runTighten({
    step: { type: "pairfix", args: ["--ops", ops, ...pairsArg] },
    input: { cur: join(out, "ts-ws", "s0"), out: tsOut, start: join(out, "ts-ws", "s0"), pcb, signal: new AbortController().signal },
    req,
    drc,
  });
  const tsSec = (Date.now() - tt) / 1000;
  if ("error" in r) {
    record(ops, "TypeScript step", false, r.error);
    continue;
  }
  const ts = (r.info as { pairfix: Record<string, unknown> }).pairfix;
  for (const pass of ["vias", "mirror", "retune", "skew"] as const) {
    if (py[pass] === null && ts[pass] === null) continue;
    const pp = untimed(py[pass]) as Record<string, unknown>;
    const tp2 = untimed(ts[pass]) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(pp ?? {}), ...Object.keys(tp2 ?? {})])) record(ops, `${pass}.${k}`, same(pp?.[k], tp2?.[k]), { py: pp?.[k], ts: tp2?.[k] });
  }
  const tr = (rs: Array<Record<string, unknown>>) => rs.map((x) => ({ round: x["round"], active_groups: x["active_groups"], width_changes: x["width_changes"], jogs: x["jogs"], new_items: x["new_items"], new_types: x["new_types"] }));
  record(ops, "width/tighten rounds (groups, widths, jogs, new DRC by type)", same(tr(py.rounds), tr(ts["rounds"] as never)), { py: tr(py.rounds), ts: tr(ts["rounds"] as never) });
  for (const k of ["final_new_drc", "groups_planned", "groups_applied", "group_modes", "groups_reverted", "groups_invalid_geometry", "width_planned", "width_applied", "collateral_items"] as const)
    record(ops, k, same(py[k], ts[k]), { py: py[k], ts: ts[k] });
  const pba = ts["pairs_before_after"] as Record<string, { share: number[]; len_diff: number[] }>;
  const cmp = Object.keys(py.pairs_before_after).map((k) => ({ k, py: { share: py.pairs_before_after[k].share, len_diff: py.pairs_before_after[k].len_diff }, ts: pba[k] }));
  const bs = cmp.filter((c) => !same(c.py.share, c.ts?.share) || !same(c.py.len_diff, c.ts?.len_diff));
  record(ops, `per-pair coupled share and length difference, before and after (${cmp.length} pairs)`, !bs.length, bs);
  // scored figures of each edited board: the oracle's own scorer for its board, the TypeScript scorer for ours
  const pyFig = await pyFigures(join(pyOut, "score"));
  const tsSc = await scorer.score(tsOut, pcb, { parity: false });
  for (const k of figKeys) record(ops, `edited board figures.${k}`, same(pyFig[k], tsSc.figures[k]), k === "pairs" ? diffPairs(pyFig.pairs, tsSc.figures.pairs) : { py: pyFig[k], ts: tsSc.figures[k] });
  const pyTxt = await readFile(join(pyOut, "edited", pcb), "utf8");
  const tsTxt = await readFile(join(tsOut, pcb), "utf8");
  const sd = diffSets(segSet(pyTxt), segSet(tsTxt));
  record(ops, `edited boards' segments (net, layer, ends to 1 um, width); ${segSet(pyTxt).size} vs ${segSet(tsTxt).size}`, !sd.onlyPy.length && !sd.onlyTs.length, { onlyPy: sd.onlyPy.length, onlyTs: sd.onlyTs.length, ex: [sd.onlyPy.slice(0, 3), sd.onlyTs.slice(0, 3)] });
  const dd = diffSets(dirSet(pyTxt), dirSet(tsTxt));
  record(ops, `segments with direction: ${dd.onlyPy.length} written start/end swapped (retune chains walked from the other end; same copper)`, true);
  const vd = diffSets(viaSet(pyTxt), viaSet(tsTxt));
  record(ops, `edited boards' vias (net, at to 1 um, size, layers); ${viaSet(pyTxt).size} vs ${viaSet(tsTxt).size}`, !vd.onlyPy.length && !vd.onlyTs.length, { onlyPy: vd.onlyPy.slice(0, 4), onlyTs: vd.onlyTs.slice(0, 4) });
  record(ops, `timing: oracle ${pySec.toFixed(1)} s (incl. --score), TypeScript ${tsSec.toFixed(1)} s (passes ${JSON.stringify(ts["pass_s"])})`, true);
  summary.push({ ops, a8: [pyFig0.a8, pyFig.a8, tsSc.figures.a8], drc: [pyFig.drc, tsSc.figures.drc], py_s: pySec, ts_s: tsSec, worst_dl: [worstDl(pyFig.pairs), worstDl(tsSc.figures.pairs)] });

  if (a.toolkit2 && ops.split(",").length === 6) {
    const p2 = join(out, `py2-${slug}`);
    await sh(["python3", join(a.toolkit2, "tools/pairfix.py"), "run", join(pyWs, "s0"), p2, "--ops", ops, ...pairsArg]);
    const py2 = JSON.parse(await readFile(join(p2, "pairfix.json"), "utf8"));
    const strip = (x: Record<string, unknown>) => untimed(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "src")));
    record(ops, `oracles agree: ${tk} vs ${a.toolkit2} (pairfix.json without timing)`, same(strip(py), strip(py2)), "");
    const s2 = diffSets(segSet(pyTxt), segSet(await readFile(join(p2, "edited", pcb), "utf8")));
    record(ops, "oracles agree: edited boards' segments", !s2.onlyPy.length && !s2.onlyTs.length, s2.onlyPy.length + s2.onlyTs.length);
  }
}

function diffPairs(x: Record<string, L.PairFigure>, y: Record<string, L.PairFigure>) {
  return Object.keys({ ...x, ...y }).filter((k) => !same(x[k], y[k])).map((k) => ({ k, py: x[k], ts: y[k] }));
}
function worstDl(p: Record<string, L.PairFigure>) {
  return Math.max(0, ...Object.values(p).map((v) => v[1]));
}

await writeFile(join(out, "parity.json"), JSON.stringify({ rows, summary }, null, 1));
const md = [
  "# Pair-op parity: pairfix.py vs TypeScript",
  "",
  `Board \`${a.board}\`, spec \`${a.spec}\`. Oracle ${tk}${a.pyseed ? ` (PYTHONHASHSEED ${a.pyseed})` : ""}. kicad-cli ${cli}.`,
  "",
  "| ops | A8 start | A8 oracle | A8 TS | DRC oracle | DRC TS | worst dL oracle | worst dL TS | oracle s | TS s |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...summary.map((s) => {
    const [a0, ap, at] = s["a8"] as number[];
    const [dp, dt] = s["drc"] as unknown[];
    const [wp, wt] = s["worst_dl"] as number[];
    return `| ${s["ops"]} | ${a0} | ${ap} | ${at} | ${JSON.stringify(dp)} | ${JSON.stringify(dt)} | ${wp} | ${wt} | ${(s["py_s"] as number).toFixed(1)} | ${(s["ts_s"] as number).toFixed(1)} |`;
  }),
  "",
  "| run | item | agrees | detail |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.run} | ${r.item} | ${r.agree ? "yes" : "NO"} | ${r.agree ? "" : "`" + JSON.stringify(r.detail).slice(0, 300).replace(/\|/g, "/") + "`"} |`),
].join("\n");
await writeFile(join(out, "pairops-parity.md"), md + "\n");
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} agree`);

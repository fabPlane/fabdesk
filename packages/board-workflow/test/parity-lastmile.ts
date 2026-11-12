/**
 * Last-mile parity: the toolkit's Python oracle against @fabdesk/board-workflow's lastmile on one routed board.
 *
 *   bun packages/board-workflow/test/parity-lastmile.ts --board DIR --spec SPEC.json --out DIR [--kicad-cli PATH] [--toolkit DIR] [--tighten REGEX]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli). Compares: `lastmile new` figures (opens, DRC, A7, A8,
 * pairs to re-route, per-pair coupling), `pairfix measure --why` line by line, `crossing_check` rows, the gate on randomised
 * figure pairs, and (with --tighten) `pairfix run --ops width,tighten` against the TypeScript tighten step. Routers are not
 * compared: the TypeScript bench runs the host's routers, not KRT. Writes parity.json and lastmile-parity.md into --out.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { lastmile as L, onboard, parseBoard, profile, readRequirements } from "../src/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    spec: { type: "string" },
    out: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    tighten: { type: "string" },
    gap: { type: "string" },
  },
});
if (!a.board || !a.out || !a.spec) throw new Error("--board, --spec and --out are required");
const out = a.out;
const tk = a.toolkit!;
const cli = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// --gap F: both sides read requirements whose pair classes have diff_pair_gap F (a board "laid out to other rules": pairs to tighten or loosen)
let specPath = a.spec;
const stress = a.gap ? Number(a.gap) : null;
if (stress !== null) {
  const spec0 = JSON.parse(await readFile(a.spec, "utf8"));
  const root = join(out, "stress"); // authority paths in acceptance.json are relative to the folder holding requirements/
  await cp(dirname(spec0.requirements), root, { recursive: true });
  const reqDir = join(root, "requirements");
  const acc = JSON.parse(await readFile(join(reqDir, "acceptance.json"), "utf8"));
  for (const c of Object.values(acc.net_classes.classes) as Array<{ pairs?: unknown[]; diff_pair_gap?: number }>) if (c.pairs?.length) c.diff_pair_gap = stress;
  await writeFile(join(reqDir, "acceptance.json"), JSON.stringify(acc, null, 1));
  specPath = join(out, "spec-stress.json");
  await writeFile(specPath, JSON.stringify({ ...spec0, requirements: reqDir }));
}
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: cli, FLOW_SPEC: specPath };
async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2000)}`);
  return o;
}
const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 600));
};

// ---- the two projects from the same files
const pySrc = join(out, "py-src");
const tsProj = join(out, "ts-proj");
await cp(a.board, pySrc, { recursive: true });
await cp(a.board, tsProj, { recursive: true });
const pcb = "board.kicad_pcb";

// ---- oracle: lastmile new, then figures
const pyWs = join(out, "py-ws");
const t0 = Date.now();
const pyNew = (await sh(["python3", join(tk, "bin/pcb"), "lastmile", "new", pyWs, pySrc])).trim();
const pySecs = (Date.now() - t0) / 1000;
const pyState = JSON.parse(await readFile(join(pyWs, "state.json"), "utf8"));
const pyFig = pyState.history[0].figures as L.Figures;

// ---- TypeScript: onboard, bench new
const onb = await onboard(tsProj, { name: "parity" });
const req = (await readRequirements(tsProj))!;
if (stress !== null) for (const c of Object.values(req.acceptance.net_classes.classes)) if (c.pairs?.length) c.diff_pair_gap = stress;
const drc: L.DrcFn = async ({ board, parity, outFile }) => {
  const r = await runDrc({ path: cli, version: "" } as never, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
  return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
};
const scorer = L.createScorer(req, drc);
const engine: L.StepEngine = { run: async (step, input) => (step.type === "pairfix" ? L.runTighten({ step, input, req, drc }) : { error: "no router engine in the parity harness" }) };
const t1 = Date.now();
const { bench, line } = await L.Bench.create(join(out, "ts-ws"), tsProj, pcb, { scorer, engine });
const tsSecs = (Date.now() - t1) / 1000;
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
record("new: one-line figures", line.split(": ").slice(1).join(": ") === pyNew.split(": ").slice(1).join(": "), { py: pyNew, ts: line });
for (const k of ["open", "drc", "a7", "a7_mm", "a8", "pairs_todo"] as const) record(`new: figures.${k}`, same(bench.figures[k], pyFig[k]), { py: pyFig[k], ts: bench.figures[k] });
record("new: figures.pairs (coupled share, length difference, skew limit, failing per pair)", same(bench.figures.pairs, pyFig.pairs), { py: Object.keys(pyFig.pairs).length, ts: Object.keys(bench.figures.pairs).length });
record(`timing: oracle ${pySecs.toFixed(1)} s, TypeScript ${tsSecs.toFixed(1)} s`, true);

// ---- pairs measure --why, line by line
const board = parseBoard(await readFile(join(tsProj, pcb), "utf8"));
const stack = profile(req.acceptance).copper;
const pyMeasure = (await sh(["python3", join(tk, "tools/pairfix.py"), "measure", join(pyWs, "s0"), "--why"])).trim().split("\n");
const tsMeasure = L.measureLines(L.measurePairs(board, L.classesAndPairs(req), stack, true), true);
const bad = tsMeasure.map((l, i) => (l === pyMeasure[i] ? null : { py: pyMeasure[i], ts: l })).filter(Boolean);
record(`pairs measure --why: ${pyMeasure.length} pair lines identical`, !bad.length && tsMeasure.length === pyMeasure.length, bad.slice(0, 3));
const pyPlain = (await sh(["python3", join(tk, "tools/pairfix.py"), "measure", join(pyWs, "s0")])).trim().split("\n");
const tsPlain = L.measureLines(L.measurePairs(board, L.classesAndPairs(req), stack, false), false);
record("pairs measure (no --why): lines identical", same(pyPlain, tsPlain), pyPlain.filter((l, i) => l !== tsPlain[i]).slice(0, 2));

// ---- crossings (oracle fixed set = the spec's `fixed` regex; TS given the same set)
const spec = JSON.parse(await readFile(specPath, "utf8"));
const fixedRx = new RegExp(spec.fixed ?? "_(J|SW)\\d|^FIT_");
const pyCrossFile = join(out, "py-crossings.json");
await sh(["python3", join(tk, "tools/crossing_check.py"), join(pyWs, "s0", pcb), "--json", pyCrossFile]);
const pyCross = JSON.parse(await readFile(pyCrossFile, "utf8"));
const tsCross = L.findCrossings(board, { ground: profile(req.acceptance).ground, fixed: (r) => fixedRx.test(r) });
record(`crossings: ${pyCross.length} rows identical (ref, neighbour, counts, rotations)`, same(pyCross, tsCross), { py: pyCross.slice(0, 2), ts: tsCross.slice(0, 2) });

// ---- the gate on randomised figure pairs
let seed = 12345;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
const mkFig = (): L.Figures => {
  const names = ["P1 / N1", "P2 / N2", "P3 / N3"];
  return {
    open: rnd(4),
    drc: Object.fromEntries(["clearance", "shorting_items", "hole_clearance"].filter(() => rnd(3) === 0).map((k) => [k, 1 + rnd(3)])),
    a7: rnd(3),
    a7_mm: rnd(5) / 2,
    a8: rnd(3),
    pairs_todo: rnd(4),
    pairs: Object.fromEntries(names.filter(() => rnd(4) > 0).map((n) => [n, [rnd(10) / 10, rnd(30) / 10, 1.5, rnd(2) === 1] as L.PairFigure])),
  };
};
const cases = Array.from({ length: 400 }, () => ({ next: mkFig(), cur: mkFig(), acc: { a8_slack: rnd(2), a7_slack: rnd(2) } }));
await writeFile(join(out, "gate-cases.json"), JSON.stringify(cases));
const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(tk, "tools"))})
import lastmile
cs = json.load(open(${JSON.stringify(join(out, "gate-cases.json"))}))
print(json.dumps([lastmile.gate(c['next'], c['cur'], c['acc']) for c in cs]))
`;
const pyGate = JSON.parse(await sh(["python3", "-c", py]));
const tsGate = cases.map((c) => L.gate(c.next, c.cur, c.acc));
const gateBad = cases.map((_, i) => (same(pyGate[i], tsGate[i]) ? null : { i, py: pyGate[i], ts: tsGate[i] })).filter(Boolean);
record(`gate: ${cases.length} random figure pairs give identical reasons`, !gateBad.length, gateBad.slice(0, 3));
const keyBad = cases.filter((c, i) => same(Object.values(L.keyOf(c.next)), Object.values(L.keyOf(c.next))) === false).length;
void keyBad;

// ---- tighten (width, tighten) on named pairs
if (a.tighten) {
  const rx = a.tighten;
  const pyOut = join(out, "py-tighten");
  const tp = Date.now();
  await sh(["python3", join(tk, "tools/pairfix.py"), "run", join(pyWs, "s0"), pyOut, "--pairs", rx, "--ops", "width,tighten"]);
  const pySec = (Date.now() - tp) / 1000;
  const pyRep = JSON.parse(await readFile(join(pyOut, "pairfix.json"), "utf8"));
  const tt = Date.now();
  const r = await L.runTighten({
    step: { type: "pairfix", args: ["--pairs", rx] },
    input: { cur: join(out, "ts-ws", "s0"), out: join(out, "ts-tighten"), start: join(out, "ts-ws", "s0"), pcb, signal: new AbortController().signal },
    req,
    drc,
  });
  const tsSec = (Date.now() - tt) / 1000;
  if ("error" in r) record("tighten", false, r.error);
  else {
    const ts = (r.info as { pairfix: Record<string, unknown> }).pairfix;
    const pba = ts["pairs_before_after"] as Record<string, { share: number[]; len_diff: number[] }>;
    const cmp = Object.keys(pyRep.pairs_before_after).map((k) => ({ k, py: pyRep.pairs_before_after[k], ts: pba[k] }));
    const bs = cmp.filter((c) => !same(c.py.share, c.ts?.share) || !same(c.py.len_diff, c.ts?.len_diff));
    record(`tighten ${rx}: per-pair coupled share and length difference, before and after (${cmp.length} pairs)`, !bs.length, bs.slice(0, 4));
    for (const k of ["groups_planned", "groups_applied", "collateral_items", "width_planned"] as const)
      record(`tighten: ${k}`, same(pyRep[k], ts[k]), { py: pyRep[k], ts: ts[k] });
    record("tighten: group modes", same(pyRep.group_modes, ts["group_modes"]), { py: pyRep.group_modes, ts: ts["group_modes"] });
    record("tighten: reverted groups", same(pyRep.groups_reverted, ts["groups_reverted"]), { py: pyRep.groups_reverted.length, ts: (ts["groups_reverted"] as unknown[]).length });
    const pyTxt = await readFile(join(pyOut, "edited", pcb), "utf8");
    const tsTxt = await readFile(join(out, "ts-tighten", pcb), "utf8");
    const segSet = (t: string) => new Set(L.readSegments(t).map((s) => `${s.net}|${s.layer}|${s.a.map((v) => v.toFixed(3))}|${s.b.map((v) => v.toFixed(3))}|${s.w}`));
    const sp = segSet(pyTxt);
    const st = segSet(tsTxt);
    const only = [...sp].filter((x) => !st.has(x)).length + [...st].filter((x) => !sp.has(x)).length;
    record(`tighten: edited boards' segments identical (net, layer, ends to 1 um, width); ${sp.size} vs ${st.size}`, only === 0, { differing: only });
    record(`tighten timing: oracle ${pySec.toFixed(1)} s, TypeScript ${tsSec.toFixed(1)} s`, true);
  }
}

if (a.tighten) {
  // the whole bench on a real board: try tighten (default ops here: width, tighten), judged by A1-A9 + DRC, accepted or not
  const tb = Date.now();
  const r = await L.Bench.open(join(out, "ts-ws"), { scorer, engine }).then((b) => b.try(["tighten:" + a.tighten]));
  record(`bench try tighten:${a.tighten} (TypeScript only): ${r.accepted ? "accepted" : "rejected: " + r.candidates[0]!.rejected.join("; ")}`, true, r.lines.join(" | "));
  console.log(r.lines.join("\n"), `(${((Date.now() - tb) / 1000).toFixed(1)} s)`);
}
await writeFile(join(out, "parity.json"), JSON.stringify(rows, null, 1));
const md = [
  "# Last-mile parity: Python toolkit vs TypeScript",
  "",
  `Board \`${a.board}\` (${board.footprints.size} footprints, ${board.segments.length} segments). Oracle ${tk}. kicad-cli ${cli}.`,
  "",
  "| item | agrees | detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.item} | ${r.agree ? "yes" : "NO"} | ${r.agree ? "" : "`" + JSON.stringify(r.detail).slice(0, 300).replace(/\|/g, "/") + "`"} |`),
].join("\n");
await writeFile(join(out, "lastmile-parity.md"), md + "\n");
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} agree; onboarded ${onb.counts.footprints} parts`);

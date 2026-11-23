/**
 * Bench-tool parity: the toolkit's measurement harnesses against `src/bench/`.
 *
 *   bun packages/board-workflow/test/parity-bench.ts --out DIR [--boards cm5=DIR,vme=DIR] [--results DIR,...]
 *       [--pairs-req DIR --pairs-boards A.kicad_pcb,B.kicad_pcb] [--review-py bench.json --review-ts bench.json] [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit and real boards).
 * - editbench tasks: each --boards project is copied and onboarded (TypeScript), then `flow/editbench.py tasks` and
 *   `writeEditTasks` write the suite from the same spec; every plan is compared field by field.
 * - editbench table: `editbench.py table --md` and `editTable` over the --results folders (markdown and JSON).
 * - pairbench: `pairbench.board_metrics`, `nonpair_items` (collateral between the boards) and `table` on --pairs-boards
 *   with the pairs of --pairs-req (a requirements folder), against `boardMetrics`, `nonpairItems`, `pairbenchTable`.
 * - review bench: the rows and clean counts of the toolkit's runs/bench.json against `scripts/bench.ts review --out`.
 * Writes parity-bench.json into --out; exits 1 on any difference.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bench, lastmile as L, onboard, type Requirements } from "../src/index";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    boards: { type: "string", default: "" },
    results: { type: "string", default: "" },
    "pairs-req": { type: "string" },
    "pairs-boards": { type: "string" },
    "review-py": { type: "string" },
    "review-ts": { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
  },
});
if (!a.out) throw new Error("--out is required");
const out = resolve(a.out);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const tk = a.toolkit!;
const diffs: string[] = [];
const report: Record<string, unknown> = {};

async function sh(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { env: { ...process.env, PCB_PROJECT: out, PCB_REPO: out, PCB_SELFRECORD: "off", ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${e.slice(-1500)}`);
  return o;
}
function cmp(path: string, x: unknown, y: unknown): void {
  if (typeof x === "number" && typeof y === "number") {
    if (Math.abs(x - y) > 1e-9) diffs.push(`${path}: python ${x} vs ts ${y}`);
  } else if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) diffs.push(`${path}: length ${x.length} vs ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) cmp(`${path}[${i}]`, x[i], y[i]);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.join() !== ky.join()) diffs.push(`${path}: keys ${kx.join(",")} vs ${ky.join(",")}`);
    for (const k of new Set([...kx, ...ky])) cmp(`${path}.${k}`, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
  } else if (x !== y) diffs.push(`${path}: python ${JSON.stringify(x)} vs ts ${JSON.stringify(y)}`);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");

// ---- editbench tasks
for (const spec of a.boards!.split(",").filter(Boolean)) {
  const [name, src] = spec.split("=", 2) as [string, string];
  const proj = join(out, name, "proj");
  await mkdir(proj, { recursive: true });
  for (const n of await readdir(src)) if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_dru)$|^(fp|sym)-lib-table$/.test(n)) await cp(join(src, n), join(proj, n));
  const ob = await onboard(proj, { name });
  const stem = (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!.replace(/\.kicad_pcb$/, "");
  const fixed = `^(${ob.fixed.map(esc).join("|")})$`;
  const specFile = join(out, name, "spec.json");
  await writeFile(specFile, JSON.stringify({ name, stem, base: proj, requirements: join(proj, ".fabdesk/board/requirements"), fixed, templates: [] }));
  await sh(["python3", join(tk, "flow/editbench.py"), "tasks", name, proj, specFile, join(out, name, "py")]);
  const ts = await bench.writeEditTasks({ name, src: proj, stem, requirements: join(proj, ".fabdesk/board/requirements"), fixed, spec: specFile, root: out, out: join(out, name, "ts") });
  const pyFiles = (await readdir(join(out, name, "py"))).sort();
  const before = diffs.length;
  cmp(`${name}.tasks`, pyFiles.map((f) => f.replace(/\.json$/, "")), Object.keys(ts).sort());
  for (const f of pyFiles) cmp(`${name}.${f}`, JSON.parse(await readFile(join(out, name, "py", f), "utf8")), JSON.parse(await readFile(join(out, name, "ts", f), "utf8")));
  report[`tasks ${name}`] = { tasks: Object.keys(ts), reasons: Object.values(ts).map((t) => t["reason"]), diffs: diffs.length - before };
  console.log(`editbench tasks ${name}: ${Object.keys(ts).join(" ")}; ${diffs.length - before} differences`);
}

// ---- editbench table
const resDirs = a.results!.split(",").filter(Boolean);
if (resDirs.length) {
  const md = join(out, "table.md");
  const pyOut = await sh(["python3", join(tk, "flow/editbench.py"), "table", ...resDirs, "--md", md]);
  const t = bench.editTable(await bench.readEditResults(resDirs));
  const before = diffs.length;
  if (pyOut.trimEnd() !== t.md) {
    const pl = pyOut.trimEnd().split("\n"), tl = t.md.split("\n");
    const i = pl.findIndex((l, k) => l !== tl[k]);
    diffs.push(`table line ${i}:\n  py ${pl[i]}\n  ts ${tl[i]}`);
  }
  cmp("table.json", JSON.parse(await readFile(join(out, "table.json"), "utf8")), JSON.parse(JSON.stringify(t.json)));
  report["table"] = { rows: t.json.length, diffs: diffs.length - before };
  console.log(`editbench table: ${t.json.length} results; ${diffs.length - before} differences`);
}

// ---- pairbench metrics, collateral, table
if (a["pairs-req"] && a["pairs-boards"]) {
  const [b0, b1] = a["pairs-boards"].split(",") as [string, string];
  const reqDir = resolve(a["pairs-req"]);
  const flowSpec = join(out, "pairs-spec.json");
  await writeFile(flowSpec, JSON.stringify({ stem: "board", requirements: reqDir }));
  const DRIVER = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1] + '/tools')
import pairbench, pairfix
b0, b1 = Path(sys.argv[2]), Path(sys.argv[3])
pairs = pairfix.classes_and_pairs(None)
nets = {n for pr in pairs for n in (pr['p'], pr['n'])}
m0 = pairbench.board_metrics(b0, pairs, nets)
m1 = pairbench.board_metrics(b1, pairs, nets, m0['uncoupled'])
i0, i1 = pairbench.nonpair_items(b0, nets), pairbench.nonpair_items(b1, nets)
fig = {'open': 3, 'drc': {'clearance': 2, 'hole_clearance': 1}, 'a8': 4}
rec = {'board': 'b', 'start': {'figures': fig, **{k: m0[k] for k in ('pairs_uncoupled', 'focus_mean_share', 'worst_len_diff')}},
       'rows': [{'action': 'tighten', 'wall_s': 12.4, 'figures': fig, 'verdict': 'passes gate', **{k: m1[k] for k in ('pairs_uncoupled', 'focus_mean_share', 'worst_len_diff')}, 'collateral': len(i0 ^ i1)},
                {'action': 'reroute:x', 'wall_s': None, 'figures': None, 'verdict': ['FAILED: no route']},
                {'action': 'pairs', 'wall_s': 3.5, 'figures': fig, 'verdict': ['A8 worse', 'DRC worse'], 'pairs_uncoupled': 1, 'focus_mean_share': None, 'worst_len_diff': 0.125, 'collateral': 0}]}
print(json.dumps({'m0': m0, 'm1': m1, 'n0': len(i0), 'n1': len(i1), 'collateral': len(i0 ^ i1), 'table': pairbench.table([rec]), 'rec': rec}))
`;
  const py = JSON.parse(await sh(["python3", "-c", DRIVER, tk, b0, b1], { FLOW_SPEC: flowSpec })) as Record<string, unknown> & { rec: bench.PairbenchBoard; table: string };
  // the same acceptance file as the oracle's (pairs and stack come from it alone)
  const req = { acceptance: JSON.parse(await readFile(join(reqDir, "acceptance.json"), "utf8")) } as Requirements;
  const pairs = L.classesAndPairs(req);
  const nets = new Set(pairs.flatMap((p) => [p.p, p.n]));
  const [t0, t1] = [await readFile(b0, "utf8"), await readFile(b1, "utf8")];
  const stack = req.acceptance.stack_policy?.copper_layers ?? [];
  const m0 = bench.boardMetrics(t0, pairs, stack), m1 = bench.boardMetrics(t1, pairs, stack, m0.uncoupled);
  const i0 = bench.nonpairItems(t0, nets), i1 = bench.nonpairItems(t1, nets);
  const before = diffs.length;
  cmp("pairs.m0", py["m0"], m0);
  cmp("pairs.m1", py["m1"], m1);
  cmp("pairs.items", [py["n0"], py["n1"], py["collateral"]], [i0.size, i1.size, bench.symmetricDifference(i0, i1)]);
  const rec = py.rec;
  if (py.table !== bench.pairbenchTable([rec])) diffs.push(`pairs.table:\n  py ${py.table}\n  ts ${bench.pairbenchTable([rec])}`);
  report["pairbench"] = { pairs: pairs.length, uncoupled: [m0.pairs_uncoupled, m1.pairs_uncoupled], items: [i0.size, i1.size], collateral: bench.symmetricDifference(i0, i1), diffs: diffs.length - before };
  console.log(`pairbench: ${pairs.length} pairs, uncoupled ${m0.pairs_uncoupled} -> ${m1.pairs_uncoupled}, non-pair items ${i0.size}/${i1.size}, collateral ${bench.symmetricDifference(i0, i1)}; ${diffs.length - before} differences`);
}

// ---- review bench
if (a["review-py"] && a["review-ts"]) {
  const py = JSON.parse(await readFile(a["review-py"], "utf8")) as { caught: number; expected: number; rows: unknown[]; clean: unknown[] };
  const ts = JSON.parse(await readFile(a["review-ts"], "utf8")) as typeof py;
  const before = diffs.length;
  cmp("review.caught", [py.caught, py.expected], [ts.caught, ts.expected]);
  cmp("review.rows", py.rows, ts.rows);
  cmp("review.clean", py.clean, ts.clean);
  report["review bench"] = { caught: `${ts.caught}/${ts.expected}`, diffs: diffs.length - before };
  console.log(`review bench: ${ts.caught}/${ts.expected} caught (python ${py.caught}/${py.expected}); ${diffs.length - before} differences`);
}

await writeFile(join(out, "parity-bench.json"), JSON.stringify({ toolkit: tk, report, diffs }, null, 1) + "\n");
console.log(diffs.length ? `\n${diffs.length} differences:\n${diffs.slice(0, 40).join("\n")}` : "\nparity: identical");
process.exit(diffs.length ? 1 : 0);

/**
 * route_region / block_eval parity: the toolkit (the oracle) against lastmile/replace.ts and layout/blockeval.ts.
 *
 *   bun packages/board-workflow/test/parity-region.ts --out DIR [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit; runs no router, no kicad-cli).
 *
 *   region rip   route_region's rip of every track/via/arc with a point in a region (all nets) and its prune_dangling
 *                (the toolkit's own functions; the 10-line selection loop of its main() is copied verbatim), against
 *                regionRip on routed boards: C6 (release/C6-eco95, the floorplan-H2 regions of two groups), cm5 and vme
 *                (two boxes each). Compared: the ripped board byte for byte and the counts.
 *   block plan   block_eval.py's isolation plan (it writes plan.json before routing; the stand-in TraceMaker then makes
 *                its route step fail) against blockPlan with the same base plan (C6 plan-r6.json) on the C6 placed-H2
 *                board, for the display and the power groups. Compared: the plan, `escape` left out (not run here).
 */
import { cp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { regionRip } from "../src/lastmile/replace";
import { blockNets, blockPlan } from "../src/layout/blockeval";
import { readFloorplan, selectGroups, type Blocks, type Region } from "../src/layout/floorplan";
import type { Requirements } from "../src/requirements";

const { values: a } = parseArgs({ options: { out: { type: "string" }, toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" }, only: { type: "string" } } });
if (!a.out) throw new Error("--out is required");
const out = a.out;
const tools = join(a.toolkit!, "tools");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

async function run(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: o, stderr: e };
}
const rows: Array<{ item: string; agree: boolean; detail?: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, ...(agree ? {} : { detail }) });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 1500));
};
/** JSON with sorted keys. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));

// ---------------------------------------------------------------- region rip
const C6P = "/home/shane/vaio_p_modding/io-c6";
const fpH2 = JSON.parse(await readFile(`${C6P}/review/c6-see87/floorplan-H2.json`, "utf8")) as { groups: Array<{ name: string; region: Region }> };
const regionOf = (n: string) => fpH2.groups.find((g) => g.name === n)!.region;
const RIP = [
  { name: "c6-display+charger", board: `${C6P}/release/C6-eco95/C6.kicad_pcb`, regions: [regionOf("display"), regionOf("charger")] },
  { name: "c6-usbc_out", board: `${C6P}/release/C6-eco95/C6.kicad_pcb`, regions: [regionOf("usbc_out")] },
  { name: "cm5-two-boxes", board: "/home/shane/pcb-cmp/cm5_minima/proj2/board.kicad_pcb", regions: [[90, 40, 110, 60], [130, 70, 145, 85]] as Region[] },
  { name: "vme-two-boxes", board: "/home/shane/pcb-cmp/vme-wren/proj2/board.kicad_pcb", regions: [[120, 60, 150, 90], [200, 100, 215, 120]] as Region[] },
];
const PY_RIP = `
import json, re, sys
sys.path.insert(0, sys.argv[1])
import block_pass, route_region
from route_region import inside, prune_dangling
text = open(sys.argv[2]).read()
regions = json.loads(sys.argv[3])
# route_region.main(), verbatim
removed = {'segment': 0, 'via': 0, 'arc': 0}
spans = []
for kind in removed:
    for s, e in block_pass.top_level(text, kind):
        item = text[s:e]
        pts = [(float(x), float(y)) for x, y in re.findall(r'\\((?:start|end|at|mid) ([-\\d.]+) ([-\\d.]+)', item)]
        if any(inside(x, y, regions) for x, y in pts):
            spans.append((s, e)); removed[kind] += 1
for s, e in sorted(spans, reverse=True):
    text = text[:s].rstrip(' \\t') + text[e:]
text, removed['pruned'] = prune_dangling(text)
open(sys.argv[4], 'w').write(text)
print(json.dumps(removed))
`;
await writeFile(join(out, "rip.py"), PY_RIP);
for (const c of RIP) {
  if (a.only && !c.name.includes(a.only)) continue;
  const d = join(out, c.name);
  await mkdir(d);
  const t0 = Date.now();
  const py = await run(["python3", join(out, "rip.py"), tools, c.board, JSON.stringify(c.regions), join(d, "py.kicad_pcb")], { PYTHONPATH: tools });
  if (py.code) throw new Error(py.stderr);
  const pyS = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  const ts = regionRip(await readFile(c.board, "utf8"), c.regions);
  const tsS = (Date.now() - t1) / 1000;
  await writeFile(join(d, "ts.kicad_pcb"), ts.text);
  const pyText = await readFile(join(d, "py.kicad_pcb"), "utf8");
  const pyRemoved = JSON.parse(py.stdout.trim().split("\n").at(-1)!);
  record(`${c.name} region rip: counts ${JSON.stringify(ts.removed)} (py ${pyS.toFixed(1)} s, ts ${tsS.toFixed(1)} s)`, canon(pyRemoved) === canon(ts.removed), { py: pyRemoved, ts: ts.removed });
  record(`${c.name} region rip: board byte for byte`, pyText === ts.text, { py: pyText.length, ts: ts.text.length });
}

// ---------------------------------------------------------------- block_eval plan
const FRESH = "/home/shane/vaio-io-fresh";
const bin = join(out, "bin");
await mkdir(bin);
await writeFile(join(bin, "tracemaker"), "#!/bin/sh\nexit 3\n");
await chmod(join(bin, "tracemaker"), 0o755);
const ptools = join(out, "tools");
await cp(tools, ptools, { recursive: true, filter: (s) => !s.includes("__pycache__") });
const cfg = JSON.parse(await readFile(join(ptools, "config.json"), "utf8"));
cfg.tracemaker = join(bin, "tracemaker");
await writeFile(join(ptools, "config.json"), JSON.stringify(cfg, null, 2));
const placed = `${FRESH}/work/c6-see87/placed-H2`;
const fpFile = `${C6P}/review/c6-see87/floorplan-disp-V6.json`;
const blocksFile = `${C6P}/review/c6-route85/blocks.json`;
const blocks = JSON.parse(await readFile(blocksFile, "utf8")) as Blocks;
const fp = readFloorplan(JSON.parse(await readFile(fpFile, "utf8")), blocks);
const acceptance = JSON.parse(await readFile(`${C6P}/requirements/acceptance.json`, "utf8"));
const req = { acceptance } as unknown as Requirements;
const basePlan = JSON.parse(await readFile(`${C6P}/review/c6-route85/plan-r6.json`, "utf8"));
for (const [groups, gnd] of [["display", false], ["charger,buck_5v", false], ["keyboard", true]] as const) {
  const d = join(out, `eval-${groups.replace(",", "+")}${gnd ? "-gnd" : ""}`);
  if (a.only && !d.includes(a.only)) continue;
  const r = await run(["python3", join(ptools, "block_eval.py"), placed, d, "--floorplan", fpFile, "--blocks", blocksFile, "--groups", groups, ...(gnd ? ["--gnd-first"] : [])]);
  const pyPlan = JSON.parse(await readFile(join(d, "plan.json"), "utf8").catch(() => { throw new Error(`block_eval wrote no plan: ${r.stderr.slice(-800)}`); }));
  delete pyPlan.escape;
  const sel = selectGroups(fp, groups.split(","));
  // C6's acceptance predates stack_policy.ground_net; the toolkit's block_eval names IO_GND
  const ground = acceptance.stack_policy.ground_net ?? "IO_GND";
  const nets = blockNets(await readFile(join(placed, "C6.kicad_pcb"), "utf8"), sel, blocks, ground);
  const tsPlan = blockPlan(basePlan, nets, req, sel.map((g) => g.name), gnd, ground);
  record(`block_eval plan ${groups}${gnd ? " --gnd-first" : ""}: ${nets.length} nets, stages ${tsPlan.session.map((s) => `${s.name}:${(s.nets as string[]).length}`).join(" ")}`, canon(pyPlan) === canon(tsPlan), { py: canon(pyPlan).slice(0, 600), ts: canon(tsPlan).slice(0, 600) });
}

await writeFile(join(out, "parity.json"), JSON.stringify({ rows }, null, 1) + "\n");
const bad = rows.filter((r) => !r.agree).length;
console.log(`${rows.length - bad}/${rows.length} agree`);
process.exit(bad ? 1 : 0);

/**
 * Layout stage parity: the toolkit's `flow.py init/check/place` against `@fabdesk/board-workflow` layout on one board.
 *
 *   bun packages/board-workflow/test/parity-layout.ts --spec SPEC.json --out DIR --krt DIR [--stages check,place] [--seeds 0-7]
 *                                                    [--toolkit DIR] [--kicad-cli PATH] [--source BOARD.kicad_pcb]
 *
 * Not part of `bun run test` (it needs the Python toolkit, KiCadRoutingTools and kicad-cli). SPEC.json is a layout spec
 * (the toolkit's flow spec has the same fields). Both sides start from copies of the same spec. Writes parity.json and
 * layout-parity.md into --out. `place` is a heavy job: run it alone on the machine.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import {
  deriveGroups,
  deriveRequirements,
  escapeKeepouts,
  fixedRegex,
  initFlow,
  nodeRun,
  parseBoard,
  readProjectSettings,
  stageCheck,
  stagePlace,
  type LayoutHost,
  type LayoutSpec,
} from "../src/index";

const { values: a } = parseArgs({
  options: {
    spec: { type: "string" },
    out: { type: "string" },
    krt: { type: "string", default: "/home/shane/fabdesk-evals/builds/krt-c6-20261110" },
    tracemaker: { type: "string", default: "/home/shane/.wholeboard/tools/tracemaker/tracemaker-0.12.1-linux-x86_64/bin/tracemaker" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    stages: { type: "string", default: "check" },
    seeds: { type: "string", default: "0-3" },
    source: { type: "string" },
    "ts-only": { type: "boolean", default: false },
  },
});
if (!a.spec || !a.out) throw new Error("--spec and --out are required");
const out = a.out;
const stages = a.stages!.split(",");
const kicad = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const spec = JSON.parse(await readFile(a.spec, "utf8")) as LayoutSpec;
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: kicad, FLOW_SPEC: a.spec };

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o + e };
}
const rows: Array<{ item: string; agree: boolean; ts: unknown; py: unknown }> = [];
const rec = (item: string, ts: unknown, py: unknown) => {
  const agree = JSON.stringify(ts) === JSON.stringify(py);
  rows.push({ item, agree, ts, py });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : `ts=${JSON.stringify(ts).slice(0, 300)} py=${JSON.stringify(py).slice(0, 300)}`);
};

const host: LayoutHost = {
  tools: { krt: a.krt!, tracemaker: a.tracemaker!, kicadCli: kicad },
  spawn: nodeRun,
  courtyardDrc: async (board, report) =>
    (await runDrc({ path: kicad, version: "" }, { board, outFile: report, severity: "all" })).violations.map((v) => ({ rule: v.rule, items: v.items.map((i) => ({ description: i.description })) })),
  scoreDrc: async (board, outFile, parity) => {
    const r = await runDrc({ path: kicad, version: "" }, { board, outFile, severity: "all", schematicParity: parity, refillZones: true });
    return { violations: r.violations.map((v) => ({ rule: v.rule, severity: v.severity, description: v.description })), unconnected: r.unconnected.length, parity: r.schematicParity.length };
  },
  memAvailableGiB: async () => {
    const m = /MemAvailable:\s+(\d+)/.exec(await readFile("/proc/meminfo", "utf8"));
    return Number(m?.[1] ?? 0) / 2 ** 20;
  },
  diskFreeGiB: async () => 100,
  log: (l) => console.log("  ts:", l.slice(0, 200)),
};

// ---- oracle workspace and TypeScript workspace from the same spec
const pyWs = join(out, "py-ws");
const tsWs = join(out, "ts-ws");
let r = a["ts-only"] ? { code: 0, out: "" } : await sh(["python3", join(a.toolkit!, "flow/flow.py"), "init", pyWs, "--spec", a.spec]);
if (r.code) throw new Error("oracle init: " + r.out);
const st = await initFlow(tsWs, spec, a.spec);

if (stages.includes("check")) {
  if (!a["ts-only"]) r = await sh(["python3", join(a.toolkit!, "flow/flow.py"), "check", pyWs]);
  const py = JSON.parse(await readFile(join(a["ts-only"] ? a.out + "/../run-place/py-ws" : pyWs, "check/result.json"), "utf8")) as { verdict: string; result: { fails: string[]; warns: string[]; info: Record<string, unknown> } };
  const ts = await stageCheck(host, st, {});
  const tsRes = ts.result as typeof py.result;
  rec("check verdict", ts.verdict, py.verdict);
  const infoKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !["disk_gib", "mem_avail_gib"].includes(k)));
  rec("check info (footprints, nets, segments, fixed, groups, pairs)", infoKeys(tsRes.info), infoKeys(py.result.info));
  rec("check fails", tsRes.fails, py.result.fails);
  rec("check warns", tsRes.warns, py.result.warns);
  // negative cases: break the base the same way on both sides and compare the verdicts
}

if (a.source) {
  // groups, keep-outs and the fixed regex derived from the board, against the spec the toolkit's onboard wrote
  const text = await readFile(a.source, "utf8");
  const d = deriveRequirements(text, readProjectSettings("{}"), { pcbName: "board.kicad_pcb" });
  const board = parseBoard(text);
  const fixed = d.fixed;
  const pyGroups = JSON.parse(await readFile(spec.groups, "utf8")) as { groups: unknown[] };
  rec("derived fixed regex", fixedRegex(fixed), spec.fixed);
  rec("derived keepouts", escapeKeepouts(board.pads, fixed), spec.keepouts ?? []);
  rec("derived groups", deriveGroups(board, new Set(fixed)), pyGroups.groups);
}

if (stages.includes("place")) {
  const t0 = Date.now();
  if (!a["ts-only"]) r = await sh(["python3", join(a.toolkit!, "flow/flow.py"), "place", pyWs, "--seeds", a.seeds!]);
  const pyWall = (Date.now() - t0) / 1000;
  const py = JSON.parse(await readFile(join(a["ts-only"] ? a.out + "/../run-place/py-ws" : pyWs, "place/result.json"), "utf8")) as { verdict: string; result: { seeds: Array<Record<string, unknown>> } };
  const t1 = Date.now();
  const ts = await stagePlace(host, st, { seeds: a.seeds! });
  const tsWall = (Date.now() - t1) / 1000;
  const tsSeeds = (ts.result as { seeds: Array<Record<string, unknown>> }).seeds;
  const pick = (s: Record<string, unknown>) => ({ seed: s["seed"], gate: s["gate"], crossings: s["crossings"], cost: s["cost"], wire: s["wire"], why: s["why"], away: s["away"] ?? null, kept: s["kept"] ?? false });
  rec("place verdict", ts.verdict, py.verdict);
  rec("place seeds count", tsSeeds.length, py.result.seeds.length);
  rec("place gated seeds", tsSeeds.filter((s) => s["gate"]).map((s) => s["seed"]), py.result.seeds.filter((s) => s["gate"]).map((s) => s["seed"]));
  rec("place per-seed (gate, crossings, cost, why, away, kept)", tsSeeds.map(pick), py.result.seeds.map(pick));
  console.log(`wall: python ${pyWall} s, ts ${tsWall} s`);
  await writeFile(join(out, "walls.json"), JSON.stringify({ pyWall, tsWall }));
}

await writeFile(join(out, "parity.json"), JSON.stringify(rows, null, 1));
const md = ["# Layout parity (generated)", "", "| item | agree |", "|---|---|", ...rows.map((x) => `| ${x.item} | ${x.agree ? "agree" : "DIFFER"} |`)].join("\n");
await writeFile(join(out, "layout-parity.md"), md + "\n");
console.log(`${rows.filter((x) => x.agree).length}/${rows.length} agree`);

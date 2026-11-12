/**
 * End to end: last-mile KRT steps through the TypeScript step engine against the toolkit's bench, on one real board.
 *
 *   bun packages/board-workflow/test/e2e-lastmile-krt.ts --board DIR --spec SPEC.json --out DIR [--nets N1,N2,..]
 *       [--actions finish,rip,blockers:1.0] [--kicad-cli PATH] [--toolkit DIR] [--krt DIR] [--stem NAME] [--same-req]
 *
 * Not part of `bun run test` (needs KiCadRoutingTools, the Python toolkit and kicad-cli; each action routes the whole board).
 * The copper of `--nets` is deleted on both sides so there is something to route; each side then runs `lastmile new` and
 * `try --no-accept` with the same actions, one at a time (--jobs 1). The TypeScript copy's board is renamed to `--stem`
 * (default CM5) to exercise a board not called board.kicad_pcb. Compared per action: open, DRC, A7, A8 figures and
 * rejection reasons. --same-req: the TypeScript side reads the oracle's requirement files (not its own onboarding), so only
 * the engines differ. Writes e2e.json into --out.
 */
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { lastmile as L, layout, onboard, readRequirements } from "../src/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    spec: { type: "string" },
    out: { type: "string" },
    nets: { type: "string", default: "/CM5/nLED_ACTIVITY,/PCIe-M2/FB,Net-(J1-K_GREEN)" },
    actions: { type: "string", default: "finish,rip,blockers:1.0" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    krt: { type: "string", default: "/home/shane/fabdesk-evals/builds/krt-c6-20261110" },
    stem: { type: "string", default: "CM5" },
    "same-req": { type: "boolean", default: false },
  },
});
if (!a.board || !a.out || !a.spec) throw new Error("--board, --spec and --out are required");
const out = a.out;
const cli = a["kicad-cli"]!;
const nets = a.nets!.split(",");
const actions = a.actions!.split(",");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: cli, FLOW_SPEC: a.spec };
async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2000)}`);
  return o;
}

// ---- the same opened board on both sides
const strip = (t: string) => {
  // top-level copper items, single- or multi-line, whose net is one of `nets`
  const cut: Array<[number, number]> = [];
  for (const m of t.matchAll(/\n\t\((segment|via|arc)\b/g)) {
    let i = m.index! + 2, depth = 0;
    for (; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")" && --depth === 0) break;
    }
    const item = t.slice(m.index! + 2, i + 1);
    if (nets.some((x) => item.includes(`(net "${x}")`))) cut.push([m.index!, i + 1]);
  }
  let s = t;
  for (const [x, y] of cut.reverse()) s = s.slice(0, x) + s.slice(y);
  return { s, n: cut.length };
};
const pySrc = join(out, "py-src");
const tsProj = join(out, "ts-proj");
await cp(a.board, pySrc, { recursive: true });
await cp(a.board, tsProj, { recursive: true });
const raw = await readFile(join(pySrc, "board.kicad_pcb"), "utf8");
const { s: opened, n: removed } = strip(raw);
if (!removed) throw new Error(`no copper of ${nets.join(", ")} found (copper items must be one per line)`);
await writeFile(join(pySrc, "board.kicad_pcb"), opened);
const stem = a.stem!;
for (const f of await readdir(tsProj)) if (/^board\.kicad_(pcb|pro|prl|dru)$/.test(f)) await rename(join(tsProj, f), join(tsProj, f.replace(/^board/, stem)));
await writeFile(join(tsProj, `${stem}.kicad_pcb`), opened);
console.log(`opened ${nets.length} nets: ${removed} copper items removed`);

// ---- oracle
const pyWs = join(out, "py-ws");
let t0 = Date.now();
console.log((await sh(["python3", join(a.toolkit!, "bin/pcb"), "lastmile", "new", pyWs, pySrc])).trim());
const pyTry = await sh(["python3", join(a.toolkit!, "bin/pcb"), "lastmile", "try", pyWs, ...actions, "--no-accept", "--jobs", "1", "--budget", "1800"]);
const pySecs = (Date.now() - t0) / 1000;
console.log(pyTry);
const pyState = JSON.parse(await readFile(join(pyWs, "state.json"), "utf8"));
const pyLog = (pyState.log ?? []).at(-1) as { results: Array<{ name: string; figures?: L.Figures; rejected: string[] }> } | undefined;

// ---- TypeScript: onboard, bench, the library's step engine with real KRT
await onboard(tsProj, { name: "e2e", pcb: `${stem}.kicad_pcb` });
if (a["same-req"]) {
  // the oracle's requirement files instead of the port's own onboarding, so only the engines differ
  const spec = JSON.parse(await readFile(a.spec, "utf8")) as { requirements: string };
  await cp(spec.requirements, join(tsProj, ".fabdesk", "board", "requirements"), { recursive: true, force: true });
}
const req = (await readRequirements(tsProj))!;
const drc: L.DrcFn = async ({ board, parity, outFile }) => {
  const r = await runDrc({ path: cli, version: "" } as never, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
  return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
};
const courtyard = async (board: string, report: string) =>
  (await runDrc({ path: cli, version: "" } as never, { board, outFile: report, severity: "all", schematicParity: false, refillZones: false })).violations.map((v) => ({ rule: v.rule, items: v.items.map((i) => ({ description: i.description })) }));
const host: layout.LayoutHost = {
  tools: { krt: a.krt!, tracemaker: null, kicadCli: cli },
  spawn: layout.nodeRun,
  courtyardDrc: courtyard,
  scoreDrc: async (board, outFile, parity) => {
    const r = await drc({ board, outFile, parity });
    return { violations: r.violations.map((v) => ({ rule: v.rule, severity: v.severity, description: v.description })), unconnected: r.unconnected.length, parity: r.parity };
  },
  memAvailableGiB: async () => 16,
  diskFreeGiB: async () => 100,
  log: (l) => console.log("  krt", l),
};
const scorer = L.createScorer(req, drc);
const engine = L.createStepEngine({ req, drc, scorer, layout: host, fallbackRouter: "none", fill: async () => { throw new Error("no host router in this harness"); } });
t0 = Date.now();
const { bench, line } = await L.Bench.create(join(out, "ts-ws"), tsProj, `${stem}.kicad_pcb`, { scorer, engine, availableGiB: async () => 16 });
console.log(line);
const ts = await bench.try(actions, { noAccept: true, jobs: 1, budget: 1800 });
const tsSecs = (Date.now() - t0) / 1000;
console.log(ts.lines.join("\n"));

// ---- compare: figures, and the routed copper itself (uuids aside, whitespace normalised)
function copper(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\n\s*\((segment|via|arc)\b/g)) {
    const s0 = text.indexOf("(", m.index!);
    let i = s0, depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(s0, i + 1).replace(/\(uuid "[^"]*"\)/g, "").replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean).join(" "));
  }
  return out.sort();
}
const copperOf = async (dir: string | undefined, file: string) => (dir ? copper(await readFile(join(dir, file), "utf8").catch(() => "")) : null);
const rows = [];
for (const act of actions) {
  const p = pyLog?.results.find((r) => r.name === act) as { name: string; figures?: L.Figures; rejected: string[]; dir?: string } | undefined;
  const t = ts.candidates.find((c) => c.name === act);
  const pick = (f?: L.Figures) => (f ? { open: f.open, drc: f.drc, a7: f.a7, a8: f.a8 } : null);
  const py = pick(p?.figures), tsf = pick(t?.figures);
  const [pc, tc] = [await copperOf(p?.dir, "board.kicad_pcb"), await copperOf(t?.dir, `${stem}.kicad_pcb`)];
  const sameCopper = pc && tc ? JSON.stringify(pc) === JSON.stringify(tc) : null;
  const copperNote = pc && tc ? (sameCopper ? `identical copper (${pc.length} items)` : `copper differs: ${pc.filter((x) => !tc.includes(x)).length} oracle-only, ${tc.filter((x) => !pc.includes(x)).length} port-only of ${pc.length}/${tc.length}`) : "no board on one side";
  rows.push({ action: act, agree: JSON.stringify(py) === JSON.stringify(tsf), copper: copperNote, py, ts: tsf, py_rejected: p?.rejected ?? null, ts_rejected: t?.rejected ?? null, ts_steps: t?.steps });
}
const rec = { board: a.board, nets, removed, start: { py: pyState.history[0].figures.open, ts: bench.figures.open }, timing_s: { py: pySecs, ts: tsSecs }, rows };
await writeFile(join(out, "e2e.json"), JSON.stringify(rec, null, 1) + "\n");
for (const r of rows) console.log(`${r.agree ? "AGREE " : "DIFFER"} ${r.action} [${r.copper}]: py ${JSON.stringify(r.py)} ${JSON.stringify(r.py_rejected)} | ts ${JSON.stringify(r.ts)} ${JSON.stringify(r.ts_rejected)}`);
console.log(`start open: py ${rec.start.py}, ts ${rec.start.ts}; time py ${pySecs.toFixed(0)} s, ts ${tsSecs.toFixed(0)} s`);

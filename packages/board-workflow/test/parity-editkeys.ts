/**
 * Parity of the board_edit plan keys `copper`, `hole` and `stack` with the toolkit's `flow/copper_plan.py`,
 * `flow/mechanical_hole.py` and `flow/stack_plan.py` (the oracle), on the owners' recorded plans.
 *
 *   bun packages/board-workflow/test/parity-editkeys.ts --out DIR [--toolkit ~/pcb] [--only copper|hole|stack|geos|pipeline]
 *
 * Not part of `bun run test` (needs the Python toolkit and the vaio boards; runs no router and no kicad-cli).
 *
 *   geos      crossPoint / project / interpolate / point-segment distance against shapely on 4000 random segment pairs
 *             (copper_plan splits tracks with shapely): every double equal.
 *   copper    kb-fix112's copper.json, cleanup.json and tiny-tails.json (the intermediate boards they ran on were deleted
 *             by the owner's 2026-11-13 cleanup, which keeps only their hashes) replayed on the boards that remain:
 *             kb-fix112/before (the plan's own source project), pin-fit115/before (C6 at courtyard113) and the current C6
 *             release; a remove_items plan on real uuids with the real guard; cm5 with the 12 busiest nets pruned; the
 *             unit fixture. The oracle's uuid4 is replaced by a counter on both sides. Compared: board byte for byte,
 *             ledger, or the same refusal.
 *   hole      pin-fit115's plan.json on its recorded source (8686d142): the oracle's candidate is the recorded
 *             236d0a8f; compared board and library footprint byte for byte (and both against the recorded hashes).
 *   stack     stack106's plans chained as the owner ran them (plan, lvds-plan, final-plan, cleanup-plan,
 *             adoption-plan), starting from the preserved pre-stack source (release-fab104-source; the stack105 source
 *             was deleted), each step from the previous step's output on both sides; final-plan's copper_source (a
 *             deleted bench board) replaced by kb-fix112/before as a separate copy test. Compared: board byte for byte,
 *             acceptance.json re-dumped by Python's json byte for byte (key order and number spelling).
 *   pipeline  the same hole, copper and stack plans through runEdit (impact -> apply -> A1-A9 with a stub DRC -> diff)
 *             on an onboarded C6 project: the candidate board equals the oracle's (new uuids masked for copper).
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { onboard, runAcceptance } from "../src/index";
import { runEdit } from "../src/edit/index";
import { copperPlan, sha256, type CopperSpec } from "../src/edit/copper";
import { crossPoint, interpolate, pointSegDist, project, type P } from "../src/edit/geos";
import { holeEdit } from "../src/edit/hole";
import { stackAcceptance, stackBoard, type StackSpec } from "../src/edit/stack";
import { topLevelSpans } from "../src/sexpr";

const { values: a } = parseArgs({ options: { out: { type: "string" }, toolkit: { type: "string", default: join(homedir(), "pcb") }, only: { type: "string" } } });
if (!a.out) throw new Error("--out is required");
const out = a.out;
const tk = a.toolkit!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const want = (k: string) => !a.only || a.only.split(",").includes(k);

async function run(cmd: string[]) {
  const p = Bun.spawn(["nice", ...cmd], { stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: o, stderr: e };
}
const rows: Array<{ section: string; item: string; agree: boolean; detail?: unknown }> = [];
const record = (section: string, item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ section, item, agree, ...(detail ? { detail } : {}) });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${section} ${item}`, detail ? JSON.stringify(detail).slice(0, 600) : "");
};
const firstDiff = (x: string, y: string) => {
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return { at: i, py: x.slice(Math.max(0, i - 80), i + 120), ts: y.slice(Math.max(0, i - 80), i + 120), len: [x.length, y.length] };
};
const seq = () => {
  let i = 0;
  return () => `00000000-0000-4000-8000-${String(++i).padStart(12, "0")}`;
};

const C6 = "/home/shane/vaio_p_modding/io-c6";
const KB = `${C6}/review/kb-fix112`;
const PF = `${C6}/review/pin-fit115`;
const ST = `${C6}/review/stack106`;

// ---------------------------------------------------------------- geos
if (want("geos")) {
  const PY = `
import json, random, sys
from shapely.geometry import LineString, Point
random.seed(7)
out = []
for i in range(4000):
    r = lambda: round(random.uniform(0, 60), random.choice([1, 2, 3, 4, 6, 9]))
    a, b, c, d = (r(), r()), (r(), r()), (r(), r()), (r(), r())
    if i % 5 == 0: c = (a[0] + (b[0] - a[0]) * 0.37, a[1] + (b[1] - a[1]) * 0.37)   # an endpoint near/on the line
    s, t = LineString([a, b]), LineString([c, d])
    x = s.intersection(t)
    ip = [x.x, x.y] if x.geom_type == 'Point' and not x.is_empty else None
    pr = s.project(Point(ip)) if ip else s.project(Point(c))
    out.append({'a': a, 'b': b, 'c': c, 'd': d, 'ip': ip, 'pr': pr, 'pt': list(s.interpolate(pr).coords[0]), 'dist': s.distance(Point(c))})
json.dump(out, open(sys.argv[1], 'w'))
`;
  await writeFile(join(out, "geos.py"), PY);
  const r = await run(["python3", "-I", join(out, "geos.py"), join(out, "geos.json")]);
  if (r.code) throw new Error(r.stderr);
  const cases = JSON.parse(await readFile(join(out, "geos.json"), "utf8")) as Array<{ a: P; b: P; c: P; d: P; ip: P | null; pr: number; pt: P; dist: number }>;
  const bad: unknown[] = [];
  let crossings = 0;
  for (const k of cases) {
    const ip = crossPoint(k.a, k.b, k.c, k.d);
    // collinear touching is a shapely point the port leaves to the caller's endpoint cut
    const collinearTouch = k.ip && !ip;
    if (k.ip) crossings++;
    const pr = project(k.a, k.b, (ip ?? k.ip ?? k.c) as P);
    const ok = (collinearTouch || JSON.stringify(ip) === JSON.stringify(k.ip)) && pr === k.pr && JSON.stringify(interpolate(k.a, k.b, pr)) === JSON.stringify(k.pt) && pointSegDist(k.c, k.a, k.b) === k.dist;
    if (!ok) bad.push({ k, ip, pr, pt: interpolate(k.a, k.b, pr), dist: pointSegDist(k.c, k.a, k.b) });
  }
  record("geos", `${cases.length} random segment pairs (${crossings} intersecting)`, !bad.length, bad.slice(0, 3));
}

// ---------------------------------------------------------------- copper
const PY_COPPER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import copper_plan
n = [0]
def uid():
    n[0] += 1
    return '00000000-0000-4000-8000-%012d' % n[0]
copper_plan.uid = uid
text = open(sys.argv[2]).read()
plan = json.load(open(sys.argv[3]))
try:
    after, ledger = copper_plan.apply(text, plan)
except Exception as e:
    json.dump({'error': type(e).__name__ + ': ' + str(e)}, open(sys.argv[5], 'w')); sys.exit(0)
open(sys.argv[4], 'w').write(after)
json.dump(ledger, open(sys.argv[5], 'w'))
`;
async function copperCase(name: string, board: string, plan: CopperSpec) {
  const d = join(out, "copper", name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "plan.json"), JSON.stringify(plan));
  const t0 = Date.now();
  const r = await run(["python3", join(out, "copper.py"), join(tk, "flow"), board, join(d, "plan.json"), join(d, "py.kicad_pcb"), join(d, "py.json")]);
  if (r.code) throw new Error(`${name}: ${r.stderr.slice(-2000)}`);
  const pySecs = (Date.now() - t0) / 1000;
  const py = JSON.parse(await readFile(join(d, "py.json"), "utf8")) as { error?: string; removed?: unknown[] };
  const text = await readFile(board, "utf8");
  let ts: { text: string; ledger: unknown } | { error: string };
  const t1 = Date.now();
  try {
    ts = copperPlan(text, plan, seq());
  } catch (e) {
    ts = { error: (e as Error).message };
  }
  const tsSecs = (Date.now() - t1) / 1000;
  if (py.error || "error" in ts) {
    record("copper", `${name}: both refuse`, !!py.error && "error" in ts, { py: py.error, ts: "error" in ts ? ts.error : "applied" });
    return;
  }
  const pyText = await readFile(join(d, "py.kicad_pcb"), "utf8");
  await writeFile(join(d, "ts.kicad_pcb"), ts.text);
  const ledgerOk = JSON.stringify(py) === JSON.stringify(ts.ledger);
  record("copper", `${name}: board byte-identical (${(pyText.length / 1e6).toFixed(2)} MB, removed ${py.removed!.length}; py ${pySecs.toFixed(1)} s, ts ${tsSecs.toFixed(1)} s)`, pyText === ts.text, pyText === ts.text ? "" : firstDiff(pyText, ts.text));
  record("copper", `${name}: ledger equal`, ledgerOk, ledgerOk ? "" : { py: JSON.stringify(py).slice(0, 300), ts: JSON.stringify(ts.ledger).slice(0, 300) });
}
const BOARDS = {
  "kbfix112-before": `${KB}/before/C6.kicad_pcb`,
  "pinfit115-before": join(out, "pinfit-src", "C6.kicad_pcb"),
  "c6-release": `${C6}/release/C6-eco95/C6.kicad_pcb`,
};
await mkdir(join(out, "pinfit-src"), { recursive: true });
await run(["tar", "xf", `${PF}/before-source.tar`, "-C", join(out, "pinfit-src")]);
if (want("copper")) {
  await writeFile(join(out, "copper.py"), PY_COPPER);
  const plans: Record<string, CopperSpec> = {
    copper: JSON.parse(await readFile(`${KB}/copper.json`, "utf8")),
    cleanup: JSON.parse(await readFile(`${KB}/cleanup.json`, "utf8")),
    "tiny-tails": JSON.parse(await readFile(`${KB}/tiny-tails.json`, "utf8")),
  };
  for (const [bn, board] of Object.entries(BOARDS)) for (const [pn, plan] of Object.entries(plans)) await copperCase(`${pn}@${bn}`, board, plan);
  // tiny-tails without its guard: its uuids belong to the deleted board
  const { source_sha256: _g, ...tails } = plans["tiny-tails"]!;
  await copperCase("tiny-tails-unguarded@kbfix112-before", BOARDS["kbfix112-before"], tails);
  // remove_items on real items with the real guard (synthetic: five USB_DM / PWR_BTN segments and a via)
  const src = await readFile(BOARDS["kbfix112-before"], "utf8");
  const uuids: string[] = [];
  for (const kind of ["segment", "via"])
    for (const s of topLevelSpans(src, kind)) {
      const b = src.slice(s.start, s.end);
      if (/\(net "(a74::USB_DM|a74::PWR_BTN)"\)/.test(b) && uuids.length < (kind === "via" ? 6 : 5)) uuids.push(/\(uuid "([^"]+)"\)/.exec(b)![1]!);
    }
  await copperCase("remove-items+prune@kbfix112-before", BOARDS["kbfix112-before"], { source_sha256: sha256(src), remove_items: uuids, prune_signal_leaves: ["a74::USB_DM", "a74::PWR_BTN"] });
  // cm5: the 12 busiest signal nets pruned
  const cm5 = "/home/shane/pcb-cmp/cm5_minima/proj2/board.kicad_pcb";
  const ct = await readFile(cm5, "utf8");
  const zoneNets = new Set([...ct.matchAll(/\(zone\s+\(net "([^"]+)"\)/g)].map((m) => m[1]!));
  const per = new Map<string, number>();
  for (const s of topLevelSpans(ct, "segment")) {
    const n = /\(net "([^"]*)"\)/.exec(ct.slice(s.start, s.end))?.[1];
    if (n && !zoneNets.has(n)) per.set(n, (per.get(n) ?? 0) + 1);
  }
  const arcNets = new Set(topLevelSpans(ct, "arc").map((s) => /\(net "([^"]*)"\)/.exec(ct.slice(s.start, s.end))?.[1]));
  const busy = [...per].filter(([n]) => !arcNets.has(n)).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 12).map(([n]) => n);
  await copperCase("prune-12-busiest@cm5", cm5, { prune_signal_leaves: busy, via_at_pad: [] });
  // the unit fixture
  const { BOARD } = await import("./edit-fixture");
  await writeFile(join(out, "fixture.kicad_pcb"), BOARD);
  await copperCase("fixture", join(out, "fixture.kicad_pcb"), { prune_signal_leaves: ["SIG", "SIG2"], via_at_pad: [{ ref: "C1", pad: "1", diameter: 0.5, drill: 0.2 }] });
}

// ---------------------------------------------------------------- hole
if (want("hole")) {
  const d = join(out, "hole");
  await mkdir(d, { recursive: true });
  const r = await run(["python3", join(tk, "flow/mechanical_hole.py"), BOARDS["pinfit115-before"], `${PF}/plan.json`, join(d, "py")]);
  if (r.code) throw new Error(r.stderr);
  const plan = JSON.parse(await readFile(`${PF}/plan.json`, "utf8"));
  const text = await readFile(BOARDS["pinfit115-before"], "utf8");
  const ts = holeEdit(text, { ref: plan.ref, size_mm: plan.size_mm, clearance_mm: plan.clearance_mm }, await readFile(join(out, "pinfit-src/C6_Parts.pretty/FIT_P2.kicad_mod"), "utf8"));
  const pyB = await readFile(join(d, "py/C6.kicad_pcb"), "utf8");
  const pyL = await readFile(join(d, "py/FIT_P2.kicad_mod"), "utf8");
  record("hole", `pin-fit115 board byte-identical (oracle ${sha256(pyB).slice(0, 8)}, recorded candidate 236d0a8f)`, pyB === ts.text && sha256(pyB).startsWith("236d0a8f"), pyB === ts.text ? "" : firstDiff(pyB, ts.text));
  record("hole", "pin-fit115 library FIT_P2.kicad_mod byte-identical", pyL === ts.lib, pyL === ts.lib ? "" : firstDiff(pyL, ts.lib));
  const rec = JSON.parse(await readFile(join(d, "py/hole-edit.json"), "utf8"));
  record("hole", "centre and hashes as the oracle's record", JSON.stringify(rec.centre_mm) === JSON.stringify(ts.centre) && rec.candidate_sha256 === sha256(ts.text) && rec.source_sha256 === sha256(text));
  await cp(`${C6}/release/C6-eco95/C6_Parts.pretty/FIT_P1.kicad_mod`, join(out, "pinfit-src/C6_Parts.pretty/FIT_P1.kicad_mod"));
  for (const [name, p] of [["round 1.8", { ref: "FIT_P2", size_mm: [1.8, 1.8], clearance_mm: 0.3 }], ["P1 oval", { ref: "FIT_P1", size_mm: [2.2, 1.7] }]] as const) {
    await writeFile(join(d, `${name}.json`), JSON.stringify(p));
    const q = await run(["python3", join(tk, "flow/mechanical_hole.py"), BOARDS["pinfit115-before"], join(d, `${name}.json`), join(d, `py-${name}`)]);
    let t: ReturnType<typeof holeEdit> | null = null;
    let err = "";
    try {
      t = holeEdit(text, p as never, await readFile(join(out, `pinfit-src/C6_Parts.pretty/${p.ref}.kicad_mod`), "utf8"));
    } catch (e) {
      err = (e as Error).message;
    }
    if (q.code || !t) record("hole", `${name}: both refuse`, !!q.code && !t, { py: q.stderr.trim().split("\n").pop(), ts: err || "applied" });
    else {
      record("hole", `${name}: board byte-identical`, (await readFile(join(d, `py-${name}/C6.kicad_pcb`), "utf8")) === t.text);
      record("hole", `${name}: library byte-identical`, (await readFile(join(d, `py-${name}/${p.ref}.kicad_mod`), "utf8")) === t.lib);
    }
  }
}

// ---------------------------------------------------------------- stack
/** Python: the two acceptance files equal as values (4.0 == 4) with the same key order everywhere; and whether they are byte-identical. */
const PY_ACC = `
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
def order(x, y, path=''):
    if isinstance(x, dict) and isinstance(y, dict):
        if list(x) != list(y): return path + ': ' + str(list(x)[:8]) + ' vs ' + str(list(y)[:8])
        for k in x:
            r = order(x[k], y[k], path + '.' + k)
            if r: return r
    if isinstance(x, list) and isinstance(y, list):
        for i, (p, q) in enumerate(zip(x, y)):
            r = order(p, q, path + '[%d]' % i)
            if r: return r
    return ''
print(json.dumps({'equal': a == b, 'order': order(a, b), 'bytes': open(sys.argv[1]).read() == json.dumps(b, indent=1) + '\\n'}))
`;
const accCompare = async (py: string, ts: string) => JSON.parse((await run(["python3", "-I", "-c", PY_ACC, py, ts])).stdout) as { equal: boolean; order: string; bytes: boolean };
if (want("stack")) {
  const d = join(out, "stack");
  await mkdir(d, { recursive: true });
  // the source project: what stack_plan copies (board, requirements, spec)
  const src = join(d, "src");
  await mkdir(join(src, "requirements"), { recursive: true });
  for (const f of ["C6.kicad_pcb", "C6.kicad_pro", "spec.json"]) await cp(`${ST}/release-fab104-source/${f}`, join(src, f));
  await cp(`${ST}/release-fab104-source/requirements`, join(src, "requirements"), { recursive: true });
  let pyDir = src;
  let tsBoard = await readFile(join(src, "C6.kicad_pcb"), "utf8");
  let tsAcc = JSON.parse(await readFile(join(src, "requirements/acceptance.json"), "utf8")) as Record<string, unknown>;
  for (const step of ["plan", "lvds-plan", "final-plan", "cleanup-plan", "adoption-plan"]) {
    const plan = JSON.parse(await readFile(`${ST}/${step}.json`, "utf8")) as StackSpec & { source: string; name: string };
    plan.source = pyDir;
    const note = plan.copper_source ? " (copper_source dropped: its bench board was deleted)" : "";
    delete plan.copper_source;
    await writeFile(join(d, `${step}.json`), JSON.stringify(plan));
    const o = join(d, `py-${step}`);
    const r = await run(["python3", join(tk, "flow/stack_plan.py"), join(d, `${step}.json`), o]);
    if (r.code) throw new Error(`${step}: ${r.stderr.slice(-1500)}`);
    pyDir = o;
    tsBoard = stackBoard(tsBoard, plan).text;
    stackAcceptance(tsAcc, plan);
    const pyB = await readFile(join(o, "C6.kicad_pcb"), "utf8");
    record("stack", `${step}${note}: board byte-identical`, pyB === tsBoard, pyB === tsBoard ? "" : firstDiff(pyB, tsBoard));
    await writeFile(join(d, `ts-${step}.acceptance.json`), JSON.stringify(tsAcc, null, 1));
    const c = await accCompare(join(o, "requirements/acceptance.json"), join(d, `ts-${step}.acceptance.json`));
    record("stack", `${step}: acceptance.json equal (values, key order${c.bytes ? ", bytes" : "; integral floats spelt 4 for 4.0"})`, c.equal && !c.order, c.equal && !c.order ? "" : c);
  }
  // copper_source: the whole board taken from another file, then the plan's own edits
  const cs = { name: "C6-cs", source: src, copper_source: `${KB}/before/C6.kicad_pcb`, dielectrics: { "dielectric 3": { er: 4.16 } }, remove_vias: [] };
  await writeFile(join(d, "cs.json"), JSON.stringify(cs));
  const r = await run(["python3", join(tk, "flow/stack_plan.py"), join(d, "cs.json"), join(d, "py-cs")]);
  if (r.code) throw new Error(r.stderr);
  const tsCs = stackBoard(await readFile(cs.copper_source, "utf8"), cs as StackSpec).text;
  record("stack", "copper_source + dielectric: board byte-identical", (await readFile(join(d, "py-cs/C6.kicad_pcb"), "utf8")) === tsCs);
}

// ---------------------------------------------------------------- pipeline (runEdit on an onboarded C6 project)
if (want("pipeline")) {
  const mask = (t: string) => t.replace(/\(uuid "[0-9a-f-]{36}"\)/g, '(uuid "*")');
  const mkProject = async (name: string, from: string, files: string[], acceptance?: string) => {
    const p = join(out, "pipeline", name);
    await mkdir(p, { recursive: true });
    for (const f of files) await cp(join(from, f), join(p, f), { recursive: true });
    for (const f of await readdir(from)) if (f.endsWith(".kicad_sch")) await cp(join(from, f), join(p, f));
    await onboard(p, { name });
    if (acceptance) {
      // the toolkit's classes (fabdesk's onboarding derives its own names); the rest of its file is a newer schema
      const ap = join(p, ".fabdesk/board/requirements/acceptance.json");
      const mine = JSON.parse(await readFile(ap, "utf8"));
      mine.net_classes = JSON.parse(await readFile(acceptance, "utf8")).net_classes;
      await writeFile(ap, JSON.stringify(mine, null, 1));
    }
    return p;
  };
  const accept_before = { A3_parity: "parity harness: stub DRC", A4_circuit: "onboarded here", A5_anchors: "onboarded here", A9_heights: "onboarded here" };
  const runners = { accept: (dir: string, pcb: string) => runAcceptance(dir, { pcb, drc: async () => ({ violations: [], unconnected: 0, parity: 0 }) }) };
  const report = (name: string, r: Awaited<ReturnType<typeof runEdit>>) =>
    console.log(`       ${name}: ${r.stage} ${r.verdict}; collateral ${r.churn?.collateral_nets ?? "-"} nets; opens ${r.proof?.figures.open ?? "-"}; phases ${JSON.stringify(r.phases)}`);
  // hole
  {
    const pf = join(out, "pinfit-src");
    for (const f of ["C6.kicad_pro", "fp-lib-table"]) await cp(`${C6}/release/C6-eco95/${f}`, join(pf, f));
    const p = await mkProject("hole", pf, ["C6.kicad_pcb", "C6.kicad_pro", "fp-lib-table", "C6_Parts.pretty"]);
    const plan = JSON.parse(await readFile(`${PF}/plan.json`, "utf8"));
    const r = await runEdit({ projectDir: p, plan: { id: "pinfit115", hole: { ref: plan.ref, size_mm: plan.size_mm, clearance_mm: plan.clearance_mm }, accept_before }, mode: "full", runners });
    report("hole", r);
    const cb = r.candidate ? await readFile(r.candidate.pcb, "utf8") : "";
    record("pipeline", `hole: runEdit candidate board = the oracle's (236d0a8f); proof ${r.verdict}`, sha256(cb).startsWith("236d0a8f"), r.candidate ? "" : r.verdict);
    if (r.candidate) record("pipeline", "hole: candidate library footprint = the oracle's", (await readFile(join(r.candidate.dir, "C6_Parts.pretty/FIT_P2.kicad_mod"), "utf8")) === (await readFile(join(out, "hole/py/FIT_P2.kicad_mod"), "utf8").catch(() => "?")));
  }
  // copper (kb-fix112 copper.json on its own source project)
  {
    const p = await mkProject("copper", `${KB}/before`, ["C6.kicad_pcb", "C6.kicad_pro", "C6_Parts.pretty"]);
    const plan = JSON.parse(await readFile(`${KB}/copper.json`, "utf8"));
    const r = await runEdit({ projectDir: p, plan: { id: "kbfix112-copper", copper: plan, accept_before }, mode: "full", runners });
    report("copper", r);
    const py = await readFile(join(out, "copper/copper@kbfix112-before/py.kicad_pcb"), "utf8").catch(() => "");
    const cb = r.candidate ? await readFile(r.candidate.pcb, "utf8") : "?";
    record("pipeline", `copper: runEdit candidate board = the oracle's (new uuids masked); proof ${r.verdict}`, !!py && mask(cb) === mask(py), r.candidate ? "" : r.verdict);
  }
  // stack (stack106 plan.json on the pre-stack source)
  {
    const p = await mkProject("stack", `${ST}/release-fab104-source`, ["C6.kicad_pcb", "C6.kicad_pro", "C6_Parts.pretty", "fp-lib-table"], `${ST}/release-fab104-source/requirements/acceptance.json`);
    const plan = JSON.parse(await readFile(`${ST}/plan.json`, "utf8")) as StackSpec & { source?: string; name?: string; stem?: string };
    delete plan.source;
    delete plan.name;
    delete plan.stem;
    const r = await runEdit({ projectDir: p, plan: { id: "stack106", stack: plan, accept_before }, mode: "full", runners });
    report("stack", r);
    const py = await readFile(join(out, "stack/py-plan/C6.kicad_pcb"), "utf8").catch(() => "");
    const cb = r.candidate ? await readFile(r.candidate.pcb, "utf8") : "?";
    record("pipeline", `stack: runEdit candidate board = the oracle's; proof ${r.verdict}`, !!py && cb === py, r.candidate ? "" : r.verdict);
    if (r.candidate) {
      const ca = JSON.parse(await readFile(join(r.candidate.dir, ".fabdesk/board/requirements/acceptance.json"), "utf8"));
      const pa = JSON.parse(await readFile(join(out, "stack/py-plan/requirements/acceptance.json"), "utf8").catch(() => "{}"));
      const pick = (x: Record<string, unknown>) => ({ net_classes: x["net_classes"], supplier_stack: x["supplier_stack"] });
      await writeFile(join(out, "pipeline/stack-acceptance.json"), JSON.stringify(pick(ca), null, 1));
      await writeFile(join(out, "pipeline/stack-acceptance-py.json"), JSON.stringify(pick(pa), null, 1));
      const c = await accCompare(join(out, "pipeline/stack-acceptance-py.json"), join(out, "pipeline/stack-acceptance.json"));
      record("pipeline", "stack: candidate acceptance net_classes and supplier_stack = the oracle's (values and key order)", c.equal && !c.order, c.equal && !c.order ? "" : c);
    }
  }
}

const agree = rows.filter((r) => r.agree).length;
await writeFile(join(out, "parity-editkeys.json"), JSON.stringify({ toolkit: tk, rows }, null, 1));
console.log(`\n${agree}/${rows.length} agree`);
if (agree !== rows.length) process.exitCode = 1;

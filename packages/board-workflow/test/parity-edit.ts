/**
 * Edit stage parity: the toolkit's `flow/edit.py` (impact / apply / diff) against `@fabdesk/board-workflow` edit on one board.
 *
 *   bun packages/board-workflow/test/parity-edit.ts --board DIR --out DIR [--tasks remove,value,move,swap,add,net,posswap] [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli). Per task, on the same plan: impact lines, the apply
 * ledger (moved/carried/displaced/cut nets/copper counts), the planned-vs-collateral diff, the normalised candidate files
 * (board and schematic sheets, uuids masked), and A1-A9 verdicts and figures of each side's own candidate (each side runs
 * its own DRC on its own candidate). Writes parity-edit.json and edit-parity.md into --out.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { drcInputFromFile, onboard, parseBoard, runAcceptance } from "../src/index";
import { runEdit, type EditRunResult, type EditRunners } from "../src/edit/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    out: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    tasks: { type: "string", default: "remove,value,move,swap,add,net,posswap" },
    seeds: { type: "string", default: "0" },
    "impact-only": { type: "boolean", default: false },
    "apply-only": { type: "boolean", default: false },
    "drc-ref": { type: "string" },
  },
});
if (!a.board || !a.out) throw new Error("--board and --out are required");
const out = a.out;
const toolkit = a.toolkit!;
const cliPath = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
const proj = join(out, "proj");
await mkdir(proj, { recursive: true });
for (const n of await readdir(a.board))
  if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty") || n.endsWith(".3dshapes")) await cp(join(a.board, n), join(proj, n), { recursive: true });
const pcbName = (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!;
const stem = pcbName.replace(/\.kicad_pcb$/, "");
const pyEnv = (seed = "0"): Record<string, string> => ({ ...(process.env as Record<string, string>), PCB_SELFRECORD: "off", KICAD_CLI: cliPath, PCB_PROJECT: join(out, "pyroot"), PYTHONHASHSEED: seed });
await mkdir(join(out, "pyroot"), { recursive: true });

async function sh(cmd: string[], env: Record<string, string>, ok = [0]) {
  const t0 = Date.now();
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (!ok.includes(code)) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2500)}`);
  return { out: o, err: e, code, secs: (Date.now() - t0) / 1000 };
}

// ---- project: onboard + baseline in TypeScript; spec for the oracle
const applyOnly = !!a["apply-only"];
const drcRef = a["drc-ref"];
const drc: EditRunners["accept"] = (dir, pcb) =>
  runAcceptance(dir, {
    pcb,
    drc: async ({ board, parity, outFile }) => {
      // a recorded DRC run stands in for the live one on boards too large to run it per edit (apply-only: the edited board is never scored)
      if (drcRef) {
        await cp(drcRef, outFile);
        return drcInputFromFile(outFile);
      }
      await runDrc({ path: cliPath, version: "unknown" }, { board, outFile, severity: "all", schematicParity: parity, refillZones: true });
      return drcInputFromFile(outFile); // owner-excluded violations left out, as the oracle's default flags do
    },
  });
const ob = await onboard(proj, { name: "parity" });
const impactOnly = !!a["impact-only"];
const baseRun = impactOnly ? null : await drc(proj, pcbName);
const baseSummary = baseRun?.result.summary ?? ({} as Record<string, boolean>);
const baseFail = Object.entries(baseSummary).filter(([, v]) => !v).map(([k]) => k);
if (baseRun) console.log(`baseline: ${Object.values(baseSummary).filter(Boolean).length}/9 pass${baseFail.length ? ", failing " + baseFail.join(",") : ""}`);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
const spec = join(out, "spec.json");
if (drcRef) {
  // the oracle scores the unedited project before editing (cached by content hash): give it the same recorded run
  await writeFile(join(out, "spec-before.json"), JSON.stringify({ name: "parity", stem, base: proj, requirements: join(proj, ".fabdesk/board/requirements"), fixed: `^(${ob.fixed.map(esc).join("|")})$`, templates: [] }));
  const key = await sh(["python3", "-c", `import hashlib,sys\nfrom pathlib import Path\nproj=Path(sys.argv[1]); fake=Path(sys.argv[2])/'py'/'remove'; st=sys.argv[3]\nfiles=[(fake/f.name,f) for f in proj.glob('*.kicad_sch')]+[(fake/f'{st}.kicad_pcb',proj/f'{st}.kicad_pcb'),(fake/f'{st}.kicad_pro',proj/f'{st}.kicad_pro')]+[(f,f) for f in (proj/'.fabdesk/board/requirements').glob('*.json')]\nh=hashlib.sha256()\nfor _,f in sorted(files,key=lambda t:str(t[0])):\n    h.update(f.name.encode()); h.update(f.read_bytes())\nprint(h.hexdigest()[:24])`, proj, out, stem], pyEnv());
  const cache = join(out, "pyroot", "work", ".edit-before-cache");
  await mkdir(cache, { recursive: true });
  await sh(["python3", join(toolkit, "tools/check_acceptance.py"), join(proj, pcbName), join(cache, `${key.out.trim()}.json`), "--drc", drcRef], { ...pyEnv(), FLOW_SPEC: join(out, "spec-before.json") });
}
await writeFile(spec, JSON.stringify({ name: "parity", stem, base: proj, requirements: join(proj, ".fabdesk/board/requirements"), fixed: `^(${ob.fixed.map(esc).join("|")})$`, templates: [] }));

// ---- tasks: the toolkit's own rule-based suite (remove, value, move, swap, add, net) plus a position swap of two connectors
const planDir = join(out, "plans");
await mkdir(planDir, { recursive: true });
const gen = await sh(["python3", join(toolkit, "flow/editbench.py"), "tasks", "parity", proj, spec, planDir], pyEnv());
console.log(gen.out.trim());
const text0 = await readFile(join(proj, pcbName), "utf8");
const poseOf = (ref: string): [number, number, number] => {
  const f = parseBoard(text0).footprints.get(ref)!;
  return [f.x, f.y, f.rot];
};
const tasks: Record<string, string> = { remove: "remove", value: "value", move: "move", swap: "swap", add: "add", net: "net" };
if (a.tasks!.split(",").includes("posswap") && parseBoard(text0).footprints.has("J502") && parseBoard(text0).footprints.has("J601")) {
  const [pa, pb] = [poseOf("J502"), poseOf("J601")];
  await writeFile(join(planDir, "posswap.json"), JSON.stringify({ id: "bench-parity-posswap", board: proj, project: proj, spec, reason: "swap J502 and J601", move: [{ ref: "J502", to: pb, carry_auto: ["J502"], anchor: true }, { ref: "J601", to: pa, carry_auto: ["J601"], anchor: true }] }));
  tasks["posswap"] = "posswap";
}

// the toolkit's net task picks one resistor; on boards where its schematic has no label at the pin tip the edit stops on both sides,
// so try further pull resistors until one applies (the stops are compared too)
{
  const b0 = parseBoard(text0);
  const RAIL = /(^|::|_)(\+?\d+V\d*|\d+V\d+|3V3|1V8|1V1|2V5|5V0|VCC|VDD\w*|VBUS\w*|VSYS|V\d\w*)$/i;
  const pairNets = new Set(Object.values(ob.requirements.acceptance.net_classes.classes).flatMap((c) => (c.pairs ?? []).flat()));
  const count = new Map<string, number>();
  for (const p of b0.pads) count.set(p.net, (count.get(p.net) ?? 0) + 1);
  const rails = [...count].filter(([n, c]) => RAIL.test(n) && !/GND/i.test(n) && c >= 3).map(([n]) => n).sort();
  const cands = [...b0.footprints.values()].filter((f) => /(^|_)R\d+$/.test(f.ref) && !ob.fixed.includes(f.ref) && Object.keys(f.pins).length === 2 && Object.values(f.pins).filter((n) => RAIL.test(n)).length === 1 && !Object.values(f.pins).some((n) => pairNets.has(n))).sort((x, y) => (x.ref < y.ref ? -1 : 1));
  const base = JSON.parse(await readFile(join(planDir, "net.json"), "utf8").catch(() => "{}"));
  const mk = (f: (typeof cands)[number], k: number) => {
    const [pd, n] = Object.entries(f.pins).find(([, x]) => RAIL.test(x))!;
    const to = rails.filter((r) => r !== n)[k % Math.max(1, rails.length - 1)]!;
    return { ...base, id: `bench-parity-net-${f.ref}`, reason: `benchmark: ${f.ref}.${pd} from ${n} to ${to}`, net: [{ pin: `${f.ref}.${pd}`, to, tap_width: 0.15, tap_basis: "pull-up/down resistor pad: < 1 mA" }] };
  };
  let n = 0;
  for (const f of cands.slice(0, 12)) {
    const plan = mk(f, n++);
    const pp = join(planDir, `net-${f.ref}.json`);
    await writeFile(pp, JSON.stringify(plan));
    tasks[`net:${f.ref}`] = `net-${f.ref}`;
  }
  if (a.tasks!.split(",").includes("net")) delete tasks["net"];
  else for (const k of Object.keys(tasks)) if (k.startsWith("net:")) delete tasks[k];
}
let netDone = false;

// decisions: a move onto a fixed part, a removal that leaves a pin alone
{
  const b0 = parseBoard(text0);
  const fixedRef = ob.fixed.find((r) => /^J\d/.test(r) && b0.footprints.has(r));
  const mover = [...b0.footprints.values()].find((f) => /^R\d+$/.test(f.ref) && Object.keys(f.pins).length === 2 && !ob.fixed.includes(f.ref));
  if (fixedRef && mover) {
    await writeFile(join(planDir, "stopfixed.json"), JSON.stringify({ id: "bench-parity-stopfixed", board: proj, project: proj, spec, move: [{ ref: mover.ref, to: poseOf(fixedRef) }], displace: { radius: 3 } }));
    tasks["stopfixed"] = "stopfixed";
  }
  const cnt = new Map<string, number>();
  for (const p of b0.pads) cnt.set(p.net, (cnt.get(p.net) ?? 0) + 1);
  const lone = [...b0.footprints.values()].find((f) => /^R\d+$/.test(f.ref) && !ob.fixed.includes(f.ref) && Object.values(f.pins).some((n) => n && !/GND/i.test(n) && cnt.get(n) === 2));
  if (lone) {
    await writeFile(join(planDir, "stopunconn.json"), JSON.stringify({ id: "bench-parity-stopunconn", board: proj, project: proj, spec, remove: [lone.ref] }));
    tasks["stopunconn"] = "stopunconn";
  }
}

type Row = { task: string; item: string; agree: boolean; detail?: unknown };
const rows: Row[] = [];
const record = (task: string, item: string, agree: boolean, detail?: unknown) => {
  rows.push({ task, item, agree, ...(agree ? {} : { detail }) });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${task}: ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 500));
};
const PROSE = new Set(["note", "basis"]);
const prose: string[] = [];
function diff(x: unknown, y: unknown, path: string, acc: string[]): void {
  if (typeof x === "number" && typeof y === "number") {
    if (Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x))) acc.push(`${path}: ${x} != ${y}`);
  } else if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) acc.push(`${path}: length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diff(x[i], y[i], `${path}[${i}]`, acc);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x as object), ...Object.keys(y as object)])) {
      if (!(k in (x as object))) acc.push(`${path}.${k}: only in TS`);
      else if (!(k in (y as object))) acc.push(`${path}.${k}: only in oracle`);
      else if (PROSE.has(k) && typeof (x as never)[k] === "string") {
        if ((x as never)[k] !== (y as never)[k] && !prose.includes(`${path}.${k}`)) prose.push(`${path}.${k}`);
      } else diff((x as never)[k], (y as never)[k], `${path}.${k}`, acc);
    }
  } else if (x !== y) acc.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
}
const mask = (t: string) => t.replace(/\(uuid "[^"]+"\)/g, '(uuid "_")').replace(/\(path "([^"]*)\/[0-9a-f-]{36}"\)/g, '(path "$1/_")').replace(/[ \t]+$/gm, "");
const keysOf = (o: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o![k]]));
const LEDGER = ["moved", "carried", "near", "displaced", "cut_nets", "copper_removed", "copper_moved", "landing_removed_nets", "pruned", "internal_nets_moved", "new_courtyards", "in_way", "carry_auto", "review"];
const timing: Record<string, { py: number; ts: number }> = {};

for (const [task, file] of Object.entries(tasks)) {
  if (task.startsWith("net:") && netDone) continue;
  const planPath = join(planDir, `${file}.json`);
  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch {
    console.log(`task ${task}: no plan generated for this board`);
    continue;
  }
  if (baseFail.length) plan["accept_before"] = Object.fromEntries(baseFail.map((k) => [k, "already failing before the edit"]));
  await writeFile(planPath, JSON.stringify(plan));
  const pyOut = join(out, "py", task);
  // ---- impact
  for (const seed of a.seeds!.split(",")) {
    const r = await sh(["python3", join(toolkit, "flow/edit.py"), "impact", planPath], pyEnv(seed), [0, 1]);
    const pyLines = r.out.trimEnd().split("\n");
    const ts = await runEdit({ projectDir: proj, plan, mode: "impact", runners: { accept: drc } });
    // the oracle prints sets in hash order (PYTHONHASHSEED) where the TS port sorts: compare as multisets of lines, in order when equal
    const same = JSON.stringify(pyLines) === JSON.stringify(ts.impactLines);
    const sameSet = JSON.stringify([...pyLines].sort()) === JSON.stringify([...ts.impactLines].sort());
    record(task, `impact lines${seed !== "0" ? ` (PYTHONHASHSEED=${seed})` : ""}: ${pyLines.length} lines${same ? "" : sameSet ? ", same lines in another order" : ""}`, sameSet, { py: pyLines.filter((l) => !ts.impactLines.includes(l)), ts: ts.impactLines.filter((l) => !pyLines.includes(l)) });
    if (!same && sameSet) rows[rows.length - 1]!.agree = true;
    if (seed === "0" && !same) rows[rows.length - 1]!.detail = { order_differs_only: true };
  }
  if (impactOnly) continue;
  // ---- apply
  const ap = await sh(["python3", join(toolkit, "flow/edit.py"), "apply", planPath, pyOut, "--no-score"], pyEnv(), [0, 1]);
  const t1 = Date.now();
  const ts: EditRunResult = await runEdit({ projectDir: proj, plan, mode: applyOnly ? "apply" : "full", runners: { accept: drc } });
  const tsSecs = (Date.now() - t1) / 1000;
  if (ap.code !== 0 || !ts.candidate) {
    const pyMsg = (ap.out + ap.err).trim().split("\n").pop() ?? "";
    if (task.startsWith("net:") && ap.code !== 0 && !ts.candidate) {
      // a stop is a result: both sides stop on the same finding; try the next resistor
      const norm = (m: string) => m.replace(/^.*SystemExit: /, "").replace(/\(\(([-\d.]+), ([-\d.]+)\)\)/, "($1,$2)").replace(/^(FAIL|STOP)/, "$1");
      const pyMsg2 = norm((ap.out + ap.err).trim().split("\n").pop() ?? "");
      record(task, `stops on the same finding: ${ts.verdict.slice(0, 110)}`, pyMsg2 === ts.verdict, { py: pyMsg2, ts: ts.verdict });
      continue;
    }
    record(task, `apply stops the same way (py: ${pyMsg.slice(0, 160)}; ts: ${ts.verdict.slice(0, 160)})`, ap.code !== 0 && !ts.candidate && pyMsg.replace(/^.*SystemExit: /, "").slice(0, 40) === ts.verdict.slice(0, 40), { py: pyMsg, ts: ts.verdict });
    continue;
  }
  const pyEdit = JSON.parse(await readFile(join(pyOut, "edit.json"), "utf8"));
  const tsEdit = JSON.parse(await readFile(join(ts.candidate.dir, "edit.json"), "utf8"));
  for (const k of ["moves", "landing"] as const) {
    const d: string[] = [];
    const norm = (l: Record<string, unknown> | undefined) => (l ? keysOf(l, LEDGER) : null);
    // the oracle's `why`/`in_way` entries list moving parts in hash order; compare sorted
    const srt = (o: unknown): unknown => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "why" || k === "in_way" ? sortDeep(v) : srt(v)])) : Array.isArray(o) ? o.map(srt) : o);
    const sortDeep = (v: unknown): unknown => (Array.isArray(v) ? [...v].map(String).sort() : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortDeep(x)])) : v);
    diff(srt(norm(pyEdit.applied[k])), srt(norm(tsEdit.applied[k])), k, d);
    record(task, `ledger ${k}: ${pyEdit.applied[k] ? `${(pyEdit.applied[k].moved ?? []).length} moved, ${(pyEdit.applied[k].carried ?? []).length} carried, ${(pyEdit.applied[k].displaced ?? []).length} displaced, ${(pyEdit.applied[k].near ?? []).length} near, cut nets ${(pyEdit.applied[k].cut_nets ?? []).length}, copper removed ${pyEdit.applied[k].copper_removed}` : "none"}`, d.length === 0, d.slice(0, 8));
  }
  const simple = ["footprints", "segments_deleted", "vias_deleted", "arcs_deleted", "pruned_items", "pad_cut", "net_change_pruned", "net_change_padless_deleted", "net_change_padless_nets", "symbols", "schematic_orphans_removed"];
  {
    const d: string[] = [];
    diff(keysOf(pyEdit.applied, simple), keysOf(tsEdit.applied, simple), "applied", d);
    const ch = (l: Array<Record<string, unknown>>) => l.map((x) => keysOf(x, ["pin", "from", "to", "schematic", "label_was", "ref", "pads_without_place", "sym_flags", "near"]));
    diff(ch(pyEdit.applied.net_changes), ch(tsEdit.applied.net_changes), "net_changes", d);
    diff(ch(pyEdit.applied.swaps), ch(tsEdit.applied.swaps), "swaps", d);
    diff(ch(pyEdit.applied.adds), ch(tsEdit.applied.adds), "adds", d);
    record(task, `ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds)`, d.length === 0, d.slice(0, 8));
  }
  // ---- candidate files, uuids masked
  const sheets = (await readdir(proj)).filter((n) => n.endsWith(".kicad_sch"));
  const fileDiffs: string[] = [];
  for (const n of [pcbName, ...sheets]) {
    const pyT = mask(await readFile(join(pyOut, n), "utf8"));
    const tsT = mask(await readFile(join(ts.candidate.dir, n), "utf8"));
    if (pyT !== tsT) {
      const x = pyT.split("\n"), y = tsT.split("\n");
      let i = 0;
      while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
      fileDiffs.push(`${n}: first difference at line ${i + 1}: py ${JSON.stringify(x[i])?.slice(0, 120)} / ts ${JSON.stringify(y[i])?.slice(0, 120)} (${x.length} vs ${y.length} lines)`);
    }
  }
  record(task, `candidate files (board + ${sheets.length} sheets, uuids masked) identical`, fileDiffs.length === 0, fileDiffs);
  // ---- requirements
  for (const f of ["acceptance.json", "circuit.json", "mechanical.json", "heights.json"]) {
    const d: string[] = [];
    const py = JSON.parse(await readFile(join(pyOut, "requirements", f), "utf8"));
    const tsr = JSON.parse(await readFile(join(ts.candidate.dir, ".fabdesk/board/requirements", f), "utf8"));
    // anchors: the oracle writes %g text (6 digits), TS keeps micron text; the ledger keeps the plan's `to` verbatim
    if (f === "mechanical.json") for (const an of [...py.anchors, ...tsr.anchors]) { an.at = an.at.map((v: string) => Number(v)); an.rotation = an.rotation.map((v: string) => Number(v)); }
    if (f === "acceptance.json") for (const o of [py, tsr]) { for (const e of o.edits ?? []) { for (const k of ["swapped", "added", "moved", "carried", "near", "displaced"]) e[k] = JSON.parse(JSON.stringify(e[k] ?? [], (kk, v) => (["library_file", "footprint_file"].includes(kk) ? undefined : v))); } }
    diff(py, tsr, f, d);
    record(task, `requirements/${f}`, d.length === 0, d.slice(0, 8));
  }
  // ---- diff / collateral
  const pd = await sh(["python3", join(toolkit, "flow/edit.py"), "diff", proj, pyOut, "--stem", stem, "--ledger", join(pyOut, "edit.json")], pyEnv());
  const pyDiff = JSON.parse(pd.out);
  // the oracle's diff is of the unrepaired candidate; the TS diff is of the candidate after the (absent) repair hook, which is the same board
  const d1: string[] = [];
  // the oracle iterates a set (hash order) for moved parts and pin-net changes; compare sorted
  const norm = (o: Record<string, unknown>) => ({ removed: o["removed"], added: o["added"], moved: [...(o["moved"] as string[])].sort(), pin_net_changed: [...(o["pin_net_changed"] as object[])].sort((p, q) => (Object.keys(p)[0]! < Object.keys(q)[0]! ? -1 : 1)), copper_changed_nets: o["copper_changed_nets"], vias: o["vias"] });
  diff(norm(pyDiff), norm(ts.diff as never), "diff", d1);
  record(task, `diff: removed ${pyDiff.removed.length}, added ${pyDiff.added.length}, moved ${pyDiff.moved.length}, pin-net changes ${pyDiff.pin_net_changed.length}, copper-changed nets ${Object.keys(pyDiff.copper_changed_nets).length}`, d1.length === 0, d1.slice(0, 8));
  const d2: string[] = [];
  diff({ ...pyDiff.churn, collateral_detail: undefined }, { ...ts.churn, collateral_detail: undefined }, "churn", d2);
  record(task, `churn: planned parts moved ${pyDiff.churn.planned_parts_moved.length}, unplanned ${pyDiff.churn.unplanned_moved.length}, collateral ${pyDiff.churn.collateral_nets} nets / ${pyDiff.churn.collateral_mm} mm`, d2.length === 0, d2);
  if (applyOnly) {
    timing[task] = { py: ap.secs, ts: tsSecs };
    if (task.startsWith("net:")) netDone = true;
    continue;
  }
  // ---- A1-A9 of each side's own candidate (oracle: its own DRC with parity on its own candidate)
  const t2 = Date.now();
  await sh(["python3", join(toolkit, "tools/check_acceptance.py"), join(pyOut, pcbName), join(pyOut, "acceptance-run.json")], { ...pyEnv(), FLOW_SPEC: join(pyOut, "spec.json"), C6_SCORE_PARITY: "1", PATH: `/usr/bin:${process.env["PATH"] ?? ""}` });
  const pyAcc = JSON.parse(await readFile(join(pyOut, "acceptance-run.json"), "utf8"));
  const tsAcc = JSON.parse(await readFile(ts.proof!.record, "utf8"));
  void t2;
  record(task, `A1-A9 summary of the edited candidate: ${Object.values(pyAcc.summary).filter(Boolean).length}/9 pass`, JSON.stringify(pyAcc.summary) === JSON.stringify(tsAcc.summary), { py: pyAcc.summary, ts: tsAcc.summary });
  for (const key of Object.keys(pyAcc.results)) {
    const d: string[] = [];
    diff(pyAcc.results[key], JSON.parse(JSON.stringify(tsAcc.results[key])), key, d);
    record(task, `A1-A9 ${key}`, d.length === 0, d.slice(0, 6));
  }
  const pj = judgeLike(JSON.parse(await readFile(join(pyOut, "before-acceptance.json"), "utf8")), pyAcc, baseFail.length > 0);
  record(task, `verdict: py "${pj}" vs ts "${ts.verdict}"`, pj === ts.verdict, { py: pj, ts: ts.verdict });
  timing[task] = { py: ap.secs, ts: tsSecs };
  if (task.startsWith("net:")) netDone = true;
}

/** editbench.run's verdict rule, applied to the oracle's own acceptance output. */
function judgeLike(before: { summary: Record<string, boolean>; results?: Record<string, Record<string, unknown>> }, acc: { summary: Record<string, boolean>; results: Record<string, Record<string, unknown>> }, heldout: boolean): string {
  const summ = acc.summary;
  if (!heldout) return Object.values(summ).every(Boolean) ? "PASS all A1-A9 with parity" : "FAIL " + Object.entries(summ).filter(([, v]) => !v).map(([k]) => k).join(",");
  let worse = Object.entries(summ).filter(([k, v]) => !v && before.summary[k]).map(([k]) => k);
  const a8b = (before.results?.["A8_pairs"]?.["nets_failing"] as number) ?? 0, a8a = (acc.results["A8_pairs"]?.["nets_failing"] as number) ?? 0;
  if (!summ["A8_pairs"] && !before.summary["A8_pairs"] && a8a > a8b) worse.push(`A8 ${a8b}->${a8a}`);
  const n = (r: { results?: Record<string, Record<string, unknown>> }) => Object.values((r.results?.["A2_drc"]?.["errors"] as Record<string, number>) ?? {}).reduce((x, y) => x + y, 0);
  if (n(acc) > n(before)) worse.push(`A2 errors ${n(before)}->${n(acc)}`);
  const it = (r: { results?: Record<string, Record<string, unknown>> }) => (r.results?.["A3_parity"]?.["items"] as number) ?? 0;
  if (it(acc) > it(before)) worse.push(`A3 items ${it(before)}->${it(acc)}`);
  worse = worse.filter((w) => w !== "A2_drc" && w !== "A3_parity");
  return !worse.length && summ["A1_connectivity"] ? "PASS (no regression)" : `FAIL regress [${worse.map((w) => `'${w}'`).join(", ")}]`;
}

await writeFile(join(out, "parity-edit.json"), JSON.stringify({ rows, timing, baseline: baseSummary }, null, 1));
const md = [
  `# Edit stage parity: ${stem}`,
  "",
  `Board \`${a.board}\`. Oracle: ${toolkit} (\`flow/edit.py\`, \`flow/editbench.py tasks\`). kicad-cli: ${cliPath}. ${baseRun ? `Baseline A1-A9 before any edit: ${Object.entries(baseSummary).map(([k, v]) => `${k.slice(0, 2)} ${v ? "pass" : "FAIL"}`).join(", ")}.` : "Impact only: apply and proof were not run on this board."}`,
  "",
  "| task | item | agrees | detail |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.task} | ${r.item.replace(/\|/g, "/")} | ${r.agree ? "yes" : "NO"} | ${r.agree ? (r.detail ? "`" + JSON.stringify(r.detail).slice(0, 200).replace(/\|/g, "/") + "`" : "") : "`" + JSON.stringify(r.detail).slice(0, 400).replace(/\|/g, "/") + "`"} |`),
  "",
  `Free-text fields that differ (wording only, compared apart): ${prose.length ? prose.join(", ") : "none"}.`,
  "",
  "Seconds, apply (oracle without scoring) / full TS pipeline (impact, apply, proof incl. two DRC runs when the before-score is not cached, diff): " + Object.entries(timing).map(([k, v]) => `${k} ${v.py.toFixed(1)} / ${v.ts.toFixed(1)}`).join(", "),
].join("\n");
await writeFile(join(out, "edit-parity.md"), md);
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} agree`);
process.exit(rows.every((r) => r.agree) ? 0 : 1);

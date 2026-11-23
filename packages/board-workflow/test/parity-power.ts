/**
 * Parity of the power ports against the toolkit's Python scripts, on real boards:
 *   apply_netclasses.py  -> layout/score.ts applyNetclasses (project JSON compared parsed, .kicad_dru as text)
 *   power_escape.py      -> power/escape.ts powerEscape   (added tracks compared as a multiset, uuids aside)
 *   power_planes.py      -> power/planes.ts powerPlanes   (zones compared as sets of rectangles, plus the record)
 *   pour_opens.py        -> power/pour.ts pourOpens       (zones and pours.json; with --score, A1-A9 on refilled DRC too)
 *
 *   bun packages/board-workflow/test/parity-power.ts --out DIR [--only netclasses,escape,planes,pour] [--boards c6,cm5,vme,jetson]
 *                                                    [--score] [--toolkit DIR] [--kicad-cli PATH]
 *
 * Not part of `bun run test` (it needs the Python toolkit with numpy/scipy, and the boards below). power_planes.py has
 * C6's outline box written in: on other boards it runs from a copy whose box comes from the plan (the only change), and
 * pour_opens.py runs from a copy that stops before scoring; --score also runs the original once end to end on cm5 and
 * scores the port's pours the same way (kicad-cli: one DRC at a time). Writes parity-power.json into --out.
 */
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseBoard } from "../src/board";
import { applyNetclasses } from "../src/layout/score";
import { powerEscape, powerPlanes, pourOpens, type PlanesPlan } from "../src/power/index";
import type { Acceptance } from "../src/requirements";
import { kid, kids, parseSexpr, type SNode } from "../src/sexpr";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    only: { type: "string", default: "netclasses,escape,planes,pour" },
    boards: { type: "string", default: "c6,cm5,vme,jetson" },
    score: { type: "boolean", default: false },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
  },
});
if (!a.out) throw new Error("--out DIR");
const OUT = a.out;
const TOOLS = join(a.toolkit!, "tools");
const H = "/home/shane";
const C6 = `${H}/vaio_p_modding/io-c6`;
const CMP = `${H}/pcb-cmp`;

interface Board {
  key: string;
  stem: string;
  req: string;
  /** Boards to run escape / netclasses / planes on. */
  boards: string[];
  /** Scored folders (board + acceptance.drc.json) for pour, or [native DRC json, board] to assemble one from. */
  scored: Array<string | [string, string]>;
  /** pour --nets for boards without power classes. */
  pourNets?: string[];
  planes?: string;
}
const BOARDS: Board[] = [
  {
    key: "c6",
    stem: "C6",
    req: `${C6}/requirements`,
    boards: [`${C6}/work/c6-route85/base87/C6.kicad_pcb`, `${C6}/work/c6-krt88/krt-tmf2/score/C6.kicad_pcb`],
    scored: [`${C6}/work/c6-krt88/krt-tmf2/score`, `${C6}/work/c6-block86/pwr-esc3/score`],
    planes: `${C6}/review/c6-route85/planes-In4.json`,
  },
  {
    key: "cm5",
    stem: "board",
    req: `${CMP}/cm5_minima/onboard3/requirements`,
    boards: [`${CMP}/cm5_minima/proj2/board.kicad_pcb`],
    scored: [`${CMP}/results/cm5-swap--int2--claude/cm5-swap-int2-1794465941/.fabdesk/toolkit/edits/swap-j502-j601-2026-11-12T06-46-00-406Z/ws/s0`],
    pourNets: ["*"],
  },
  { key: "vme", stem: "board", req: `${CMP}/vme-wren/onboard3/requirements`, boards: [`${CMP}/vme-wren/proj2/board.kicad_pcb`], scored: [] },
  {
    key: "jetson",
    stem: "board",
    req: `${CMP}/jetson-agx-thor-baseboard/onboard3/requirements`,
    boards: [`${CMP}/jetson-agx-thor-baseboard/proj2/board.kicad_pcb`],
    // that run's DRC (141 opens) over the reference board: the pours depend only on the DRC items and the acceptance
    scored: [[`${CMP}/results-stopped/v8-hang/jetson-usbswap--pr--claude/jetson-usbswap-pr-1794457573/.fabdesk/toolkit/bench2/s0/acceptance.drc.json`, `${CMP}/jetson-agx-thor-baseboard/proj2/board.kicad_pcb`]],
    pourNets: ["*V*", "GND*"],
  },
];

async function run(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${err.slice(-1500)}`);
  return out;
}

/** A requirements folder with an edited acceptance, and a flow spec naming it (FLOW_SPEC for the toolkit). */
async function reqVariant(dir: string, b: Board, edit: (acc: Acceptance) => void): Promise<{ acc: Acceptance; spec: string }> {
  await rm(dir, { recursive: true, force: true });
  await cp(b.req, join(dir, "requirements"), { recursive: true });
  const acc = JSON.parse(await readFile(join(b.req, "acceptance.json"), "utf8")) as Acceptance;
  edit(acc);
  await writeFile(join(dir, "requirements", "acceptance.json"), JSON.stringify(acc, null, 1));
  const spec = join(dir, "spec.json");
  await writeFile(spec, JSON.stringify({ stem: b.stem, requirements: join(dir, "requirements") }));
  return { acc, spec };
}

const POWERISH = /(^|[:/_])(\+?\d+V\d*|\d+V\d+|VDD\w*|VCC\w*|VBUS\w*|VSYS|VIN\w*|PP\w+|P\d+V\d+\w*|\+\w+)$/i;
/** Give a board without (wide) power classes one, so the escape and pour code paths run: its power-looking nets at 0.6 mm. */
function widePower(acc: Acceptance, text: string): void {
  const counts = new Map<string, number>();
  for (const p of parseBoard(text).pads) if (POWERISH.test(p.net)) counts.set(p.net, (counts.get(p.net) ?? 0) + 1);
  const nets = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n]) => n);
  for (const [k, c] of Object.entries(acc.net_classes.classes)) if (k.startsWith("PWR_")) c.track_width = Math.max(c.track_width ?? 0, 0.6);
  if (!Object.keys(acc.net_classes.classes).some((k) => k.startsWith("PWR_")) && nets.length)
    acc.net_classes.classes["PWR_600"] = { track_width: 0.6, inner_track_width: 0.6, nets } as never;
}

// ---------------------------------------------------------------- canonical forms

const numOr = (x: unknown) => (typeof x === "string" && /^-?[\d.]+(e-?\d+)?$/.test(x) ? Number(x) : x);
function canonSegment(n: SNode): string {
  const p = (k: string) => (kid(n, k) ?? []).slice(1).map(numOr);
  const ends = [JSON.stringify(p("start")), JSON.stringify(p("end"))].sort();
  return JSON.stringify([ends, p("width"), p("layer"), p("net")]);
}
function canonZone(n: SNode): string {
  const g = (k: string) => (kid(n, k) ?? []).slice(1).filter((x) => !Array.isArray(x)).map(numOr);
  const polys = kids(n, "polygon").map((pg) => JSON.stringify(kids(kid(pg, "pts") ?? [], "xy").map((q) => q.slice(1).map(numOr)))).sort();
  const cp_ = kid(n, "connect_pads");
  const fill = kid(n, "fill");
  return JSON.stringify({ net: g("net"), layer: g("layer"), name: g("name"), priority: g("priority"), clearance: cp_ ? (kid(cp_, "clearance") ?? []).slice(1) : null, min: g("min_thickness"), fill: fill ? JSON.stringify(fill) : null, polys });
}
function multiset(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
function diffSets(x: string[], y: string[]): { only_py: string[]; only_ts: string[] } {
  const mx = multiset(x), my = multiset(y);
  const only_py: string[] = [], only_ts: string[] = [];
  for (const [k, v] of mx) for (let i = 0; i < v - (my.get(k) ?? 0); i++) only_py.push(k);
  for (const [k, v] of my) for (let i = 0; i < v - (mx.get(k) ?? 0); i++) only_ts.push(k);
  return { only_py: only_py.slice(0, 5), only_ts: only_ts.slice(0, 5), ...{ n_only_py: only_py.length, n_only_ts: only_ts.length } } as never;
}
const top = (text: string, key: string) => kids(parseSexpr(text), key);
const added = (before: string, after: string, key: string, canon: (n: SNode) => string) => {
  const b = multiset(top(before, key).map(canon));
  const out: string[] = [];
  for (const c of top(after, key).map(canon)) {
    const k = b.get(c) ?? 0;
    if (k > 0) b.set(c, k - 1);
    else out.push(c);
  }
  return out;
};

// ---------------------------------------------------------------- the four checks

type Row = Record<string, unknown> & { tool: string; board: string; pass: boolean };
const rows: Row[] = [];
const only = new Set(a.only!.split(","));
const boards = BOARDS.filter((b) => a.boards!.split(",").includes(b.key));
await mkdir(OUT, { recursive: true });

for (const b of boards) {
  const w = join(OUT, b.key);
  await mkdir(w, { recursive: true });
  const firstText = await readFile(b.boards[0]!, "utf8");

  if (only.has("netclasses")) {
    // every reference board keeps its native rules (apply_netclasses is then a no-op on both sides): judged bare here
    const { acc, spec } = await reqVariant(join(w, "nc-req"), b, (x) => void (x.manufacturing_rules.native_project_rules = false));
    const pro = b.boards[0]!.replace(/\.kicad_pcb$/, ".kicad_pro");
    for (const side of ["py", "ts"]) {
      await mkdir(join(w, `nc-${side}`), { recursive: true });
      await copyFile(pro, join(w, `nc-${side}`, `${b.stem}.kicad_pro`));
    }
    await run(["python3", join(TOOLS, "apply_netclasses.py"), join(w, "nc-py", `${b.stem}.kicad_pro`)], { FLOW_SPEC: spec });
    await applyNetclasses(join(w, "nc-ts", `${b.stem}.kicad_pro`), acc);
    const rd = (s: string, e: string) => readFile(join(w, `nc-${s}`, `${b.stem}.${e}`), "utf8");
    const proSame = JSON.stringify(JSON.parse(await rd("py", "kicad_pro"))) === JSON.stringify(JSON.parse(await rd("ts", "kicad_pro")));
    const druSame = (await rd("py", "kicad_dru")) === (await rd("ts", "kicad_dru"));
    const classes = (JSON.parse(await rd("ts", "kicad_pro")) as { net_settings: { classes: unknown[]; netclass_patterns: unknown[] } }).net_settings;
    rows.push({ tool: "apply_netclasses", board: b.key, pass: proSame && druSame, pro_same: proSame, dru_same: druSame, classes: classes.classes.length, patterns: classes.netclass_patterns.length, dru_rules: (await rd("ts", "kicad_dru")).split("(rule ").length - 1 });
    // native rules: both leave the project alone
    const nat = await reqVariant(join(w, "nc-native"), b, (x) => void (x.manufacturing_rules.native_project_rules = true));
    await copyFile(pro, join(w, "nc-native", `${b.stem}.kicad_pro`));
    const pyNote = await run(["python3", join(TOOLS, "apply_netclasses.py"), join(w, "nc-native", `${b.stem}.kicad_pro`)], { FLOW_SPEC: nat.spec });
    const tsNote = await applyNetclasses(join(w, "nc-native", `${b.stem}.kicad_pro`), nat.acc);
    const untouched = (await readFile(join(w, "nc-native", `${b.stem}.kicad_pro`), "utf8")) === (await readFile(pro, "utf8"));
    rows.push({ tool: "apply_netclasses (native)", board: b.key, pass: untouched && /native project rules kept/.test(pyNote) && /native project rules kept/.test(tsNote), untouched });
  }

  if (only.has("escape")) {
    const { acc, spec } = await reqVariant(join(w, "esc-req"), b, (x) => (b.key === "c6" ? undefined : widePower(x, firstText)));
    for (const [i, board] of b.boards.entries()) {
      const text = await readFile(board, "utf8");
      const pyOut = join(w, `esc-py-${i}.kicad_pcb`);
      const t0 = Date.now();
      const stats = JSON.parse((await run(["python3", join(TOOLS, "power_escape.py"), board, pyOut], { FLOW_SPEC: spec })).trim().split("\n").pop()!);
      const pyS = (Date.now() - t0) / 1000;
      const t1 = Date.now();
      const ts = powerEscape(text, acc);
      const tsS = (Date.now() - t1) / 1000;
      // with the script's track uuids, in order, the whole board must come out byte for byte the same
      const pyText = await readFile(pyOut, "utf8");
      const before = new Set(top(text, "segment").map((n) => String(kid(n, "uuid")?.[1])));
      const ids = top(pyText, "segment").map((n) => String(kid(n, "uuid")?.[1])).filter((u) => !before.has(u));
      let k = 0;
      const replay = powerEscape(text, acc, { uuid: () => ids[k++]! }).text;
      const identical = replay === pyText || (ts.segments.length === 0 && pyText.trimEnd() === text.trimEnd());
      await writeFile(join(w, `esc-ts-${i}.kicad_pcb`), ts.text);
      const d = diffSets(added(text, pyText, "segment", canonSegment), added(text, ts.text, "segment", canonSegment));
      const statsSame = JSON.stringify(stats) === JSON.stringify(ts.stats);
      // byte identity can fail on order alone: the script visits each same-net pin pair once in CPython object-id order
      // (memory addresses), the port in file order, so a bridge may come out reversed or earlier; the set must agree
      rows.push({ tool: "power_escape", board: `${b.key}:${board.split("/").slice(-3, -1).join("/")}`, board_identical: identical, pass: statsSame && !(d as never as { n_only_py: number }).n_only_py && !(d as never as { n_only_ts: number }).n_only_ts, py: stats, ts: ts.stats, py_s: pyS, ts_s: tsS, ...d });
    }
  }

  if (only.has("planes")) {
    const text = firstText;
    let plan: PlanesPlan;
    let script = join(TOOLS, "power_planes.py");
    if (b.planes) plan = JSON.parse(await readFile(b.planes, "utf8")) as PlanesPlan;
    else {
      // a plan of the board's own: its two power nets with most pads on the first inner layer, ground fill
      const bd = parseBoard(text);
      const inner = bd.copperLayers.find((l) => /^In\d+\.Cu$/.test(l));
      const counts = new Map<string, number>();
      for (const p of bd.pads) if (POWERISH.test(p.net)) counts.set(p.net, (counts.get(p.net) ?? 0) + 1);
      const nets = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n], k) => ({ net: n, weight: 1 + 0.25 * k }));
      const acc = JSON.parse(await readFile(join(b.req, "acceptance.json"), "utf8")) as Acceptance;
      const o = bd.outline!;
      plan = { layer: inner ?? "In1.Cu", cell_mm: 0.5, edge_mm: 0.5, reach_mm: 8, clearance_mm: 0.2, fill_net: acc.stack_policy.ground_net ?? "GND", nets, box: [o.minX, o.minY, o.maxX, o.maxY] };
      // the script with its C6 box replaced by the plan's (the only change)
      const src = (await readFile(script, "utf8"))
        .replace("sys.path.insert(0, str(Path(__file__).resolve().parent))", `sys.path.insert(0, ${JSON.stringify(TOOLS)})`)
        .replace("X0, Y0, X1, Y1 = 0 + edge, 0 + edge, 74.9 - edge, 65.4 - edge", "bx = plan['box']; X0, Y0, X1, Y1 = bx[0] + edge, bx[1] + edge, bx[2] - edge, bx[3] - edge");
      if (!src.includes("bx = plan['box']")) throw new Error("power_planes.py changed: the box line was not found");
      script = join(w, "power_planes_box.py");
      await writeFile(script, src);
    }
    const planFile = join(w, "planes-plan.json");
    await writeFile(planFile, JSON.stringify(plan, null, 1));
    const pyOut = join(w, "planes-py.kicad_pcb");
    const t0 = Date.now();
    const rec = JSON.parse((await run(["python3", script, b.boards[0]!, pyOut, planFile])).trim().split("\n").pop()!);
    const pyS = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    const ts = powerPlanes(text, { ...plan, name_prefix: "C6" });
    const tsS = (Date.now() - t1) / 1000;
    await writeFile(join(w, "planes-ts.kicad_pcb"), ts.text);
    const pyText = await readFile(pyOut, "utf8");
    const d = diffSets(top(pyText, "zone").map(canonZone), top(ts.text, "zone").map(canonZone));
    const { box: _box, ...tsRec } = ts.record;
    const recSame = JSON.stringify(rec) === JSON.stringify(tsRec);
    rows.push({ tool: "power_planes", board: b.key, pass: recSame && !(d as never as { n_only_py: number }).n_only_py && !(d as never as { n_only_ts: number }).n_only_ts, py: rec, ts: tsRec, rec_same: recSame, py_s: pyS, ts_s: tsS, ...d });
  }

  if (only.has("pour")) {
    const acc = JSON.parse(await readFile(join(b.req, "acceptance.json"), "utf8")) as Acceptance;
    const spec = join(w, "pour-spec.json");
    await writeFile(spec, JSON.stringify({ stem: b.stem, requirements: b.req }));
    // the script up to its pours (scoring needs kicad-cli: --score runs the original once, below)
    const src = (await readFile(join(TOOLS, "pour_opens.py"), "utf8")).replace("import argparse,", `import sys; sys.path.insert(0, ${JSON.stringify(TOOLS)})\nimport argparse,`);
    const cut = src.indexOf("    for cmd in ([TOOLS / 'apply_netclasses.py'");
    if (cut < 0) throw new Error("pour_opens.py changed: the scoring loop was not found");
    const script = join(w, "pour_opens_noscore.py");
    await writeFile(script, src.slice(0, cut) + "    print(json.dumps(made))\n\n\nif __name__ == '__main__':\n    main()\n");
    for (const [i, sc] of b.scored.entries()) {
      let dir: string;
      if (typeof sc === "string") dir = sc;
      else {
        dir = join(w, `pour-src-${i}`);
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await copyFile(sc[0], join(dir, "acceptance.drc.json"));
        await symlink(sc[1], join(dir, `${b.stem}.kicad_pcb`));
      }
      const pyDir = join(w, `pour-py-${i}`);
      await rm(pyDir, { recursive: true, force: true });
      const nets = b.pourNets ?? [];
      await run(["python3", script, dir, pyDir, ...(nets.length ? ["--nets", ...nets] : [])], { FLOW_SPEC: spec });
      const made = JSON.parse(await readFile(join(pyDir, "pours.json"), "utf8"));
      const drc = JSON.parse(await readFile(join(dir, "acceptance.drc.json"), "utf8")) as { unconnected_items: never[] };
      const text = await readFile(join(dir, `${b.stem}.kicad_pcb`), "utf8");
      const ts = pourOpens(text, acc, drc.unconnected_items, { nets });
      const d = diffSets(added(text, await readFile(join(pyDir, `${b.stem}.kicad_pcb`), "utf8"), "zone", canonZone), added(text, ts.text, "zone", canonZone));
      const madeSame = JSON.stringify(made) === JSON.stringify(ts.made);
      rows.push({ tool: "pour_opens", board: `${b.key}:${i}`, pass: madeSame && !(d as never as { n_only_py: number }).n_only_py && !(d as never as { n_only_ts: number }).n_only_ts, unconnected: drc.unconnected_items.length, pours: ts.made.filter((m) => "layer" in m).length, skipped: ts.made.filter((m) => "skipped" in m).length, made_same: madeSame, ...d });
      await rm(pyDir, { recursive: true, force: true });
    }
  }
}

if (a.score && only.has("pour")) {
  // the original script end to end (pours, rules, A1-A9 on refilled DRC) against the port's pours scored the same way.
  // On cm5 (an onboarded board: checkAcceptance reads the onboarding schema, not C6's legacy acceptance file).
  const { checkAcceptance } = await import("../src/accept");
  const { readRequirementsDir } = await import("../src/layout/score");
  const { runDrc } = await import("../../kicad/src/index");
  const b = BOARDS.find((x) => x.key === "cm5")!;
  const dir = b.scored[0] as string;
  const nets = b.pourNets ?? [];
  const w = join(OUT, "pour-score");
  await rm(w, { recursive: true, force: true });
  await mkdir(w, { recursive: true });
  const spec = join(w, "spec.json");
  await writeFile(spec, JSON.stringify({ stem: b.stem, requirements: b.req }));
  const t0 = Date.now();
  const pyLine = (await run(["python3", join(TOOLS, "pour_opens.py"), dir, join(w, "py"), "--nets", ...nets], { FLOW_SPEC: spec })).trim().split("\n").pop()!;
  const py = JSON.parse(pyLine) as Record<string, unknown>;
  const pyS = (Date.now() - t0) / 1000;
  const req = await readRequirementsDir(b.req);
  const tsDir = join(w, "ts");
  await cp(dir, tsDir, { recursive: true, filter: (s) => !/acceptance.*\.json$|score\.json$|\.kicad_prl$/.test(s) });
  const board = join(tsDir, `${b.stem}.kicad_pcb`);
  const drc0 = JSON.parse(await readFile(join(dir, "acceptance.drc.json"), "utf8")) as { unconnected_items: never[] };
  // Python's zone uuids, in order: KiCad's fill and its unconnected list depend on them, so only then are the two boards
  // (and their DRC) comparable; the boards must then be byte for byte the same
  const pyBoard = await readFile(join(w, "py", `${b.stem}.kicad_pcb`), "utf8");
  const ids = top(pyBoard, "zone").filter((z) => String(kid(z, "name")?.[1] ?? "").startsWith("pour_opens ")).map((z) => String(kid(z, "uuid")?.[1]));
  let k = 0;
  const r = pourOpens(await readFile(board, "utf8"), req.acceptance, drc0.unconnected_items, { nets, uuid: () => ids[k++]! });
  await writeFile(board, r.text);
  const identical = r.text === pyBoard;
  await applyNetclasses(join(tsDir, `${b.stem}.kicad_pro`), req.acceptance);
  const t1 = Date.now();
  // no severity flag, as check_acceptance.py runs it
  const rep = await runDrc({ path: a["kicad-cli"]!, version: "" } as never, { board, outFile: join(tsDir, "acceptance.drc.json"), severity: "project", schematicParity: true, refillZones: true });
  const res = checkAcceptance(parseBoard(await readFile(board, "utf8")), req, { violations: rep.violations, unconnected: rep.unconnected.length, parity: rep.schematicParity.length }, { parityChecked: true, boardPath: board });
  const tsS = (Date.now() - t1) / 1000;
  const ts = { summary: res.summary, open: res.results.A1_connectivity["unconnected"], drc_errors: res.results.A2_drc["errors"], A7_nets_failing: res.results.A7_widths["nets_failing"], A8_nets_failing: res.results.A8_pairs["nets_failing"], pours: r.made.filter((m) => "layer" in m).length };
  const same = JSON.stringify(py) === JSON.stringify(ts);
  rows.push({ tool: "pour_opens (scored)", board: "cm5:0", pass: same && identical, board_identical: identical, py, ts, py_s: pyS, ts_drc_s: tsS });
}

await writeFile(join(OUT, "parity-power.json"), JSON.stringify(rows, null, 1) + "\n");
for (const r of rows) {
  const { tool, board, pass, ...rest } = r;
  console.log(`${pass ? "PASS" : "FAIL"} ${tool} ${board} ${JSON.stringify(rest).slice(0, 400)}`);
}
process.exit(rows.every((r) => r.pass) ? 0 : 1);

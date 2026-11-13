/**
 * Last-mile tool parity: the toolkit at ~/pcb (the oracle) against the TypeScript ports of
 *
 *   netpath    tools/net_path_measure.py                 -> lastmile/netpath.ts measureNetPath
 *   validate   bench.py cmd_validate's pair-net audit    -> lastmile/forensics.ts declaredPairNets + tmPairAudit
 *   view       tools/board_view.py --drc / --layers      -> lastmile/view.ts renderBoardSvg (drc, layers)
 *   region     route_region.py rip + prune + --escape    -> last-mile `cut:` + `escape` (engine steps, no router)
 *   editrun    flow/editbench.py run PLAN OUT            -> bench/editrun.ts runEditBench (scripts/bench.ts edit-run)
 *
 *   bun packages/board-workflow/test/parity-lastmile-tools.ts --out DIR [--toolkit ~/pcb] [--only netpath,validate,view,region]
 *       [--tracemaker BIN] [--slow]   (--slow: netpath on vme too; the oracle takes about an hour there)
 *
 * Not part of `bun run test` (needs the Python toolkit and the owner's boards). Runs no router; the validate section runs
 * TraceMaker's read-only `return-paths` audit (seconds) when --tracemaker is given; editrun (not in the default set) runs
 * kicad-cli DRC on one small edit task, each side in turn. Careful: the oracle's editbench repairs with its configured KRT
 * whenever the edited board has opens or A7 failures (inherited ones too), so point editrun at a board that passes them.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseBoard } from "../src/board";
import { profile } from "../src/accept";
import { measureNetPath, type NetPath } from "../src/lastmile/netpath";
import { declaredPairNets, routerBoard, tmPairAudit } from "../src/lastmile/forensics";
import { nodeRun } from "../src/layout/engines";
import type { LayoutHost } from "../src/layout/ctx";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb" },
    only: { type: "string", default: "netpath,validate,view,region" },
    /** editrun: the board folder and task (one small task; it runs kicad-cli DRC a few times on each side) */
    "edit-board": { type: "string", default: "/home/shane/pcb-cmp/cm5_minima/proj2" },
    "edit-task": { type: "string", default: "value" },
    "edit-heldout": { type: "boolean", default: false },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    tracemaker: { type: "string" },
    /** also the vme board in the netpath section (the oracle takes about an hour on it) */
    slow: { type: "boolean", default: false },
  },
});
if (!a.out) throw new Error("--out is required");
const out = a.out;
const tools = join(a.toolkit!, "tools");
const only = new Set(a.only!.split(","));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

async function run(cmd: string[], env: Record<string, string> = {}, cwd?: string) {
  const p = Bun.spawn(cmd, { env: { ...process.env, PCB_SELFRECORD: "off", ...env }, stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code) throw new Error(`${cmd.join(" ")} -> ${code}\n${(o + e).slice(-2000)}`);
  return o;
}
const rows: Array<{ section: string; item: string; agree: boolean; detail?: unknown }> = [];
const record = (section: string, item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ section, item, agree, ...(agree ? {} : { detail }) });
  console.log(`${agree ? "AGREE " : "DIFFER"} [${section}] ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 1500));
};

// ---------------------------------------------------------------- boards
const C6P = "/home/shane/vaio_p_modding/io-c6";
const STACK8 = ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"];
const boards = join(out, "boards");
await mkdir(boards);
// kb-fix112's release board (sha256 c70c5380..., the board RESULT.txt names) and the courtyard fix after it
for (const c of ["f1a1d256", "32fac8bb"]) await writeFile(join(boards, `C6-${c}.kicad_pcb`), await run(["git", "-C", "/home/shane/vaio_p_modding", "show", `${c}:io-c6/release/C6-eco95/C6.kicad_pcb`]));
interface Case {
  name: string;
  board: string;
  /** FLOW_SPEC for the oracle (C6 is its default board). */
  spec?: string;
  stack: string[];
  acceptance: string;
}
const reqOf = async (dir: string) => JSON.parse(await readFile(join(dir, "acceptance.json"), "utf8"));
const CASES: Case[] = [
  { name: "c6-kbfix112", board: join(boards, "C6-f1a1d256.kicad_pcb"), stack: STACK8, acceptance: `${C6P}/review/kb-fix112/before/requirements` },
  { name: "c6-kbfix112-before", board: `${C6P}/review/kb-fix112/before/C6.kicad_pcb`, stack: STACK8, acceptance: `${C6P}/review/kb-fix112/before/requirements` },
  { name: "c6-courtyard113", board: join(boards, "C6-32fac8bb.kicad_pcb"), stack: STACK8, acceptance: `${C6P}/review/kb-fix112/before/requirements` },
  {
    name: "cm5",
    board: "/home/shane/pcb-cmp/cm5_minima/proj2/board.kicad_pcb",
    spec: "/home/shane/pcb-cmp/cm5_minima/onboard3/spec-routed.json",
    stack: profile(await reqOf("/home/shane/pcb-cmp/cm5_minima/onboard3/requirements")).copper,
    acceptance: "/home/shane/pcb-cmp/cm5_minima/onboard3/requirements",
  },
  {
    name: "vme",
    board: "/home/shane/pcb-cmp/vme-wren/proj2/board.kicad_pcb",
    spec: "/home/shane/pcb-cmp/vme-wren/onboard3/spec-routed.json",
    stack: profile(await reqOf("/home/shane/pcb-cmp/vme-wren/onboard3/requirements")).copper,
    acceptance: "/home/shane/pcb-cmp/vme-wren/onboard3/requirements",
  },
];

// ---------------------------------------------------------------- netpath (item 12)
if (only.has("netpath")) {
  const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
import net_path_measure as npm
text = open(sys.argv[2]).read()
res = {}
for net in json.load(open(sys.argv[3])):
    try:
        res[net] = npm.measure(text, net)
    except Exception as e:
        res[net] = {'error': str(e)}
json.dump(res, open(sys.argv[4], 'w'))
`;
  await writeFile(join(out, "netpath.py"), PY);
  for (const c of CASES) {
    if (c.name === "vme" && !a.slow) continue;
    const text = await readFile(c.board, "utf8");
    const b = parseBoard(text);
    // every net with copper, so nets that are not two-pad are compared on their error too
    const nets = [...new Set(b.segments.map((s) => s.net))].filter(Boolean).sort();
    const nf = join(out, `${c.name}-nets.json`);
    await writeFile(nf, JSON.stringify(nets));
    const t0 = Date.now();
    await run(["nice", "python3", join(out, "netpath.py"), tools, c.board, nf, join(out, `${c.name}-py.json`)], { PYTHONPATH: tools, ...(c.spec ? { FLOW_SPEC: c.spec } : {}) });
    const pyS = (Date.now() - t0) / 1000;
    const py = JSON.parse(await readFile(join(out, `${c.name}-py.json`), "utf8")) as Record<string, NetPath | { error: string }>;
    const t1 = Date.now();
    const ts: Record<string, NetPath | { error: string }> = {};
    for (const n of nets) {
      try {
        ts[n] = measureNetPath(b, n, c.stack);
      } catch (e) {
        ts[n] = { error: (e as Error).message };
      }
    }
    const tsS = (Date.now() - t1) / 1000;
    let measured = 0, exactBits = 0, connected = 0;
    const bad: unknown[] = [];
    let worst = 0;
    for (const n of nets) {
      const p = py[n]!, t = ts[n]!;
      if ("error" in p || "error" in t) {
        if (!("error" in p && "error" in t && p.error === t.error)) bad.push({ net: n, py: p, ts: t });
        continue;
      }
      measured++;
      const pads = JSON.stringify(p.pads) === JSON.stringify(t.pads);
      const nulls = (p.connected_path_mm === null) === (t.connected_path_mm === null);
      const dc = p.connected_path_mm === null || t.connected_path_mm === null ? 0 : Math.abs(p.connected_path_mm - t.connected_path_mm);
      const ds = Math.abs(p.all_segments_mm - t.all_segments_mm);
      worst = Math.max(worst, dc, ds);
      if (p.connected_path_mm !== null) connected++;
      if (p.connected_path_mm === t.connected_path_mm && p.all_segments_mm === t.all_segments_mm) exactBits++;
      if (!pads || !nulls || dc > 1e-9 || ds > 1e-9 || p.note !== t.note) bad.push({ net: n, py: p, ts: t });
    }
    record(
      "netpath",
      `${c.name}: ${nets.length} nets, ${measured} two-pad (${connected} connected), ${exactBits} bit-identical, worst |d| ${worst.toExponential(1)} mm (py ${pyS.toFixed(1)} s, ts ${tsS.toFixed(1)} s)`,
      bad.length === 0,
      bad.slice(0, 5),
    );
    if (c.name === "c6-kbfix112") {
      // the owner's measurement (review/kb-fix112/usb-paths.json, on the routed copy before the release write-out)
      const rec = JSON.parse(await readFile(`${C6P}/review/kb-fix112/usb-paths.json`, "utf8")) as NetPath[];
      const dp = ts["a74::USB_DP"] as NetPath, dm = ts["a74::USB_DM"] as NetPath;
      const mis = Math.abs(dp.connected_path_mm! - dm.connected_path_mm!);
      record("netpath", `kb-fix112 USB connected paths ${dp.connected_path_mm!.toFixed(6)} / ${dm.connected_path_mm!.toFixed(6)} vs recorded ${rec[0]!.connected_path_mm!.toFixed(6)} / ${rec[1]!.connected_path_mm!.toFixed(6)}: mismatch ${mis.toFixed(3)} mm (RESULT.txt 0.841)`, Math.abs(dp.connected_path_mm! - rec[0]!.connected_path_mm!) < 1e-9 && Math.abs(dm.connected_path_mm! - rec[1]!.connected_path_mm!) < 1e-9 && mis.toFixed(3) === "0.841");
    }
  }
}

// ---------------------------------------------------------------- validate (item 3)
if (only.has("validate")) {
  // the oracle's own expression (bench.py cmd_validate), on the same acceptance files
  const PY = `
import json, sys
acc = json.load(open(sys.argv[1]))
print(json.dumps(sorted({n for c in acc['net_classes']['classes'].values() for pair in c.get('pairs', []) for n in pair})))
`;
  await writeFile(join(out, "pairnets.py"), PY);
  for (const c of CASES) {
    const f = join(c.acceptance, "acceptance.json");
    const py = JSON.parse(await run(["python3", join(out, "pairnets.py"), f]));
    const ts = declaredPairNets(JSON.parse(await readFile(f, "utf8")));
    record("validate", `${c.name}: declared pair nets (${ts.length})`, JSON.stringify(py) === JSON.stringify(ts), { py, ts });
  }
  if (a.tracemaker) {
    // return-paths on kb-fix112's board: the oracle's command (krt_board: convert_tracemaker.py, project files beside it)
    // against tmPairAudit on routerBoard's copy; and both against the recorded review/kb-fix112/tm-return-paths.txt
    const c = CASES[0]!;
    const pd = join(out, "rp-py");
    await mkdir(pd);
    await run(["python3", join(tools, "convert_tracemaker.py"), c.board, join(pd, "C6.kicad_pcb")], { PYTHONPATH: tools });
    for (const ext of ["kicad_pro", "kicad_dru"]) await copyFile(`${C6P}/release/C6-eco95/C6.${ext}`, join(pd, `C6.${ext}`)).catch(() => {});
    const nets = declaredPairNets(await reqOf(c.acceptance));
    const pyOut = await run(["nice", a.tracemaker, "return-paths", join(pd, "C6.kicad_pcb"), "--nets", nets.join(",")]);
    const td = join(out, "rp-ts");
    const host = { tools: { tracemaker: a.tracemaker, krt: null, kicadCli: "" }, spawn: nodeRun } as unknown as LayoutHost;
    const rb = await routerBoard(c.board, join(td, "tm"), "C6");
    const audit = await tmPairAudit(host, rb, td, nets);
    record("validate", `kb-fix112 return-paths --nets (${nets.length} nets): TypeScript audit text equals the oracle's command`, audit?.returnPaths === pyOut, { py: pyOut.slice(0, 400), ts: audit?.returnPaths.slice(0, 400) });
    const recorded = await readFile(`${C6P}/review/kb-fix112/tm-return-paths.txt`, "utf8");
    const warn = (t: string) => t.split("\n").filter((l) => l.trimEnd().endsWith("WARN")).length;
    record("validate", `kb-fix112 return-paths vs recorded tm-return-paths.txt: warnings ${audit?.returnPathWarnings} vs ${warn(recorded)}, text ${audit?.returnPaths === recorded ? "identical" : "differs"}`, audit?.returnPathWarnings === warn(recorded), { ts: audit?.returnPaths.slice(0, 600), recorded: recorded.slice(0, 600) });
  }
}

// ---------------------------------------------------------------- view (item 5)
// The owner's board_view calls (review/c6-lastmile89: krt-tmf2's scored board and its DRC report). The script draws with
// matplotlib; a recorder wraps Axes.plot / scatter / text so its primitives can be compared with the SVG's as sets.
const KRT88 = "/home/shane/vaio-io-fresh/work/c6-krt88/krt-tmf2/score";
if (only.has("view")) {
  const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
import matplotlib
matplotlib.use('Agg')
from matplotlib.axes import Axes
rec = {'plot': [], 'scatter': [], 'text': []}
_plot, _scatter, _text = Axes.plot, Axes.scatter, Axes.text
def plot(self, xs, ys, *a, **k):
    rec['plot'].append({'xs': list(map(float, xs)), 'ys': list(map(float, ys)), 'color': k.get('color')})
    return _plot(self, xs, ys, *a, **k)
def scatter(self, xs, ys, *a, **k):
    rec['scatter'].append({'xs': list(map(float, xs)), 'ys': list(map(float, ys)), 'color': k.get('color')})
    return _scatter(self, xs, ys, *a, **k)
def text(self, x, y, s, *a, **k):
    rec['text'].append({'x': float(x), 'y': float(y), 's': s, 'color': k.get('color')})
    return _text(self, x, y, s, *a, **k)
Axes.plot, Axes.scatter, Axes.text = plot, scatter, text
import board_view
dest = sys.argv[3]
sys.argv = ['board_view.py'] + json.loads(sys.argv[2])
board_view.main()
json.dump(rec, open(dest, 'w'))
`;
  await writeFile(join(out, "view.py"), PY);
  const { renderBoardSvg } = await import("../src/lastmile/view");
  const drcFile = join(KRT88, "acceptance.drc.json");
  const drcJson = JSON.parse(await readFile(drcFile, "utf8")) as { unconnected_items: Array<{ items: Array<{ description: string; pos: { x: number; y: number } }> }>; violations: unknown[] };
  const board = parseBoard(await readFile(join(KRT88, "C6.kicad_pcb"), "utf8"));
  const COLS: Record<string, string> = { "#d62728": "F.Cu", "#ff7f0e": "In2.Cu", "#bcbd22": "In3.Cu", "#2ca02c": "In4.Cu", "#17becf": "In5.Cu", "#1f77b4": "B.Cu" };
  const r3 = (x: number) => (Math.round(x * 1000) / 1000).toString();
  const VIEWS: Array<{ name: string; win: [number, number, number, number]; side: "F" | "B" | "both"; layers?: string[] }> = [
    { name: "a-5v0-B", win: [48, 46, 75, 65.4], side: "B" },
    { name: "a-power-B", win: [32, 24, 74, 46], side: "B" },
    { name: "whole-F.Cu,In2.Cu", win: [0, 0, 74.9, 65.4], side: "both", layers: ["F.Cu", "In2.Cu"] },
    { name: "whole-In5.Cu,B.Cu", win: [0, 0, 74.9, 65.4], side: "both", layers: ["In5.Cu", "B.Cu", "In1.Cu"] },
  ];
  for (const v of VIEWS) {
    const args = [join(KRT88, "C6.kicad_pcb"), join(out, `view-${v.name}.png`), "--drc", drcFile, "--window", ...v.win.map(String), "--side", v.side, "--labels", "--title", v.name, ...(v.layers ? ["--layers", v.layers.join(",")] : [])];
    await run(["nice", "python3", join(out, "view.py"), tools, JSON.stringify(args), join(out, `view-${v.name}.json`)], { PYTHONPATH: tools });
    const rec = JSON.parse(await readFile(join(out, `view-${v.name}.json`), "utf8")) as { plot: Array<{ xs: number[]; ys: number[]; color: string }>; scatter: Array<{ xs: number[]; ys: number[]; color: string }>; text: Array<{ x: number; y: number; s: string; color: string }> };
    const svg = renderBoardSvg(board, { window: v.win, side: v.side, labels: true, title: v.name, drc: { unconnected: drcJson.unconnected_items, violations: drcJson.violations as never }, ...(v.layers ? { layers: v.layers } : {}) });
    await writeFile(join(out, `view-${v.name}.svg`), svg);
    const [X0, Y0, X1, Y1] = v.win;
    const vis = (x: number, y: number) => x >= X0 - 2 && x <= X1 + 2 && y >= Y0 - 2 && y <= Y1 + 2;
    const cmpSets = (what: string, py: string[], ts: string[]) => {
      const sp = new Set(py), st = new Set(ts);
      const onlyPy = [...sp].filter((x) => !st.has(x)), onlyTs = [...st].filter((x) => !sp.has(x));
      record("view", `${v.name}: ${what} (${sp.size})`, !onlyPy.length && !onlyTs.length, { onlyPy: onlyPy.slice(0, 5), onlyTs: onlyTs.slice(0, 5) });
    };
    // DRC markers: polylines through each unconnected item's ends, their dots, the net labels
    const pyLines = rec.plot.filter((p) => p.color === "magenta" && p.xs.some((x, i) => vis(x, p.ys[i]!))).map((p) => p.xs.map((x, i) => `${r3(x)},${r3(p.ys[i]!)}`).join(" "));
    const tsLines = [...svg.matchAll(/class="drc-open" points="([^"]+)"/g)].map((m) => m[1]!);
    cmpSets("DRC open lines", pyLines, tsLines);
    const pyDots = rec.scatter.filter((p) => p.color === "magenta" && p.xs.some((x, i) => vis(x, p.ys[i]!))).flatMap((p) => p.xs.map((x, i) => `${r3(x)},${r3(p.ys[i]!)}`));
    const tsDots = [...svg.matchAll(/class="drc-open-end" cx="([^"]+)" cy="([^"]+)"/g)].map((m) => `${m[1]},${m[2]}`);
    cmpSets("DRC open ends", pyDots, tsDots);
    const pyLabels = rec.text.filter((t) => t.color === "purple").map((t) => `${r3(t.x)},${r3(t.y)} ${t.s}`);
    const tsLabels = [...svg.matchAll(/class="drc-open-net" x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]},${m[2]} ${m[3]}`);
    cmpSets("DRC net labels", pyLabels, tsLabels);
    if (v.side === "both") {
      // tracks per layer (the layer filter): the script draws every track on a drawn layer, the SVG those near the window
      const pyTracks = rec.plot.filter((p) => COLS[p.color] && (vis(p.xs[0]!, p.ys[0]!) || vis(p.xs[1]!, p.ys[1]!))).map((p) => `${COLS[p.color]} ${[`${r3(p.xs[0]!)},${r3(p.ys[0]!)}`, `${r3(p.xs[1]!)},${r3(p.ys[1]!)}`].join(" ")}`);
      const tsTracks = [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" stroke="([^"]+)" stroke-width="[^"]+" stroke-linecap="round"/g)].map((m) => `${COLS[m[5]!]} ${m[1]},${m[2]} ${m[3]},${m[4]}`);
      cmpSets(`tracks on ${v.layers!.join(",")}`, pyTracks, tsTracks);
    }
  }
}

// ---------------------------------------------------------------- region (item 6)
// route_region --around-opens M --escape as the owner ran it (c6-block86 iterate.sh), up to the router: the rip of the
// boxes round each open end (verbatim loop from its main()), prune_dangling, then power_escape.py on the ripped board;
// against the last mile's `cut:opens~M` and `escape` steps run by the step engine (no router). The router step after them
// (after-cut, KRT) is not run here (the eval holds the machine); test/lastmile-engine.test.ts runs the whole chain on a
// stubbed KRT.
if (only.has("region")) {
  const PY = `
import json, re, sys, subprocess
sys.path.insert(0, sys.argv[1])
import block_pass, route_region
from route_region import inside, prune_dangling
src, drc, m, out = sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
boxes = json.loads(sys.argv[6])
text = open(src).read()
regions = list(boxes)
for u in json.load(open(drc))['unconnected_items']:
    for i in u['items']:
        regions.append([i['pos']['x'] - m, i['pos']['y'] - m, i['pos']['x'] + m, i['pos']['y'] + m])
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
open(out + '.ripped', 'w').write(text)
esc = json.loads(subprocess.run([sys.executable, sys.argv[1] + '/power_escape.py', out + '.ripped', out], capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
print(json.dumps({'removed': removed, 'escape': esc}))
`;
  await writeFile(join(out, "region.py"), PY);
  const { createStepEngine, stepsFor } = await import("../src/lastmile/index");
  const accC6 = JSON.parse(await readFile(`${C6P}/requirements/acceptance.json`, "utf8"));
  const req = { acceptance: accC6 } as never;
  const drcFile = join(KRT88, "acceptance.drc.json");
  const drcJson = JSON.parse(await readFile(drcFile, "utf8"));
  const engine = createStepEngine({
    req,
    drc: async () => ({ violations: [], unconnected: [], parity: 0 }),
    scorer: { score: async () => { throw new Error("the parity folder is scored already"); } } as never,
    layout: { tools: { krt: null, tracemaker: null, kicadCli: "" } } as never,
    fill: async () => { throw new Error("no router here"); },
    fallbackRouter: "none",
  });
  const mask = (t: string) => t.replace(/\(uuid "[^"]*"\)/g, '(uuid "")').split("\n").map((l) => l.trim()).filter(Boolean).sort();
  for (const [name, m, boxes] of [["opens~1.0", 1.0, []], ["opens~2.5", 2.5, []], ["opens~1.5;box", 1.5, [[40, 30, 52, 40]]]] as Array<[string, number, number[][]]>) {
    const d = join(out, `region-${name.replace(/[^A-Za-z0-9.]+/g, "_")}`);
    const cur = join(d, "cur");
    await mkdir(join(cur, ".lastmile"), { recursive: true });
    await copyFile(join(KRT88, "C6.kicad_pcb"), join(cur, "C6.kicad_pcb"));
    // the step starts from a scored folder: its DRC record is the oracle's acceptance.drc.json
    await writeFile(join(cur, ".lastmile", "drc-run.json"), JSON.stringify({ violations: drcJson.violations, unconnected: drcJson.unconnected_items, parity: 0 }));
    await writeFile(join(cur, ".lastmile", "acceptance.json"), "{}");
    const py = JSON.parse((await run(["nice", "python3", join(out, "region.py"), tools, join(KRT88, "C6.kicad_pcb"), drcFile, String(m), join(d, "py.kicad_pcb"), JSON.stringify(boxes)], { PYTHONPATH: tools })).trim().split("\n").pop()!);
    const action = `region:${boxes.map((b) => b.join(",")).concat([`opens~${m}`]).join(";")}!escape`;
    const steps = stepsFor(action);
    const sig = new AbortController().signal;
    const cutR = await engine.run(steps[0]!, { cur, out: join(d, "cut"), start: cur, pcb: "C6.kicad_pcb", signal: sig });
    if ("error" in cutR) throw new Error(cutR.error);
    const escR = await engine.run(steps[1]!, { cur: cutR.dir, out: join(d, "esc"), start: cur, pcb: "C6.kicad_pcb", signal: sig });
    if ("error" in escR) throw new Error(escR.error);
    const tsRemoved = cutR.info?.["removed"];
    record("region", `${action}: rip counts ${JSON.stringify(tsRemoved)}`, JSON.stringify(tsRemoved) === JSON.stringify(py.removed), { py: py.removed, ts: tsRemoved });
    const ripPy = await readFile(join(d, "py.kicad_pcb.ripped"), "utf8");
    record("region", `${action}: ripped board byte for byte`, ripPy === (await readFile(join(cutR.dir, "C6.kicad_pcb"), "utf8")));
    const escStats = { bridges: escR.info?.["bridges"], stubs: escR.info?.["stubs"], stubs_blocked: escR.info?.["stubs_blocked"] };
    record("region", `${action}: escapes on the ripped board ${JSON.stringify(escStats)}`, JSON.stringify(escStats) === JSON.stringify(py.escape), { py: py.escape, ts: escStats });
    const a = mask(await readFile(join(d, "py.kicad_pcb"), "utf8")), b = mask(await readFile(join(escR.dir, "C6.kicad_pcb"), "utf8"));
    record("region", `${action}: escaped board, lines as a multiset (uuids aside)`, JSON.stringify(a) === JSON.stringify(b), { py: a.length, ts: b.length });
    record("region", `${action}: chain is cut, escape, after-cut`, steps.map((s) => s.planName ?? s.type).join(",") === "cut,escape,after-cut");
  }
}

// ---------------------------------------------------------------- editrun (item 4)
// One edit task (default: cm5's `value` task, no copper change, so no router) through both runners. Compared: the
// result's keys in order, verdict, final and final_detail, churn (but collateral_top's values), agent_coordinates,
// interventions, repair_steps, and the phase names (timings differ by machine and implementation).
if (only.has("editrun")) {
  const { readdir, cp } = await import("node:fs/promises");
  const { bench, onboard, runAcceptance, drcInputFromFile } = await import("../src/index");
  const { runDrc } = await import("../../kicad/src/index");
  const d = join(out, "editrun");
  const proj = join(d, "proj");
  await mkdir(proj, { recursive: true });
  const srcB = a["edit-board"]!;
  for (const n of await readdir(srcB)) if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty")) await cp(join(srcB, n), join(proj, n), { recursive: true });
  const ob = await onboard(proj, { name: "erun" });
  const stem = (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!.replace(/\.kicad_pcb$/, "");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
  const specFile = join(d, "spec.json");
  await writeFile(specFile, JSON.stringify({ name: "erun", stem, base: proj, requirements: join(proj, ".fabdesk/board/requirements"), fixed: `^(${ob.fixed.map(esc).join("|")})$`, templates: [] }));
  const tasks = await bench.writeEditTasks({ name: "erun", src: proj, stem, requirements: join(proj, ".fabdesk/board/requirements"), fixed: `^(${ob.fixed.map(esc).join("|")})$`, spec: specFile, out: join(d, "plans") });
  const task = a["edit-task"]!;
  if (!tasks[task]) throw new Error(`no ${task} task on this board (${Object.keys(tasks).join(", ")})`);
  const planPath = join(d, "plans", `${task}.json`);
  const kcli = { path: a["kicad-cli"]!, version: "" } as never;
  const t0 = Date.now();
  const ts = await bench.runEditBench({
    planPath,
    out: join(d, "ts"),
    heldout: !!a["edit-heldout"],
    toolVersion: "ts",
    accept: (dir, pcb) =>
      runAcceptance(dir, {
        pcb,
        parity: true,
        drc: async ({ board, parity, outFile }) => {
          await runDrc(kcli, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
          return drcInputFromFile(outFile);
        },
      }),
    repair: async () => {
      throw new Error("the editrun parity task needs no repair (pick a task that cuts no copper)");
    },
  });
  const tsS = (Date.now() - t0) / 1000;
  const pyroot = join(d, "pyroot");
  await mkdir(pyroot, { recursive: true });
  const t1 = Date.now();
  await run(["nice", "python3", join(a.toolkit!, "flow/editbench.py"), "run", planPath, join(d, "py"), ...(a["edit-heldout"] ? ["--heldout"] : [])], { KICAD_CLI: a["kicad-cli"]!, PCB_PROJECT: pyroot, PYTHONHASHSEED: "0" });
  const pyS = (Date.now() - t1) / 1000;
  const py = JSON.parse(await readFile(join(d, "py", "result.json"), "utf8")) as Record<string, unknown>;
  console.log(`editrun ${task}: ts ${tsS.toFixed(0)} s (${ts["verdict"]}), py ${pyS.toFixed(0)} s (${py["verdict"]})`);
  const keys = (x: Record<string, unknown>) => Object.keys(x).filter((k) => k !== "candidate");
  // the toolkit opens a bench on every edited board (phase bench_new, after_edit); the edit stage only when the edit cut nets
  const pyKeys = keys(py).filter((k) => !(k === "after_edit" && !("after_edit" in ts)));
  record("editrun", `${task}: result keys in the toolkit's order`, JSON.stringify(pyKeys) === JSON.stringify(keys(ts)), { py: keys(py), ts: keys(ts) });
  const phaseNames = (x: unknown) => Object.keys(x as object).filter((k) => k !== "bench_new");
  record("editrun", `${task}: phases ${Object.keys(ts["phases"] as object).join(",")}`, JSON.stringify(phaseNames(py["phases"])) === JSON.stringify(phaseNames(ts["phases"])), { py: py["phases"], ts: ts["phases"] });
  // a STOP names each side's own folder
  const unpath = (v: unknown) => (typeof v === "string" ? v.replace(/\(see [^)]*\)?/, "(see ...)").replace(/: (use the schematic set|name each in plan).*$/, "") : v);
  for (const k of ["verdict", "final", "final_detail", "agent_coordinates", "interventions", "repair_steps"]) record("editrun", `${task}: ${k} ${JSON.stringify(unpath(ts[k]))}`, JSON.stringify(unpath(py[k])) === JSON.stringify(unpath(ts[k])), { py: py[k], ts: ts[k] });
  const ch = (x: unknown) => {
    const c = { ...(x as Record<string, unknown>) };
    c["collateral_top"] = Object.keys((c["collateral_top"] ?? {}) as object);
    return c;
  };
  record("editrun", `${task}: churn ${JSON.stringify(ch(ts["churn"]))}`, JSON.stringify(ch(py["churn"])) === JSON.stringify(ch(ts["churn"])), { py: py["churn"], ts: ts["churn"] });
  const table = bench.editTable(await bench.readEditResults([join(d, "ts"), join(d, "py")]));
  record("editrun", `${task}: edit-table reads both results (${table.json.length} rows)`, table.json.length === 2 && table.json.every((r) => r.verdict), table.md);
}

await writeFile(join(out, "parity.json"), JSON.stringify({ rows }, null, 1) + "\n");
const bad = rows.filter((r) => !r.agree).length;
console.log(`${rows.length - bad}/${rows.length} agree`);
process.exit(bad ? 1 : 0);

/**
 * Nudge parity: the toolkit's tools/nudge_place.py (the oracle) against @fabdesk/board-workflow's lastmile/nudge on real boards.
 *
 *   bun packages/board-workflow/test/parity-nudge.ts --out DIR [--toolkit DIR] [--pre-change DIR] [--kicad-cli PATH]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli; no router is run). `--toolkit` must hold the keepout
 * change (check_acceptance.keepout_blocks; default ~/pcb, whose working tree has it); `--pre-change` (default the
 * held-out checkout) is run on the R1N rule-area case only, to show what the change does. For every case both sides get the
 * same folder and the same MOVES.json; compared: exit status and message, nudge.json (poses, mate distance, removed,
 * pruned, native courtyard, cut nets), and the written board (bytes, else poses and the copper item set).
 * Writes parity.json into --out; the evidence is docs/evidence/board-workflow/lastmile-nudge-parity.md.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseBoard } from "../src/index";
import type { Requirements } from "../src/requirements";
import { kid, kids, keepoutBlocks, num, parseSexpr, topLevelSpans } from "../src/sexpr";
import { fitStep, NudgeError, nudgeContext, nudgeStep, seatParts, type NudgeMoves, type NudgeRecord } from "../src/lastmile/nudge";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb" },
    "pre-change": { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    only: { type: "string" },
  },
});
if (!a.out) throw new Error("--out is required");
const out = a.out;
const cli = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const BOARDS: Record<string, { dir: string; spec: string }> = {
  cm5: { dir: "/home/shane/pcb-cmp/cm5_minima/proj2", spec: "/home/shane/pcb-cmp/cm5_minima/onboard/spec.json" },
  c6: { dir: "/home/shane/vaio_p_modding/io-c6/release/C6-eco95", spec: "/home/shane/vaio_p_modding/io-c6/release/C6-eco95/spec.json" },
  r1n: { dir: "/home/shane/vaio_p_modding/io-c6/release/R1N-bom", spec: "/home/shane/vaio_p_modding/io-c6/release/R1N-bom/spec.json" },
};

/** The requirements the nudge reads (acceptance, mechanical); the C6 release folder has no heights.json. */
async function readRequirementsDir(dir: string): Promise<Requirements> {
  const j = async (f: string) => JSON.parse(await readFile(join(dir, f), "utf8"));
  return { acceptance: await j("acceptance.json"), mechanical: await j("mechanical.json"), circuit: { components: [], basis: "" }, heights: { entries: [], basis: "" } } as unknown as Requirements;
}

async function run(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: o, stderr: e };
}

const courtyardDrc = async (board: string, report: string) => {
  await run([cli, "pcb", "drc", "--format", "json", "-o", report, board], {});
  const j = JSON.parse(await readFile(report, "utf8")) as { violations: Array<{ type: string; items?: Array<{ description: string }> }> };
  return j.violations.map((v) => ({ rule: v.type, items: v.items ?? [] }));
};

const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 900));
};
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Copper items as a multiset of whitespace-normalised texts without uuid. */
const copperSet = (text: string) => {
  const out: string[] = [];
  for (const k of ["segment", "via", "arc"]) for (const s of topLevelSpans(text, k)) out.push(text.slice(s.start, s.end).replace(/\(uuid "[^"]*"\)/, "").split(/\s+/).join(" "));
  return out.sort();
};

interface Prepared {
  name: string;
  src: string;
  stem: string;
  spec: Record<string, unknown> & { fixed?: string; requirements: string };
  text: string;
}
async function prepare(name: string): Promise<Prepared> {
  const b = BOARDS[name]!;
  const spec = JSON.parse(await readFile(b.spec, "utf8"));
  const stem = String(spec.stem);
  const src = join(out, name, "src");
  await mkdir(src, { recursive: true });
  for (const ext of ["kicad_pcb", "kicad_pro", "kicad_dru"]) await copyFile(join(b.dir, `${stem}.${ext}`), join(src, `${stem}.${ext}`)).catch(() => undefined);
  return { name, src, stem, spec, text: await readFile(join(src, `${stem}.kicad_pcb`), "utf8") };
}

interface Case {
  name: string;
  moves: NudgeMoves;
  /** Also run the pre-change toolkit (keepout rule areas before keepout_blocks). */
  preChange?: boolean;
  /** Also compare the bench `fit` printout (the oracle's cmd_fit format strings applied to its nudge.json). */
  fit?: boolean;
  /** Give the TypeScript side the spec's fixed pattern (as the engine would pass the onboard record's fixed set) instead of the anchors. */
  fixedFromSpec?: boolean;
}

interface Side {
  code: number;
  message: string;
  rec: NudgeRecord | null;
  board: string | null;
}

async function pySide(p: Prepared, c: Case, dir: string, toolkit: string): Promise<Side> {
  await mkdir(dir, { recursive: true });
  const movesFile = join(dir, "moves-in.json");
  // as the bench writes it: every number a float (json.dumps of Python floats), so messages print radius as 2.5 / 1.0
  await writeFile(movesFile, JSON.stringify(c.moves, null, 1).replace(/(?<=[\s\[:])(-?\d+)(?=[,\s\]])/g, "$1.0") + "\n");
  const o = join(dir, "py");
  const r = await run(["python3", join(toolkit, "tools/nudge_place.py"), p.src, o, movesFile], { FLOW_SPEC: BOARDS[p.name]!.spec, PCB_SELFRECORD: "off" });
  const rec = await readFile(join(o, "nudge.json"), "utf8").then((t) => JSON.parse(t) as NudgeRecord, () => null);
  const board = rec ? await readFile(join(o, `${p.stem}.kicad_pcb`), "utf8") : null;
  return { code: r.code, message: r.code ? r.stderr.trim().split("\n").pop()! : "", rec, board };
}

async function tsSide(p: Prepared, c: Case, dir: string): Promise<Side> {
  const req = await readRequirementsDir(p.spec.requirements);
  const o = join(dir, "ts");
  try {
    const rx = new RegExp(p.spec.fixed ?? "_(J|SW)\\d|^FIT_");
    const rec = await nudgeStep({ cur: p.src, out: o, pcb: `${p.stem}.kicad_pcb`, moves: c.moves, req, courtyardDrc, ...(c.fixedFromSpec ? { fixed: (r: string) => rx.test(r) } : {}) });
    return { code: 0, message: "", rec, board: await readFile(join(o, `${p.stem}.kicad_pcb`), "utf8") };
  } catch (e) {
    if (!(e instanceof NudgeError)) throw e;
    const board = e.record ? await readFile(join(o, `${p.stem}.kicad_pcb`), "utf8") : null;
    return { code: 1, message: e.message, rec: e.record ?? null, board };
  }
}

function compareBoards(name: string, py: string, ts: string) {
  if (py === ts) return record(`${name}: written board byte-identical`, true);
  const bp = parseBoard(py);
  const bt = parseBoard(ts);
  const poses = [...bp.footprints].filter(([r, f]) => {
    const g = bt.footprints.get(r);
    return !g || Math.abs(g.x - f.x) > 1e-9 || Math.abs(g.y - f.y) > 1e-9 || g.rot !== f.rot;
  });
  const cp = copperSet(py);
  const ct = copperSet(ts);
  const lines = (t: string) => t.split("\n");
  const lp = lines(py);
  const lt = lines(ts);
  const diff = lp.map((l, i) => (l === lt[i] ? null : { line: i + 1, py: l, ts: lt[i] })).filter(Boolean);
  record(`${name}: written board: poses and copper set equal (bytes differ in ${diff.length} lines)`, !poses.length && same(cp, ct), {
    poses: poses.map(([r]) => r),
    copper: [cp.length, ct.length],
    firstLines: diff.slice(0, 4),
  });
}

async function runCase(p: Prepared, c: Case) {
  const dir = join(out, p.name, c.name.replace(/[^\w.-]+/g, "_"));
  await mkdir(dir, { recursive: true });
  const t0 = Date.now();
  const py = await pySide(p, c, dir, a.toolkit!);
  const t1 = Date.now();
  const ts = await tsSide(p, c, dir);
  const t2 = Date.now();
  const tag = `${p.name} ${c.name}`;
  record(`${tag}: exit ${py.code} / ${ts.code}: ${py.message || "ok"}`, py.code === ts.code && py.message === ts.message, { py: [py.code, py.message], ts: [ts.code, ts.message] });
  if (py.rec || ts.rec) {
    record(`${tag}: nudge.json equal`, same(py.rec, ts.rec), { py: py.rec, ts: ts.rec });
    if (py.rec && ts.rec) {
      record(`${tag}: poses ${JSON.stringify(py.rec.moves.map((m) => [m.ref, m.to, m.mate_distance_mm]))}`, same(py.rec.moves, ts.rec.moves), { py: py.rec.moves, ts: ts.rec.moves });
      record(`${tag}: removed ${py.rec.removed}, pruned ${py.rec.pruned}, cut nets ${py.rec.cut_nets.length}, courtyard ${JSON.stringify(py.rec.native_courtyard)}`, py.rec.removed === ts.rec.removed && py.rec.pruned === ts.rec.pruned && same(py.rec.cut_nets, ts.rec.cut_nets) && same(py.rec.native_courtyard, ts.rec.native_courtyard), { py: py.rec, ts: ts.rec });
    }
  }
  if (py.board && ts.board) compareBoards(tag, py.board, ts.board);
  record(`${tag}: timing oracle ${((t1 - t0) / 1000).toFixed(1)} s, TypeScript ${((t2 - t1) / 1000).toFixed(1)} s`, true);
  if (c.fit) {
    const req = await readRequirementsDir(p.spec.requirements);
    const f = await fitStep({ cur: p.src, out: join(dir, "fit-ts"), pcb: `${p.stem}.kicad_pcb`, moves: c.moves, req, courtyardDrc });
    let pyLines: string[];
    let pyBox: number[] | null = null;
    if (py.code) pyLines = [`NO FIT: ${py.message}`];
    else {
      const script = `
import json, sys
rec = json.load(open(sys.argv[1]))
xs, ys = [], []
for m in rec['moves']:
    print(f"  {m['ref']:12s} {m['from'][0]:7.2f} {m['from'][1]:7.2f} {m['from'][2]:5.0f}  ->  {m['to'][0]:7.2f} {m['to'][1]:7.2f} {m['to'][2]:5.0f}   mate {m['mate_distance_mm']} mm")
    xs += [m['from'][0], m['to'][0]]; ys += [m['from'][1], m['to'][1]]
print(f"  copper removed {rec['removed']}, cut pairs/nets {len(rec.get('cut_nets', []))}, native courtyard {rec['native_courtyard'] or 'clean'}")
print(json.dumps([min(xs) - 4, min(ys) - 4, max(xs) + 4, max(ys) + 4]))
`;
      const r = await run(["python3", "-c", script, join(dir, "py", "nudge.json")], {});
      const ls = r.stdout.trimEnd().split("\n");
      pyBox = JSON.parse(ls.pop()!);
      pyLines = ls;
    }
    const tsLines = f.fit ? f.lines.slice(0, -1) : f.lines;
    record(`${tag}: fit printout ${JSON.stringify(pyLines)}`, same(pyLines, tsLines) && (pyBox === null || same(pyBox, f.box)), { py: [pyLines, pyBox], ts: [tsLines, f.box] });
    if (f.fit) record(`${tag}: fit window picture ${f.svg} (the oracle draws a matplotlib PNG; pictures not compared)`, true);
  }
  if (c.preChange) {
    const old = await pySide(p, c, join(dir, "pre"), a["pre-change"]!).catch((e) => ({ code: -1, message: String(e), rec: null, board: null }));
    record(`${tag}: pre-change toolkit (every keepout zone blocks): ${old.code ? old.message : JSON.stringify(old.rec?.moves.map((m) => m.to))}`, true, old);
  }
}

// ---------------------------------------------------------------- cases

const firstPad = (p: Prepared, ref: string) => parseBoard(p.text).pads.find((q) => q.ref === ref)!.pad;

async function fixedRow(p: Prepared) {
  const req = await readRequirementsDir(p.spec.requirements);
  const ctx = nudgeContext(req);
  const rx = new RegExp(p.spec.fixed ?? "_(J|SW)\\d|^FIT_");
  const refs = [...parseBoard(p.text).footprints.keys()];
  const py = refs.filter((r) => rx.test(r)).sort();
  const ts = refs.filter((r) => ctx.fixed(r)).sort();
  record(`${p.name}: fixed parts, spec pattern (oracle) vs requirements anchors (TypeScript): ${py.length} / ${ts.length}`, same(py, ts), {
    onlyPy: py.filter((r) => !ts.includes(r)),
    onlyTs: ts.filter((r) => !py.includes(r)),
  });
  record(`${p.name}: ground net ${ctx.ground}`, true);
}

/** A point inside an allow-all "BENCH ... landing" rule area where `ref` fits at ring 0 (found with the TypeScript search). */
function landingPoint(p: Prepared, ref: string): { point: [number, number]; zone: string } | null {
  const root = parseSexpr(p.text);
  const req = { fixed: () => false, ground: "GND", pairs: [] };
  for (const z of kids(root, "zone")) {
    const nm = String(kid(z, "name")?.[1] ?? "");
    if (!kid(z, "keepout") || keepoutBlocks(z, ["footprints", "tracks"]) || !/^BENCH .*landing/.test(nm)) continue;
    const pts = kids(kid(kids(z, "polygon")[0] ?? ["polygon"], "pts") ?? ["pts"], "xy").map((q) => [num(q[1]), num(q[2])] as [number, number]);
    if (!pts.length) continue;
    const [x0, y0, x1, y1] = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
    for (let x = x0 + 1; x < x1 - 1; x += 0.5)
      for (let y = y0 + 1; y < y1 - 1; y += 0.5) {
        const pt: [number, number] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
        try {
          seatParts(p.text, { clearance: 0.2, edge: 0.4, moves: [{ ref, near: pt, radius: 0.05 }] }, req);
          return { point: pt, zone: nm };
        } catch {
          /* next point */
        }
      }
  }
  return null;
}

const N = (moves: NudgeMoves["moves"], clearance = 0.2, edge = 0.4): NudgeMoves => ({ clearance, edge, moves });

const plan: Record<string, (p: Prepared) => Case[]> = {
  cm5: (p) => [
    { name: "near point R704", moves: N([{ ref: "R704", near: [117.0, 70.5], radius: 2.5 }]), fit: true },
    { name: "near REF C705->C704, four rotations", moves: N([{ ref: "C705", near: "C704", radius: 2.5, rotations: [0, 90, 180, 270] }]) },
    { name: `near REF.PAD R606->D606.${firstPad(p, "D606")}`, moves: N([{ ref: "R606", near: `D606.${firstPad(p, "D606")}`, radius: 3 }]) },
    { name: "pair part D101 (USB_C pair cut whole)", moves: N([{ ref: "D101", near: [86.15, 53.4], radius: 2.5 }]) },
    { name: "keepout blocks R704 (radius 1)", moves: N([{ ref: "R704", near: [116.9, 77.7], radius: 1 }]) },
    { name: "keepout pushes R704 out (radius 4)", moves: N([{ ref: "R704", near: [116.9, 77.7], radius: 4 }]) },
    { name: "fixed part J1", moves: N([{ ref: "J1", near: [100, 50], radius: 2.5 }]), fit: true },
    { name: "two moves R402 & R401->R402", moves: N([{ ref: "R402", near: [101.15, 32.0], radius: 2.5 }, { ref: "R401", near: "R402", radius: 3 }]) },
    { name: "turn R606 @90", moves: N([{ ref: "R606", radius: 2.5, rotations: [90] }]) },
    { name: "MOVES.json defaults (no clearance/edge/radius)", moves: { moves: [{ ref: "C708", near: [122.46, 66.8] }] } },
  ],
  c6: (p) => [
    { name: "pair part C18_R105 (USB pair cut whole)", moves: N([{ ref: "C18_R105", near: [62.6, 56.5], radius: 2.5 }]) },
    { name: "keepout and FIT_HA block C18_R306 (radius 0.5)", moves: N([{ ref: "C18_R306", near: [1.8, 5.2], radius: 0.5 }]) },
    { name: "C18_R306 near FIT_HA keepout (radius 4)", moves: N([{ ref: "C18_R306", near: [1.8, 5.2], radius: 4 }]) },
    { name: "fixed part A74_J1", moves: N([{ ref: "A74_J1", near: [60, 10], radius: 2.5 }]) },
    { name: "fixed part FIT_HA", moves: N([{ ref: "FIT_HA", near: [3, 3], radius: 2.5 }]) },
    { name: "turn B-side C18_C210 @0/180", moves: N([{ ref: "C18_C210", radius: 2.5, rotations: [0, 180] }]), fit: true },
    { name: `near REF.PAD C18_R303->C18_R306.${firstPad(p, "C18_R306")}`, moves: N([{ ref: "C18_R303", near: `C18_R306.${firstPad(p, "C18_R306")}`, radius: 3 }]) },
    { name: "unknown part", moves: N([{ ref: "NOPE1", near: [10, 10], radius: 2.5 }]) },
    { name: "C18_J102: fixed by the spec pattern, not a mechanical anchor (TS default: anchors)", moves: N([{ ref: "C18_J102", radius: 2.5, rotations: [0, 90, 180, 270] }]) },
    { name: "C18_J102 with the spec's fixed set given to TS", moves: N([{ ref: "C18_J102", radius: 2.5, rotations: [0, 90, 180, 270] }]), fixedFromSpec: true },
  ],
  r1n: (p) => {
    const land = landingPoint(p, "CSEQ1");
    if (land) console.log(`r1n landing point ${JSON.stringify(land)}`);
    return [
      ...(land ? [{ name: `allow-all rule area '${land.zone}' does not block CSEQ1 at ${land.point.join(",")}`, moves: N([{ ref: "CSEQ1", near: land.point, radius: 0.05 }]), preChange: true }] : []),
      ...(land ? [{ name: `CSEQ1 into '${land.zone}' (radius 2.5)`, moves: N([{ ref: "CSEQ1", near: land.point, radius: 2.5 }]), preChange: true }] : []),
      { name: "pair part D704 (USB3 RX1 cut whole)", moves: N([{ ref: "D704", near: [12.45, 37.5], radius: 2.5 }]), fit: true },
      { name: "fixed part J101", moves: N([{ ref: "J101", near: [10, 30], radius: 2.5 }]) },
      { name: "near REF R716->R702, four rotations", moves: N([{ ref: "R716", near: "R702", radius: 2.5, rotations: [0, 90, 180, 270] }]) },
      { name: "two moves D706 & D707 (two pairs, second sees the first's new box)", moves: N([{ ref: "D706", near: [13.5, 44.35], radius: 2.5 }, { ref: "D707", near: "D706", radius: 3 }]), fit: true },
      { name: `near REF.PAD RUSB2->RUSB1.${firstPad(p, "RUSB1")}`, moves: N([{ ref: "RUSB2", near: `RUSB1.${firstPad(p, "RUSB1")}`, radius: 3 }]) },
    ];
  },
};

for (const name of Object.keys(BOARDS)) {
  if (a.only && !a.only.split(",").includes(name)) continue;
  const p = await prepare(name);
  await fixedRow(p);
  for (const c of plan[name]!(p)) await runCase(p, c);
}

await writeFile(join(out, "parity.json"), JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => !r.agree);
console.log(`\n${rows.length - bad.length}/${rows.length} agree`);

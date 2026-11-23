/**
 * Rip parity: the toolkit's tools/rip_items.py (Python oracle) against lastmile/rip.ts on one routed board.
 *
 *   bun packages/board-workflow/test/parity-rip.ts --board DIR --spec SPEC.json --out DIR [--kicad-cli PATH] [--toolkit DIR] [--perturb N]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli). One refilled-zone DRC run and one oracle
 * check_acceptance per scored folder; both sides read the same DRC report and the same acceptance.json (the oracle's
 * `acceptance.drc.json` / `acceptance.json`, the port's `.lastmile/drc-run.json` / `.lastmile/acceptance.json`). Every rip
 * mode is run on both sides from the same folder; compared: rip.json fields, rip.json bytes (the `src` line aside), the
 * set of removed items (by uuid, rip and prune together) and the bytes of the ripped board.
 *
 * --perturb N: also a "cur" board with N copied tracks that collide with existing copper (half carry an open net of the
 * start board, so `--spare-open-nets START` keeps them; half lie on pair copper with a plain net, for `--spare-pairs`),
 * scored, for the --drc rows. No router runs. Writes rip-parity.json and rip-parity.md into --out.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runDrc } from "../../kicad/src/index";
import { checkAcceptance, lastmile as L, parseBoard, topLevelSpans, type Requirements } from "../src/index";
import * as R from "../src/lastmile/rip";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    spec: { type: "string" },
    out: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    perturb: { type: "string", default: "8" },
    only: { type: "string" },
  },
});
if (!a.board || !a.out || !a.spec) throw new Error("--board, --spec and --out are required");
const out = a.out;
const tk = a.toolkit!;
const cli = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const spec = JSON.parse(await readFile(a.spec, "utf8"));
const pcb = `${spec.stem ?? "C6"}.kicad_pcb`;
const env = { ...process.env, PCB_SELFRECORD: "off", KICAD_CLI: cli, FLOW_SPEC: a.spec, C6_SCORE_PARITY: "0" };
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
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 800));
};
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

// ---- requirements as the port reads them. The toolkit's boardctx fills a C6_ACCEPTANCE_V1 file's missing stack facts
// (ground IO_GND, eight copper layers); a board onboarded by fabdesk writes them itself, so the harness writes them here.
const reqDir = spec.requirements as string;
const acceptance = JSON.parse(await readFile(join(reqDir, "acceptance.json"), "utf8"));
if (acceptance.schema === "C6_ACCEPTANCE_V1") {
  acceptance.stack_policy = { ...acceptance.stack_policy };
  acceptance.stack_policy.ground_net ??= "IO_GND";
  acceptance.stack_policy.copper_layers ??= ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"];
  const pl = acceptance.stack_policy.plane_layers;
  if (pl && !Array.isArray(pl)) acceptance.stack_policy.plane_layers = Object.keys(pl); // C6 writes {layer: net}
  acceptance.stack_policy.plane_layers ??= ["In1.Cu", "In6.Cu"];
  acceptance.stack_policy.via_spans ??= { through: [["F.Cu", "B.Cu"]], blind: [["In1.Cu", "In6.Cu"]], micro: [["F.Cu", "In1.Cu"], ["In6.Cu", "B.Cu"]] };
}
const readOr = async (p: string, d: unknown) => readFile(p, "utf8").then(JSON.parse, () => d);
const root = dirname(reqDir);
const req = {
  acceptance,
  circuit: await readOr(join(root, acceptance.authority?.circuit ?? "requirements/circuit.json"), { components: [], basis: "" }),
  mechanical: await readOr(join(root, acceptance.authority?.mechanical ?? "requirements/mechanical.json"), { units: "mm", anchors: [], basis: "" }),
  heights: { entries: [], basis: "" },
} as unknown as Requirements;
const ctx = R.ripContext(req);
record(`context: ground ${ctx.ground}, ${ctx.stack.length} copper layers (schema ${acceptance.schema})`, true);

// ---- scored folders: one DRC report, the oracle's acceptance.json, both sides' file names
async function score(dir: string, label: string) {
  const t = Date.now();
  const r = await runDrc({ path: cli, version: "" } as never, { board: join(dir, pcb), outFile: join(dir, "acceptance.drc.json"), severity: "project", refillZones: true });
  await sh(["python3", join(tk, "tools/check_acceptance.py"), join(dir, pcb), join(dir, "acceptance.json"), "--drc", join(dir, "acceptance.drc.json")]);
  await mkdir(join(dir, ".lastmile"), { recursive: true });
  const run: L.DrcRun = { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
  await writeFile(join(dir, ".lastmile", "drc-run.json"), JSON.stringify(run) + "\n");
  await cp(join(dir, "acceptance.json"), join(dir, ".lastmile", "acceptance.json"));
  const pyAcc = JSON.parse(await readFile(join(dir, "acceptance.json"), "utf8"));
  const kinds: Record<string, number> = {};
  for (const v of r.violations) kinds[v.rule] = (kinds[v.rule] ?? 0) + 1;
  const a8 = Object.keys(pyAcc.results.A8_pairs.detail ?? {});
  console.log(`${label}: ${r.unconnected.length} open, A8 ${a8.length} nets, A7 ${pyAcc.results.A7_widths.nets_failing}, DRC ${JSON.stringify(kinds)} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  // the port's own A8 verdict on the same DRC (rip reads the acceptance file; this row only says the two would agree)
  try {
    const ts = checkAcceptance(parseBoard(await readFile(join(dir, pcb), "utf8")), req, { violations: r.violations, unconnected: r.unconnected.length, parity: 0 }, { parityChecked: false });
    record(`${label}: TypeScript checkAcceptance A8 failing nets equal the oracle's (${a8.length})`, same(Object.keys(ts.results.A8_pairs["detail"] as object).sort(), [...a8].sort()), { py: a8, ts: Object.keys(ts.results.A8_pairs["detail"] as object) });
  } catch (e) {
    record(`${label}: TypeScript checkAcceptance not run (${(e as Error).message.slice(0, 80)})`, true);
  }
  return { run, pyAcc, kinds, a8 };
}

const start = join(out, "start");
await L.copyBoardFolder(a.board, start);
const s0 = await score(start, "start");
const boardText = await readFile(join(start, pcb), "utf8");
const board = parseBoard(boardText);

// ---- the perturbed "cur" board
const cur = join(out, "cur");
const nPerturb = Number(a.perturb);
if (nPerturb > 0) {
  await L.copyBoardFolder(start, cur);
  const its = R.ripItems(boardText);
  const pairNets = new Set(Object.values(acceptance.net_classes.classes as Record<string, { pairs?: string[][] }>).flatMap((c) => (c.pairs ?? []).flat()));
  const zoneNets = new Set(board.zones.map((z) => z.net));
  const openNets = [...R.openNetsOf(s0.run)].filter((n) => !pairNets.has(n) && n !== ctx.ground).sort();
  const plain = its.filter((i) => i.kind === "segment" && !pairNets.has(i.net) && !zoneNets.has(i.net) && i.net !== ctx.ground && i.net);
  const pairSegs = its.filter((i) => i.kind === "segment" && pairNets.has(i.net));
  // each new track starts on its own net's copper and ends on the nearest track of another net on the same layer, so
  // KiCad keeps both nets as written (a copy touching only its source copper would be re-netted on load) and reports a
  // short; even k: the new track's net is open on the start board when it has opens (for --spare-open-nets); odd k: it
  // ends on pair copper (for --spare-pairs)
  const extra: string[] = [];
  const used = new Set<string>();
  for (let k = 0; k < nPerturb; k++) {
    const openPool = plain.filter((i) => openNets.includes(i.net));
    const pool = k % 2 === 0 && openPool.length ? openPool : plain;
    const targets = k % 2 === 1 && pairSegs.length ? pairSegs : plain;
    for (let tries = 0; tries < pool.length; tries++) {
      const src = pool[(Math.floor(((k + 1) * pool.length) / (nPerturb + 2)) + tries * 7) % pool.length]!;
      if (used.has(src.net)) continue;
      const p = src.pts[0]!;
      let best: { q: [number, number]; d: number } | null = null;
      for (const t of targets) {
        if (t.net === src.net || t.layer !== src.layer) continue;
        const [a0, b0] = [t.pts[0]!, t.pts[t.pts.length - 1]!];
        const L2 = (b0[0] - a0[0]) ** 2 + (b0[1] - a0[1]) ** 2;
        const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a0[0]) * (b0[0] - a0[0]) + (p[1] - a0[1]) * (b0[1] - a0[1])) / L2));
        const q: [number, number] = [a0[0] + u * (b0[0] - a0[0]), a0[1] + u * (b0[1] - a0[1])];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d > 0.3 && d < 2.0 && (!best || d < best.d)) best = { q, d };
      }
      if (!best) continue;
      used.add(src.net);
      const w = /\(width ([-\d.]+)\)/.exec(boardText.slice(src.span.start, src.span.end))?.[1] ?? "0.2";
      extra.push(`\n\t(segment (start ${p[0]} ${p[1]}) (end ${best.q[0].toFixed(4)} ${best.q[1].toFixed(4)}) (width ${w}) (layer "${src.layer}") (net "${src.net}") (uuid "rip-parity-${k}"))`);
      break;
    }
  }
  // right after the last track (KiCad drops items written after `embedded_fonts`), uuids KiCad keeps as written
  const at = its.filter((x) => x.kind === "segment").at(-1)!.span.end;
  const text = boardText.slice(0, at) + extra.join("").replace(/rip-parity-(\d+)/g, (_m, k) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`) + boardText.slice(at);
  await writeFile(join(cur, pcb), text);
  await score(cur, "cur");
}

// ---- the modes
const ol = board.outline!;
const box = [ol.minX + (ol.maxX - ol.minX) * 0.4, ol.minY + (ol.maxY - ol.minY) * 0.4, ol.minX + (ol.maxX - ol.minX) * 0.6, ol.minY + (ol.maxY - ol.minY) * 0.6].map((v) => v.toFixed(2));
const failingPairs = (acceptance.net_classes.classes as Record<string, { pairs?: string[][] }>);
const firstFailing = Object.values(failingPairs).flatMap((c) => c.pairs ?? []).find((pr) => pr.some((n) => s0.a8.includes(n)));
const rx = firstFailing ? "^" + firstFailing[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$" : "^NONE$";
const types = Object.keys(s0.kinds).filter((k) => /track|via|clearance|short|crossing/.test(k)).join(",") || "track_width";
const modes: Array<{ name: string; src: string; args: string[] }> = [
  { name: "around-opens 1.0 spare-pairs (blockers)", src: start, args: ["--around-opens", "1.0", "--spare-pairs"] },
  { name: "around-opens 2.0", src: start, args: ["--around-opens", "2.0"] },
  { name: "a7", src: start, args: ["--a7"] },
  { name: "a8 all", src: start, args: ["--a8"] },
  { name: "a8 short around-ripped 1.0 spare-pairs (legs)", src: start, args: ["--a8", "short", "--around-ripped", "1.0", "--spare-pairs"] },
  { name: "a8 long around-ripped 0.5", src: start, args: ["--a8", "long", "--around-ripped", "0.5"] },
  { name: "a8-uncoupled (reroute)", src: start, args: ["--a8-uncoupled", ""] },
  { name: "a8-uncoupled rip-pad-stubs (reroute!)", src: start, args: ["--a8-uncoupled", "", "--rip-pad-stubs"] },
  { name: `a8-uncoupled ${rx}`, src: start, args: ["--a8-uncoupled", rx] },
  { name: `window ${box.join(",")} spare-pairs`, src: start, args: ["--window", ...box, "--spare-pairs"] },
  { name: "window, nets filter, no-prune", src: start, args: ["--window", ...box, "--nets", "*,!*GND*,!*5V*", "--no-prune"] },
  { name: `drc ${types}`, src: start, args: ["--drc", types] },
  { name: "drc SHORTS spare-pairs (shorts, start)", src: start, args: ["--drc", L.SHORTS, "--spare-pairs"] },
  ...(nPerturb > 0
    ? [
        { name: "cur: drc SHORTS", src: cur, args: ["--drc", L.SHORTS] },
        { name: "cur: drc SHORTS spare-pairs (shorts)", src: cur, args: ["--drc", L.SHORTS, "--spare-pairs"] },
        { name: "cur: drc SHORTS spare-open-nets START (leg repair)", src: cur, args: ["--drc", L.SHORTS, "--spare-open-nets", start] },
        { name: "cur: drc SHORTS + around-opens 1.0 + a7", src: cur, args: ["--drc", L.SHORTS, "--around-opens", "1.0", "--a7"] },
      ]
    : []),
].filter((m) => !a.only || m.name.includes(a.only));

const itemSet = (text: string) => {
  const m = new Map<string, number>();
  for (const k of ["segment", "via", "arc"]) for (const s of topLevelSpans(text, k)) {
    const t = text.slice(s.start, s.end);
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
};
const srcItems = new Map<string, Map<string, number>>();
const removedOf = (src: Map<string, number>, text: string) => {
  const after = itemSet(text);
  const gone: string[] = [];
  for (const [t, n] of src) for (let k = (after.get(t) ?? 0); k < n; k++) gone.push(/\(uuid "([^"]*)"\)/.exec(t)?.[1] ?? t.slice(0, 60));
  return gone.sort();
};

let i = 0;
for (const m of modes) {
  i++;
  const tag = `m${String(i).padStart(2, "0")}`;
  const pyOut = join(out, `${tag}-py`);
  const tsOut = join(out, `${tag}-ts`);
  const t0 = Date.now();
  await sh(["python3", join(tk, "tools/rip_items.py"), m.src, pyOut, ...m.args]);
  const pySec = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  let tsRec: R.RipRecord;
  try {
    tsRec = await R.ripStep({ cur: m.src, out: tsOut, pcb, args: m.args, req });
  } catch (e) {
    record(`${m.name}: TypeScript failed`, false, (e as Error).message);
    continue;
  }
  const tsSec = (Date.now() - t1) / 1000;
  const pyRec = JSON.parse(await readFile(join(pyOut, "rip.json"), "utf8")) as R.RipRecord;
  const srcText = await readFile(join(m.src, pcb), "utf8");
  if (!srcItems.has(m.src)) srcItems.set(m.src, itemSet(srcText));
  const pyText = await readFile(join(pyOut, pcb), "utf8");
  const tsText = await readFile(join(tsOut, pcb), "utf8");
  const pyGone = removedOf(srcItems.get(m.src)!, pyText);
  const tsGone = removedOf(srcItems.get(m.src)!, tsText);
  const diffs: Record<string, unknown> = {};
  for (const k of ["removed", "pruned", "nets", "open_before"] as const) if (!same(pyRec[k], tsRec[k])) diffs[k] = { py: pyRec[k], ts: tsRec[k] };
  if (!same(Object.entries(pyRec.by_reason), Object.entries(tsRec.by_reason))) diffs["by_reason"] = { py: pyRec.by_reason, ts: tsRec.by_reason };
  let windowsNote = "";
  if (!same(pyRec.windows, tsRec.windows)) {
    const key = (w: number[][]) => w.map((x) => JSON.stringify(x)).sort();
    if (same(key(pyRec.windows), key(tsRec.windows))) windowsNote = " (windows: same boxes, other order: the oracle walks a Python set)";
    else diffs["windows"] = { py: pyRec.windows.length, ts: tsRec.windows.length, first: [pyRec.windows[0], tsRec.windows[0]] };
  }
  const noSrc = (s: string) => s.replace(/^ "src": .*$/m, "");
  const pyJson = await readFile(join(pyOut, "rip.json"), "utf8");
  const tsJson = await readFile(join(tsOut, "rip.json"), "utf8");
  const jsonBytes = noSrc(pyJson) === noSrc(tsJson);
  if (!same(pyGone, tsGone)) diffs["removed_items"] = { py_only: pyGone.filter((x) => !tsGone.includes(x)).slice(0, 5), ts_only: tsGone.filter((x) => !pyGone.includes(x)).slice(0, 5) };
  const boardBytes = pyText === tsText;
  if (!boardBytes) diffs["board_bytes"] = "differ";
  if (!jsonBytes && !windowsNote) diffs["rip_json_bytes"] = "differ";
  const ok = !Object.keys(diffs).length;
  record(
    `${m.name}: removed ${pyRec.removed}/${tsRec.removed}, pruned ${pyRec.pruned}/${tsRec.pruned}, nets ${pyRec.nets.length}, items gone ${pyGone.length}, open_before ${pyRec.open_before.length}, by_reason ${JSON.stringify(pyRec.by_reason)}; board bytes ${boardBytes ? "identical" : "DIFFER"}, rip.json bytes ${jsonBytes ? "identical" : "differ"}${windowsNote}; ${pySec.toFixed(1)} s / ${tsSec.toFixed(1)} s`,
    ok,
    diffs,
  );
}

await writeFile(join(out, "rip-parity.json"), JSON.stringify(rows, null, 1));
const md = [
  "# Rip parity: rip_items.py vs lastmile/rip.ts",
  "",
  `Board \`${a.board}\` (${basename(a.board)}; ${board.footprints.size} footprints, ${board.segments.length} segments, ${board.vias.length} vias). Spec ${a.spec}. Oracle ${tk}. kicad-cli ${cli}.`,
  "",
  "| row | agrees | detail |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.item.replace(/\|/g, "/")} | ${r.agree ? "yes" : "NO"} | ${r.agree ? "" : "`" + JSON.stringify(r.detail).slice(0, 400).replace(/\|/g, "/") + "`"} |`),
].join("\n");
await writeFile(join(out, "rip-parity.md"), md + "\n");
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} agree`);

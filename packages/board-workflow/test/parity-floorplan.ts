/**
 * Floorplan parity: the toolkit's floorplan_run.py / block_pass.py (the oracle) against layout/floorplan.ts on C6.
 *
 *   bun packages/board-workflow/test/parity-floorplan.ts --out DIR [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit; runs no router, no kicad-cli). Both sides run the same stand-in
 * for tracemaker-place, a script written into --out, so the comparison is of the orchestration, not of TraceMaker:
 *
 *   replay  copies the placer output TraceMaker wrote in a recorded run of that floorplan (the owner's C6 run
 *           work/c6-see87/placed-H2: 10 passes); the poses that come back are real TraceMaker poses
 *   grid    places every unlocked footprint of the pass input on a small grid from where it stands, turning by 90 degrees
 *           each (exercises sub-groups, pinned poses and per-group clearance: floorplan-disp-V6)
 *
 * Native courtyard DRC is a stand-in that reports nothing (both sides); the single-pad legalise step is left out of both
 * (the edit stage's `legalise` has its own parity). The toolkit runs from a copy of its tools folder whose config points
 * TraceMaker at the stand-in. Compared: the placer's arguments per pass, each pass input (locked set, every pose, the
 * keep-out rectangles), the pass records, and the final board byte for byte.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { floorplanRun, readFloorplan, type Blocks } from "../src/layout/floorplan";
import { nodeRun } from "../src/layout/engines";
import { footprintSpans, lockedRefs, pose } from "../src/layout/text";
import type { LayoutHost } from "../src/layout/ctx";
import { topLevelSpans } from "../src/sexpr";

const { values: a } = parseArgs({ options: { out: { type: "string" }, toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" }, only: { type: "string" } } });
if (!a.out) throw new Error("--out is required");
const out = a.out;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const FRESH = "/home/shane/vaio-io-fresh";
const C6P = "/home/shane/vaio_p_modding/io-c6";
const cases = [
  { name: "H2-replay", base: `${FRESH}/work/c6-see87/base88`, floorplan: `${C6P}/review/c6-see87/floorplan-H2.json`, blocks: `${C6P}/review/c6-route85/blocks.json`, seed: 2, mode: `replay:${FRESH}/work/c6-see87/placed-H2/tm` },
  { name: "disp-V6-grid", base: `${FRESH}/work/c6-see87/base88`, floorplan: `${C6P}/review/c6-see87/floorplan-disp-V6.json`, blocks: `${C6P}/review/c6-route85/blocks.json`, seed: 1, mode: "grid" },
];

// ---- the stand-ins
const bin = join(out, "bin");
await mkdir(bin);
const tools = join(out, "tools");
await cp(join(a.toolkit!, "tools"), tools, { recursive: true, filter: (s) => !s.includes("__pycache__") });
await writeFile(join(bin, "tracemaker"), "#!/bin/sh\nexit 0\n");
await writeFile(
  join(bin, "tracemaker-place"),
  `#!/usr/bin/env python3
import json, os, re, shutil, sys
sys.path.insert(0, ${JSON.stringify(tools)})
import block_pass
args = sys.argv[1:]
src, dst = args[0], args[args.index('-o') + 1]
rep = args[args.index('--json') + 1]
with open(os.environ['FAKE_ARGV'], 'a') as f:
    f.write(json.dumps([os.path.basename(src)] + [x if not x.startswith('/') else os.path.basename(x) for x in args[1:]]) + '\\n')
text = open(src).read()
fps = block_pass.footprints(text)
def unlocked(s, e):
    body = text[s:e]
    head = body[:body.find('(property')]
    return not re.search(r'\\(locked( yes)?\\)', head)
free = [r for r, (s, e) in sorted(fps.items(), key=lambda kv: kv[1][0]) if unlocked(*fps[r])]
mode = os.environ['FAKE_MODE']
if mode.startswith('replay:'):
    shutil.copy(os.path.join(mode[7:], os.path.basename(dst)), dst)
else:
    for k, ref in sorted(enumerate(free), key=lambda kv: -fps[kv[1]][0]):
        s, e = fps[ref]
        body = text[s:e]
        x, y, r = block_pass.pose(body)
        cut = body.find('(property')
        head = re.sub(r'\\(at [-\\d.]+ [-\\d.]+(?: [-\\d.]+)?\\)', '(at %.4f %.4f %g)' % (x + (k % 6) * 2.0, y + (k // 6) * 1.5, (r + 90 * k) % 360), body[:cut], count=1)
        text = text[:s] + head + body[cut:] + text[e:]
    open(dst, 'w').write(text)
print('legalisation: %d placed, 0 failed' % len(free))
print('conflicts before 0 after 0 new 0')
json.dump({'fixed_parts': []}, open(rep, 'w'))
`,
);
await writeFile(join(bin, "kicad-cli"), `#!/usr/bin/env python3\nimport json, sys\na = sys.argv\njson.dump({'violations': []}, open(a[a.index('-o') + 1], 'w'))\n`);
for (const f of ["tracemaker", "tracemaker-place", "kicad-cli"]) await chmod(join(bin, f), 0o755);
const cfg = JSON.parse(await readFile(join(tools, "config.json"), "utf8"));
cfg.tracemaker = join(bin, "tracemaker");
await writeFile(join(tools, "config.json"), JSON.stringify(cfg, null, 2));
// tp_legalise: the module (local_box, world_box) as it is; its command line copies the board unchanged
const tpl = await readFile(join(tools, "tp_legalise.py"), "utf8");
await writeFile(join(tools, "tp_legalise.py"), tpl.replace("if __name__ == '__main__':\n    main()", "if __name__ == '__main__':\n    import os, shutil; os.path.samefile(sys.argv[1], sys.argv[2]) or shutil.copy(sys.argv[1], sys.argv[2]); print(json.dumps({'placed': 0}))"));

async function run(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout: o, stderr: e };
}

const rows: Array<{ item: string; agree: boolean; detail?: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, ...(agree ? {} : { detail }) });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 1500));
};

/** A pass input as data: locked refs, every footprint pose (4 decimals), keep-out rectangles (sorted). */
function passFacts(text: string) {
  const poses: Record<string, string> = {};
  for (const [ref, [s, e]] of footprintSpans(text)) poses[ref] = pose(text.slice(s, e)).map((v) => v.toFixed(4)).join(" ");
  const zones = topLevelSpans(text, "zone")
    .map((z) => text.slice(z.start, z.end))
    .filter((z) => z.includes('(name "block-pass-keepout")'))
    .map((z) => `${/\(layer "([^"]+)"\)/.exec(z)![1]} ${[...z.matchAll(/\(xy ([-\d.]+) ([-\d.]+)\)/g)].map((m) => `${m[1]},${m[2]}`).join(" ")}`)
    .sort();
  return { locked: [...lockedRefs(text)].sort(), poses, zones };
}

for (const c of cases) {
  if (a.only && !c.name.includes(a.only)) continue;
  const d = join(out, c.name);
  await mkdir(d);
  const env = { FAKE_MODE: c.mode, KICAD_CLI: join(bin, "kicad-cli") };
  // ---- toolkit
  const py = await run(["python3", join(tools, "floorplan_run.py"), c.base, join(d, "py"), c.floorplan, c.blocks, "--seed", String(c.seed)], { ...env, FAKE_ARGV: join(d, "argv-py.jsonl") });
  // ---- port
  const blocks = JSON.parse(await readFile(c.blocks, "utf8")) as Blocks;
  const fp = readFloorplan(JSON.parse(await readFile(c.floorplan, "utf8")), blocks);
  process.env["FAKE_MODE"] = c.mode;
  process.env["FAKE_ARGV"] = join(d, "argv-ts.jsonl");
  const host = {
    tools: { krt: null, tracemaker: join(bin, "tracemaker"), kicadCli: null },
    spawn: nodeRun,
    courtyardDrc: async () => [],
    scoreDrc: async () => { throw new Error("no scoring here"); },
    memAvailableGiB: async () => 64,
    diskFreeGiB: async () => 100,
  } as unknown as LayoutHost;
  const ts = await floorplanRun(host, { base: c.base, out: join(d, "ts"), stem: "C6", floorplan: fp, blocks, fixed: /_(J|SW)\d|^FIT_/, seed: c.seed, legalise: (t) => t });
  record(`${c.name} exit (py ${py.code}${py.code ? ": " + py.stderr.trim().split("\n").at(-1) : ""}; ts ${ts.ok ? "ok" : ts.stop})`, (py.code === 0) === ts.ok);
  const [ap, at] = await Promise.all([readFile(join(d, "argv-py.jsonl"), "utf8"), readFile(join(d, "argv-ts.jsonl"), "utf8")]);
  record(`${c.name} placer arguments, ${ap.trim().split("\n").length} passes`, ap === at, { py: ap.split("\n").slice(0, 2), ts: at.split("\n").slice(0, 2) });
  const pyLog = JSON.parse(await readFile(join(d, "py", "floorplan-log.json"), "utf8"));
  record(`${c.name} pass records`, JSON.stringify(pyLog) === JSON.stringify(ts.log), { py: pyLog.slice(0, 2), ts: ts.log.slice(0, 2) });
  const passes = (await readdir(join(d, "py", "tm"))).filter((f) => f.endsWith("-pass.kicad_pcb") || f.endsWith("-in.kicad_pcb")).sort();
  let same = 0;
  const bad: string[] = [];
  for (const f of passes) {
    const [x, y] = await Promise.all([readFile(join(d, "py", "tm", f), "utf8"), readFile(join(d, "ts", "tm", f), "utf8")]);
    if (JSON.stringify(passFacts(x)) === JSON.stringify(passFacts(y))) same++;
    else bad.push(f);
  }
  record(`${c.name} pass inputs (-in, -pass): ${same}/${passes.length} equal as data (locked set, poses, keep-outs)`, !bad.length, bad);
  const [bp, bt] = await Promise.all([readFile(join(d, "py", "C6.kicad_pcb"), "utf8"), readFile(join(d, "ts", "C6.kicad_pcb"), "utf8")]);
  let firstDiff = -1;
  if (bp !== bt) for (let i = 0; i < Math.min(bp.length, bt.length); i++) if (bp[i] !== bt[i]) ((firstDiff = i), (i = Infinity));
  record(`${c.name} final board byte for byte (${bp.length} bytes)`, bp === bt, firstDiff >= 0 ? { at: firstDiff, py: bp.slice(firstDiff - 200, firstDiff + 120), ts: bt.slice(firstDiff - 200, firstDiff + 120) } : "length");
}

await writeFile(join(out, "parity.json"), JSON.stringify({ rows }, null, 1) + "\n");
const bad = rows.filter((r) => !r.agree).length;
console.log(`${rows.length - bad}/${rows.length} agree`);
process.exit(bad ? 1 : 0);

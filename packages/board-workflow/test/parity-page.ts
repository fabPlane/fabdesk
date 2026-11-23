/**
 * Board page parity: the toolkit's `tools/board_page.py` against `review/page.ts`.
 *
 *   bun packages/board-workflow/test/parity-page.ts --out DIR [--full LABEL=DIR ...] [--layers LABEL=DIR ...]
 *       [--kicad-cli PATH] [--toolkit DIR] [--drc]
 *
 * Not part of `bun run test` (needs the Python toolkit and kicad-cli; it runs kicad-cli one job at a time).
 * --full: a board the toolkit's page takes as it is (its layer list is an 8-layer board's: In1..In6): both pages are
 *   built (--no-3d) on a copy of DIR and every board entry is compared: view box, each layer's name, colour, default,
 *   opacity and SVG body (decompressed: gzip headers differ), opens, DRC errors, score.
 * --layers: any other board: the toolkit's own `plot` and `drc_items` run on every layer `pageLayers` picks, and the
 *   per-layer bodies, view boxes, opens and DRC errors are compared with `boardPageData`.
 * --drc: write acceptance.drc.json into each copy first (kicad-cli pcb drc), so opens and errors are exercised.
 * Writes parity-page.json into --out; exits 1 on any difference.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { boardPageData, pageLayers, type PageBoard } from "../src/review/page";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    full: { type: "string", multiple: true, default: [] },
    layers: { type: "string", multiple: true, default: [] },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    drc: { type: "boolean", default: false },
  },
});
if (!a.out) throw new Error("--out is required");
const out = resolve(a.out);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const cli = a["kicad-cli"]!;

async function sh(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code: await p.exited, out: o, err: e };
}
const kicad = async (args: string[]) => {
  const r = await sh([cli, ...args]);
  return { exitCode: r.code, stdout: r.out, stderr: r.err };
};

async function copyBoard(label: string, src: string): Promise<{ dir: string; stem: string }> {
  const dir = join(out, label);
  await mkdir(dir, { recursive: true });
  for (const n of await readdir(src)) if (/\.(kicad_pcb|kicad_pro|kicad_dru)$|^(acceptance\.drc|score)\.json$/.test(n)) await cp(join(src, n), join(dir, n));
  const stem = (await readdir(dir)).find((n) => n.endsWith(".kicad_pcb"))!.replace(/\.kicad_pcb$/, "");
  if (a.drc) {
    const r = await sh([cli, "pcb", "drc", "--format", "json", "-o", join(dir, "acceptance.drc.json"), join(dir, `${stem}.kicad_pcb`)]);
    if (r.code !== 0 && r.code !== 5) throw new Error(`drc failed on ${label}: ${r.err}`);
  }
  return { dir, stem };
}

const diffs: string[] = [];
const unz = (b64: string) => gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
function same(path: string, x: unknown, y: unknown) {
  const sx = JSON.stringify(x), sy = JSON.stringify(y);
  if (sx !== sy) diffs.push(`${path}: python ${sx.slice(0, 200)} vs ts ${sy.slice(0, 200)}`);
}
const report: Record<string, unknown> = {};

for (const spec of a.full as string[]) {
  const [label, src] = spec.split("=", 2) as [string, string];
  const { dir, stem } = await copyBoard(label, src);
  const before = diffs.length;
  const pyOut = join(out, `${label}.py.html`);
  const flowSpec = join(out, `${label}.spec.json`);
  await writeFile(flowSpec, JSON.stringify({ stem, requirements: dir }));
  const t0 = performance.now();
  const r = await sh(["python3", join(a.toolkit!, "tools/board_page.py"), pyOut, "--board", `${label}=${dir}`, "--no-3d"], { FLOW_SPEC: flowSpec, PATH: `${cli.replace(/\/[^/]+$/, "")}:${process.env["PATH"] ?? ""}` });
  const pyS = (performance.now() - t0) / 1000;
  if (r.code !== 0) throw new Error(`board_page.py failed on ${label}: ${r.err.slice(-1500)}`);
  const html = await readFile(pyOut, "utf8");
  const m = /const BOARDS = (.*);\n/.exec(html);
  const py = JSON.parse(m![1]!.replaceAll("<\\/", "</")) as PageBoard[];
  const t1 = performance.now();
  const ts = await boardPageData(label, dir, { kicad, no3d: true });
  const tsS = (performance.now() - t1) / 1000;
  const p = py[0]!;
  same(`${label}.vb`, p.vb, ts.vb);
  same(`${label}.layers`, p.layers.map((l) => [l.n, l.c, l.on, l.o]), ts.layers.map((l) => [l.n, l.c, l.on, l.o]));
  for (let i = 0; i < Math.min(p.layers.length, ts.layers.length); i++) if (unz(p.layers[i]!.z) !== unz(ts.layers[i]!.z)) diffs.push(`${label}.${p.layers[i]!.n}: SVG bodies differ`);
  same(`${label}.opens`, p.opens, ts.opens);
  same(`${label}.viol`, p.viol, ts.viol);
  same(`${label}.score`, p.score, ts.score);
  same(`${label}.r3`, p.r3, ts.r3);
  report[label] = { mode: "full", layers: ts.layers.length, opens: ts.opens.length, viol: ts.viol.length, py_s: Math.round(pyS), ts_s: Math.round(tsS), diffs: diffs.length - before };
  console.log(`${label} (full page): ${ts.layers.length} layers, ${ts.opens.length} opens, ${ts.viol.length} DRC errors, ${diffs.length - before} differences (py ${pyS.toFixed(0)} s, ts ${tsS.toFixed(0)} s)`);
}

const DRIVER = `
import json, sys, tempfile
sys.path.insert(0, sys.argv[1] + '/tools')
import board_page
pcb, layers, drc = sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
res = {'layers': []}
with tempfile.TemporaryDirectory() as tmp:
    for n in layers:
        vb, z = board_page.plot(pcb, n, tmp)
        res['layers'].append({'n': n, 'vb': vb, 'z': z})
try:
    res['opens'], res['viol'] = board_page.drc_items(json.load(open(drc)))
except FileNotFoundError:
    res['opens'], res['viol'] = [], []
print(json.dumps(res))
`;
for (const spec of a.layers as string[]) {
  const [label, src] = spec.split("=", 2) as [string, string];
  const { dir, stem } = await copyBoard(label, src);
  const before = diffs.length;
  const pcb = join(dir, `${stem}.kicad_pcb`);
  const names = pageLayers(await readFile(pcb, "utf8")).map((l) => l[0]);
  const r = await sh(["python3", "-c", DRIVER, a.toolkit!, pcb, JSON.stringify(names), join(dir, "acceptance.drc.json")], { PATH: `${cli.replace(/\/[^/]+$/, "")}:${process.env["PATH"] ?? ""}` });
  if (r.code !== 0) throw new Error(`board_page.plot failed on ${label}: ${r.err.slice(-1500)}`);
  const py = JSON.parse(r.out) as { layers: Array<{ n: string; vb: string; z: string }>; opens: unknown; viol: unknown };
  const ts = await boardPageData(label, dir, { kicad, no3d: true });
  same(`${label}.names`, py.layers.map((l) => l.n), ts.layers.map((l) => l.n));
  for (let i = 0; i < Math.min(py.layers.length, ts.layers.length); i++) {
    if (unz(py.layers[i]!.z) !== unz(ts.layers[i]!.z)) diffs.push(`${label}.${py.layers[i]!.n}: SVG bodies differ`);
  }
  same(`${label}.vb`, py.layers.at(-1)?.vb ?? null, ts.vb);
  same(`${label}.opens`, py.opens, ts.opens);
  same(`${label}.viol`, py.viol, ts.viol);
  report[label] = { mode: "layers", layers: names, opens: ts.opens.length, viol: ts.viol.length, diffs: diffs.length - before };
  console.log(`${label} (per layer): ${names.length} layers (${names.join(" ")}), ${ts.opens.length} opens, ${ts.viol.length} DRC errors, ${diffs.length - before} differences`);
}

await writeFile(join(out, "parity-page.json"), JSON.stringify({ cli, report, diffs }, null, 1) + "\n");
console.log(diffs.length ? `\n${diffs.length} differences:\n${diffs.slice(0, 30).join("\n")}` : "\nparity: identical");
process.exit(diffs.length ? 1 : 0);

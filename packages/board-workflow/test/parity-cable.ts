/**
 * Cable-reach parity: the toolkit's `flow/cablepath.py` (`pcb cable`) against `review/cable.ts` on real chassis files.
 *
 *   bun packages/board-workflow/test/parity-cable.ts [--repo ~/vaio_p_modding] [--toolkit DIR] [--out DIR]
 *       [--chassis io-c6/review/eco95/chassis.json,...] [--sweep C6:C18_J401:right,...] [--pcb BOARD=PATH]
 *
 * Not part of `bun run test` (needs the Python toolkit and the project's boards). Board paths in a chassis file resolve
 * against --repo on both sides (the toolkit's PCB_REPO). Per chassis file: every frame x cable result (verdict, required,
 * slack, turns, run, dz, flags, mouths and normals) and the printed lines; per sweep: every row's pose and slack per
 * frame. Exits 1 on any difference. Writes parity-cable.json into --out.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cable } from "../src/index";

const { values: a } = parseArgs({
  options: {
    repo: { type: "string", default: join(homedir(), "vaio_p_modding") },
    toolkit: { type: "string", default: join(homedir(), "pcb-worktrees/heldout") },
    out: { type: "string", default: "/tmp/parity-cable" },
    chassis: { type: "string", default: "io-c6/review/eco95/chassis.json,io-c6/review/eco95/chassis-owner.json,io-c6/review/eco95/chassis-sens.json" },
    sweep: { type: "string", default: "C6:C18_J401:right,C6:A74_J2:right,C6:C18_J401:front" },
    pcb: { type: "string", multiple: true, default: [] },
  },
});
const repo = resolve(a.repo!);
await mkdir(a.out!, { recursive: true });

async function py(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["python3", join(a.toolkit!, "flow/cablepath.py"), ...args], { cwd: repo, env: { ...process.env, PCB_REPO: repo, PCB_PROJECT: join(repo, "io-c6") }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code: await p.exited, out, err };
}

const diffs: string[] = [];
const near = (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" && Math.abs(x - y) < 1e-9;
function cmp(path: string, x: unknown, y: unknown) {
  if (near(x, y) || x === y) return;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) diffs.push(`${path}: length ${x.length} vs ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) cmp(`${path}[${i}]`, x[i], y[i]);
    return;
  }
  if (x && y && typeof x === "object" && typeof y === "object") {
    const ks = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of ks) cmp(`${path}.${k}`, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
    return;
  }
  diffs.push(`${path}: python ${JSON.stringify(x)} vs ts ${JSON.stringify(y)}`);
}
/** The toolkit prints the chassis file's own numbers with Python repr (5.0 vs 5): compare the printed lines with numbers normalised. */
const normNums = (s: string) => s.replace(/(\d+)\.0\b/g, "$1");

const report: Record<string, unknown> = {};
const pcbOpt = Object.fromEntries((a.pcb as string[]).map((kv) => kv.split("=", 2) as [string, string]));
let cables = 0, rows = 0;
for (const rel of a.chassis!.split(",").filter(Boolean)) {
  const file = resolve(repo, rel);
  const pyJson = join(a.out!, `${rel.replace(/\W+/g, "_")}.py.json`);
  const r = await py([file, "--json", pyJson, ...(a.pcb as string[]).flatMap((kv) => ["--pcb", kv])]);
  const pyRes = JSON.parse(await readFile(pyJson, "utf8")) as { results: Record<string, unknown[]> };
  const t0 = performance.now();
  const ts = await cable.runCables(new cable.CableBoards(repo), JSON.parse(await readFile(file, "utf8")), { pcb: pcbOpt });
  const ms = performance.now() - t0;
  const before = diffs.length;
  cmp(rel, pyRes.results, JSON.parse(JSON.stringify(ts.results)));
  const pyLines = r.out.trimEnd().split("\n");
  if (pyLines.length !== ts.lines.length) diffs.push(`${rel}: ${pyLines.length} printed lines vs ${ts.lines.length}`);
  pyLines.forEach((l, i) => {
    if (normNums(l) !== normNums(ts.lines[i] ?? "")) diffs.push(`${rel} line ${i}:\n  py ${l}\n  ts ${ts.lines[i]}`);
  });
  if ((r.code !== 0) !== ts.failed > 0) diffs.push(`${rel}: exit ${r.code} vs ${ts.failed} failed`);
  const n = Object.values(ts.results).reduce((s, x) => s + x.length, 0);
  cables += n;
  report[rel] = { frames: Object.keys(ts.results).length, cable_results: n, failed: ts.failed, ts_ms: Math.round(ms), diffs: diffs.length - before };
  console.log(`${rel}: ${n} frame x cable results, ${ts.failed} FAIL, ${diffs.length - before} differences (${ms.toFixed(0)} ms)`);
}
const ch0 = a.chassis!.split(",")[0]!;
for (const sw of a.sweep!.split(",").filter(Boolean)) {
  const [bn, ref, edge] = sw.split(":") as [string, string, cable.Edge];
  const file = resolve(repo, ch0);
  const pyJson = join(a.out!, `sweep_${bn}_${ref}_${edge}.py.json`);
  const r = await py([file, "--sweep", `${bn}:${ref}`, "--edge", edge, "--json", pyJson]);
  const before = diffs.length;
  let tsRows: cable.SweepRow[] | null = null;
  try {
    tsRows = await cable.sweepCable(new cable.CableBoards(repo), JSON.parse(await readFile(file, "utf8")), bn, ref, edge);
  } catch (e) {
    if (r.code === 0) diffs.push(`sweep ${sw}: ts threw ${(e as Error).message}, python ran`);
    else console.log(`sweep ${sw}: both refuse (${(e as Error).message})`);
  }
  if (tsRows) {
    if (r.code !== 0) diffs.push(`sweep ${sw}: python failed: ${r.err.trim().split("\n").pop()}`);
    else {
      const pyRows = (JSON.parse(await readFile(pyJson, "utf8")) as Array<Record<string, unknown>>).map((x) => {
        const { pos, pose, ...rest } = x;
        return { pos, pose, slack: rest };
      });
      cmp(`sweep ${sw}`, pyRows, JSON.parse(JSON.stringify(tsRows)));
      const tl = cable.sweepLines(tsRows), pl = r.out.trimEnd().split("\n");
      pl.forEach((l, i) => {
        if (normNums(l) !== normNums(tl[i] ?? "")) diffs.push(`sweep ${sw} line ${i}:\n  py ${l}\n  ts ${tl[i]}`);
      });
      rows += tsRows.length;
    }
  }
  report[`sweep ${sw}`] = { rows: tsRows?.length ?? 0, diffs: diffs.length - before };
  console.log(`sweep ${sw}: ${tsRows?.length ?? 0} rows, ${diffs.length - before} differences`);
}
await writeFile(join(a.out!, "parity-cable.json"), JSON.stringify({ repo, toolkit: a.toolkit, report, cables, sweep_rows: rows, diffs }, null, 1) + "\n");
console.log(diffs.length ? `\n${diffs.length} differences:\n${diffs.slice(0, 40).join("\n")}` : `\nparity: ${cables} cable results and ${rows} sweep rows identical`);
process.exit(diffs.length ? 1 : 0);

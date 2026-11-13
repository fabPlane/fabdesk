/**
 * Change-picture parity: the toolkit's `review/diff.py` (`pcb diff OLD NEW OUT.html`) against `review/diff.ts`.
 *
 *   bun packages/board-workflow/test/parity-diff.ts --out DIR --pair OLD=NEW [--pair ...] [--layers F.Cu,B.Cu] [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit). OLD and NEW are board files or folders. The toolkit draws
 * from Python sets, so element order differs run to run: the SVG is compared as a sorted multiset of elements (and the
 * standalone .svg the same way), the page's text outside the drawing exactly, and the summary line exactly.
 * Writes parity-diff.json into --out; exits 1 on any difference.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { changePage, changeSummary, changeSvgStandalone, diffBoards } from "../src/index";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    pair: { type: "string", multiple: true, default: [] },
    layers: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
  },
});
if (!a.out) throw new Error("--out is required");
const out = resolve(a.out);
await mkdir(out, { recursive: true });
const diffs: string[] = [];
const report: Record<string, unknown> = {};
const lay = a.layers ? new Set(a.layers.split(",")) : undefined;

/** Split a page into (text outside the <svg>, sorted svg element lines). */
function parts(html: string): { outside: string; svg: string[] } {
  const i = html.indexOf("<svg"), j = html.indexOf("</svg>") + 6;
  return { outside: html.slice(0, i) + html.slice(j), svg: html.slice(i, j).split("\n").sort() };
}

let k = 0;
for (const spec of a.pair as string[]) {
  const [oldP, newP] = spec.split("=", 2) as [string, string];
  const pyOut = join(out, `pair${k}.py.html`);
  const p = Bun.spawn(["python3", join(a.toolkit!, "review/diff.py"), oldP, newP, pyOut, ...(a.layers ? ["--layers", a.layers] : [])], { stdout: "pipe", stderr: "pipe" });
  const [so, se] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`diff.py failed: ${se}`);
  const d = await diffBoards(oldP, newP);
  const tsPage = changePage(d, lay), tsSvg = changeSvgStandalone(d, lay);
  await writeFile(join(out, `pair${k}.ts.html`), tsPage);
  const before = diffs.length;
  const pyLine = so.trim().replace(/ -> .*$/, "");
  if (pyLine !== changeSummary(d)) diffs.push(`${spec}: summary\n  py ${pyLine}\n  ts ${changeSummary(d)}`);
  const pp = parts(await readFile(pyOut, "utf8")), tp = parts(tsPage);
  if (pp.outside !== tp.outside) {
    const pl = pp.outside.split("\n"), tl = tp.outside.split("\n");
    const i = pl.findIndex((l, n) => l !== tl[n]);
    diffs.push(`${spec}: page text differs at line ${i}\n  py ${pl[i]?.slice(0, 300)}\n  ts ${tl[i]?.slice(0, 300)}`);
  }
  const cmpLines = (what: string, x: string[], y: string[]) => {
    if (x.length !== y.length) diffs.push(`${spec}: ${what} ${x.length} vs ${y.length} elements`);
    const n = x.findIndex((l, i) => l !== y[i]);
    if (n >= 0) diffs.push(`${spec}: ${what} first difference\n  py ${x[n]?.slice(0, 300)}\n  ts ${y[n]?.slice(0, 300)}`);
  };
  cmpLines("page svg", pp.svg, tp.svg);
  const psvg = (await readFile(pyOut.replace(/\.html$/, ".svg"), "utf8")).split("\n").sort();
  cmpLines("standalone svg", psvg, tsSvg.split("\n").sort());
  report[spec] = { summary: changeSummary(d), svg_elements: tp.svg.length, diffs: diffs.length - before };
  console.log(`${spec}\n  ${changeSummary(d)}; ${tp.svg.length} svg lines; ${diffs.length - before} differences`);
  k++;
}
await writeFile(join(out, "parity-diff.json"), JSON.stringify({ report, diffs }, null, 1) + "\n");
console.log(diffs.length ? `\n${diffs.length} differences:\n${diffs.slice(0, 20).join("\n")}` : "\nparity: identical");
process.exit(diffs.length ? 1 : 0);

/**
 * add_courtyards parity: the toolkit's tools/add_courtyards.py (main 066fea8, the oracle) against layout/courtyards.ts.
 *
 *   bun packages/board-workflow/test/parity-courtyards.ts --out DIR [--toolkit DIR] [--vaio DIR] [--only NAME]
 *
 * Not part of `bun run test` (needs the Python toolkit; runs no router and no kicad-cli). Every case runs the script and
 * the port on the same board text and compares (a) the written board, byte for byte once the uuids of the items the run
 * added are replaced by a placeholder (the script draws uuid4s), and (b) the script's printed JSON (added, inverted
 * rects fixed, halos, refitted) against the port's result.
 *
 *   C6 fab112      the board before the J101/IC201 correction (owner repo, git f1a1d256): add mode; and the motivating
 *                  refit, `--refit C18_J101,C18_IC201 --bodies requirements/part-bodies.json`, also compared with the
 *                  board the owner committed after it (32fac8bb, the same command) with uuids masked.
 *   C6 current     release/C6-eco95 as it is now: add mode, halos, refit with bodies (the body rect is already there:
 *                  idempotent) and refit without bodies.
 *   cm5, vme       add mode; halos on two parts; refit of three 90/270-degree parts, pads only and with a body that
 *                  crosses the pad box (an fp_poly outline).
 *   synthetic      the unit-test shapes: footprints at 90/180/270/-90 in both pose spellings, off-axis pads, a cross.
 *
 * Also counts, per board, the footprints whose pad box the pre-fix reading (absolute pad angle, JS `%`) got wrong.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addCourtyards, padBox, type CourtyardOptions } from "../src/layout/courtyards";
import { footprintSpans } from "../src/edit/text";
import { pose } from "../src/layout/text";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb" },
    vaio: { type: "string", default: "/home/shane/vaio_p_modding" },
    only: { type: "string" },
  },
});
if (!a.out) throw new Error("--out is required");
const out = a.out;
const script = join(a.toolkit!, "tools", "add_courtyards.py");
const vaio = a.vaio!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}\n${(o + e).slice(-1500)}`);
  return o;
}

const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 600));
};

const UUID = /\(uuid "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\)/g;
/** The board with the uuids that are not in `input` (the run's new items) replaced by a placeholder. */
const mask = (text: string, input: Set<string>) => text.replace(UUID, (m, u: string) => (input.has(u) ? m : '(uuid "NEW")'));
const firstDiff = (x: string, y: string) => {
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return { at: i, oracle: x.slice(Math.max(0, i - 80), i + 120), port: y.slice(Math.max(0, i - 80), i + 120) };
};

interface Case {
  name: string;
  board: string;
  opts: CourtyardOptions;
  bodiesFile?: string;
  /** A board the owner wrote with the same command, compared with uuids masked. */
  owner?: string;
}

async function run(c: Case): Promise<void> {
  const text = await readFile(c.board, "utf8");
  const input = new Set([...text.matchAll(UUID)].map((m) => m[1]!));
  const dir = join(out, c.name);
  await mkdir(dir, { recursive: true });
  const pyOut = join(dir, "oracle.kicad_pcb");
  const args = ["python3", script, c.board, pyOut, "--margin", String(c.opts.margin ?? 0.25)];
  if (c.opts.halo?.length) args.push("--halo", c.opts.halo.join(","), "--halo-mm", String(c.opts.haloMm ?? 0.8));
  if (c.opts.refit?.length) args.push("--refit", c.opts.refit.join(","));
  if (c.bodiesFile) args.push("--bodies", c.bodiesFile);
  const pyJson = JSON.parse((await sh(args)).trim().split("\n").pop()!);
  const bodies = c.bodiesFile ? (JSON.parse(await readFile(c.bodiesFile, "utf8")) as Record<string, unknown>) : undefined;
  const ts = addCourtyards(text, { ...c.opts, ...(bodies ? { bodies } : {}) });
  await writeFile(join(dir, "port.kicad_pcb"), ts.text);
  const py = mask(await readFile(pyOut, "utf8"), input);
  const port = mask(ts.text, input);
  record(`${c.name}: board text (new uuids masked), ${py.length} chars`, py === port, py === port ? "" : firstDiff(py, port));
  const tsJson = c.opts.refit?.length ? { refitted: ts.refitted } : { added: ts.added, inverted_rects_fixed: ts.inverted_rects_fixed, halos: ts.halos, refitted: ts.refitted };
  const same = JSON.stringify(pyJson) === JSON.stringify(tsJson);
  const summary = c.opts.refit?.length
    ? Object.entries(ts.refitted).map(([k, v]) => `${k} ${v.courtyard.length} corners`).join(", ")
    : `${Object.keys(ts.added).length} added, ${ts.inverted_rects_fixed} inverted fixed, ${Object.keys(ts.halos).length} halos`;
  record(`${c.name}: printed JSON (${summary})`, same, same ? "" : { oracle: pyJson, port: tsJson });
  if (c.owner) {
    const own = await readFile(c.owner, "utf8");
    const ownMasked = mask(own, input);
    record(`${c.name}: equals the owner's committed board (uuids masked)`, ownMasked === port, ownMasked === port ? "" : firstDiff(ownMasked, port));
  }
}

/** The pre-fix reading: the absolute pad angle as if relative, JS `%`, exact 0/90 only. */
function oldPadBox(body: string): number[] | null {
  const PAD = /\(pad\s+"[^"]*"\s+\w+\s+\w+[\s\S]*?\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)[\s\S]*?\(size ([-\d.]+) ([-\d.]+)\)/g;
  const xs: number[] = [], ys: number[] = [];
  for (const m of body.matchAll(PAD)) {
    const x = Number(m[1]), y = Number(m[2]), w = Number(m[4]), h = Number(m[5]);
    const rot = Number(m[3] ?? 0) % 180;
    let hw: number, hh: number;
    if (rot !== 0 && rot !== 90) hw = hh = Math.max(w, h) / 2;
    else [hw, hh] = rot === 0 ? [w / 2, h / 2] : [h / 2, w / 2];
    xs.push(x - hw, x + hw);
    ys.push(y - hh, y + hh);
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

function oldBugCount(name: string, text: string): void {
  const wrong: string[] = [];
  for (const [ref, sp] of footprintSpans(text)) {
    const body = text.slice(sp.start, sp.end);
    const n = padBox(body), o = oldPadBox(body);
    if (n && o && n.some((v, i) => Math.abs(v - o[i]!) > 1e-9)) wrong.push(ref);
  }
  console.log(`${name}: ${wrong.length} footprint(s) whose pad box the pre-fix reading got wrong${wrong.length ? `: ${wrong.slice(0, 12).join(", ")}${wrong.length > 12 ? ", ..." : ""}` : ""}`);
  record(`${name}: footprints the pre-fix angle reading measured wrong = ${wrong.length} (informational)`, true, wrong);
}

/** Three footprints at 90/270 degrees with two or more pads and a courtyard, for the refit cases. */
function rotatedRefs(text: string, n = 3): string[] {
  const out: string[] = [];
  for (const [ref, sp] of [...footprintSpans(text)].sort((x, y) => x[0].localeCompare(y[0]))) {
    const body = text.slice(sp.start, sp.end);
    const r = ((pose(body)[2] % 360) + 360) % 360;
    if ((r === 90 || r === 270) && (body.match(/\(pad /g) ?? []).length >= 2 && body.includes('CrtYd"')) out.push(ref);
    if (out.length === n) break;
  }
  return out;
}

const scratch = join(out, "inputs");
await mkdir(scratch, { recursive: true });
const cases: Case[] = [];

// ---- C6: the pre-correction board from the owner's repo, and the board the owner committed after the refit
const c6Rel = "io-c6/release/C6-eco95/C6.kicad_pcb";
if (existsSync(join(vaio, ".git"))) {
  const fab112 = join(scratch, "C6-fab112.kicad_pcb"), after = join(scratch, "C6-courtyard113.kicad_pcb");
  await writeFile(fab112, await sh(["git", "-C", vaio, "show", `f1a1d256:${c6Rel}`]));
  await writeFile(after, await sh(["git", "-C", vaio, "show", `32fac8bb:${c6Rel}`]));
  const bodiesAt = join(scratch, "part-bodies-32fac8bb.json");
  await writeFile(bodiesAt, await sh(["git", "-C", vaio, "show", "32fac8bb:io-c6/release/C6-eco95/requirements/part-bodies.json"]));
  cases.push({ name: "c6-fab112-add", board: fab112, opts: {} });
  cases.push({ name: "c6-fab112-refit-j101-ic201-bodies", board: fab112, opts: { refit: ["C18_J101", "C18_IC201"] }, bodiesFile: bodiesAt, owner: after });
  oldBugCount("c6-fab112", await readFile(fab112, "utf8"));
}
const c6 = join(vaio, c6Rel);
const c6Bodies = join(vaio, "io-c6/release/C6-eco95/requirements/part-bodies.json");
cases.push({ name: "c6-current-add", board: c6, opts: {} });
cases.push({ name: "c6-current-halo", board: c6, opts: { halo: ["C18_IC201", "A74_U9", "C18_J101"], haloMm: 0.8 } });
cases.push({ name: "c6-current-refit-bodies", board: c6, opts: { refit: ["C18_J101", "C18_IC201"] }, bodiesFile: c6Bodies });
cases.push({ name: "c6-current-refit-pads-only", board: c6, opts: { refit: ["C18_J101", "C18_IC201", "A74_J1"], margin: 0.3 } });

for (const [name, board] of [["cm5", "/home/shane/pcb-cmp/cm5_minima/proj2/board.kicad_pcb"], ["vme", "/home/shane/pcb-cmp/vme-wren/proj2/board.kicad_pcb"]] as const) {
  const text = await readFile(board, "utf8");
  oldBugCount(name, text);
  const refs = rotatedRefs(text);
  const fps = footprintSpans(text);
  // a body narrower than the first part's pad box and twice as tall: the union is a cross (an fp_poly)
  const pb = padBox(text.slice(fps.get(refs[0]!)!.start, fps.get(refs[0]!)!.end))!;
  const bodiesFile = join(scratch, `${name}-bodies.json`);
  await writeFile(bodiesFile, JSON.stringify({ _doc: "parity: synthetic bodies", [refs[0]!]: { size: [(pb[2] - pb[0]) * 0.5, (pb[3] - pb[1]) * 2 + 1], center: [0.1, -0.05], source: "synthetic" }, [refs[1]!]: { size: [(pb[2] - pb[0]) + 3, (pb[3] - pb[1]) + 3] } }));
  cases.push({ name: `${name}-add`, board, opts: {} });
  cases.push({ name: `${name}-halo`, board, opts: { halo: refs.slice(0, 2), haloMm: 0.6 } });
  cases.push({ name: `${name}-refit-pads-only`, board, opts: { refit: refs } });
  cases.push({ name: `${name}-refit-bodies`, board, opts: { refit: refs }, bodiesFile });
}

// ---- synthetic shapes (the unit tests' footprints), so the angle cases are compared against the script too
const fp = (ref: string, inner: string, side: string, rot: number) =>
  `  (footprint "lib:${ref}"\n    (layer "${side}.Cu")\n    (at 10 10 ${rot})\n    (property "Reference" "${ref}")\n${inner}\n  )\n`;
const fpT = (ref: string, inner: string, rot: number) =>
  `  (footprint "lib:${ref}"\n    (transform\n      (translate 20 20)\n      (rotate ${rot})\n      (scale 1 1))\n    (layer "F.Cu")\n    (uuid "00000000-0000-0000-0000-00000000000${rot === 90 ? 1 : 2}")\n    (property "Reference" "${ref}"\n      (at 0 0 ${rot}))\n${inner}\n  )\n`;
const pad = (n: string, x: number, y: number, w: number, h: number, rot: number) => `    (pad "${n}" smd rect (at ${x} ${y} ${rot}) (size ${w} ${h}) (layers "F.Cu"))`;
const synth = join(scratch, "synthetic.kicad_pcb");
const shapes: string[] = [];
let k = 0;
for (const fr of [0, 90, 180, 270, -90, 45])
  for (const pr of [0, 90, 180, 270, -90, 30, 135]) shapes.push(fp(`S${++k}`, [pad("1", -0.7, 0.2, 1.2, 0.35, pr), pad("2", 0.7, -0.2, 1.2, 0.35, pr)].join("\n"), k % 3 ? "F" : "B", fr));
shapes.push(fpT("T1", pad("1", 0, 0, 2, 1, 90), 90), fpT("T2", pad("1", 0, 0, 2, 1, 0), 270));
shapes.push(fp("X1", [pad("1", -4.75, 0, 0.5, 2, 0), pad("2", 4.75, 0, 0.5, 2, 0)].join("\n") + '\n    (fp_rect (start 1 1) (end -1 -1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "00000000-0000-0000-0000-000000000009"))', "F", 0));
await writeFile(synth, `(kicad_pcb\n${shapes.join("")})\n`);
const synthBodies = join(scratch, "synthetic-bodies.json");
await writeFile(synthBodies, JSON.stringify({ X1: { size: [4, 6] }, S9: { size: [0.5, 3], center: [0.2, 0] }, T1: { size: [4, 0.5] } }));
cases.push({ name: "synthetic-add", board: synth, opts: {} });
cases.push({ name: "synthetic-halo", board: synth, opts: { halo: ["S3", "T1", "X1"], haloMm: 0.5 } });
cases.push({ name: "synthetic-refit-bodies", board: synth, opts: { refit: ["X1", "S9", "T1", "S20", "T2"] }, bodiesFile: synthBodies });

for (const c of cases) {
  if (a.only && !c.name.includes(a.only)) continue;
  await run(c);
}

const agree = rows.filter((r) => r.agree).length;
await writeFile(join(out, "courtyards-parity.json"), JSON.stringify({ toolkit: a.toolkit, rows }, null, 1));
await writeFile(
  join(out, "courtyards-parity.md"),
  ["# add_courtyards parity", "", `Oracle: ${script}.`, "", "| item | agrees |", "|---|---|", ...rows.map((r) => `| ${r.item} | ${r.agree ? "yes" : "NO"} |`), "", `${agree}/${rows.length} agree`].join("\n"),
);
console.log(`\n${agree}/${rows.length} agree`);
process.exit(agree === rows.length ? 0 : 1);

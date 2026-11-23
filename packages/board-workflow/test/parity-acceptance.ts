/**
 * Acceptance parity on an owner board with its own requirements: the toolkit's tools/check_acceptance.py and
 * review/checks.py check_drc (main f107799, the oracle) against checkAcceptance and the review's checkDrc.
 *
 *   bun packages/board-workflow/test/parity-acceptance.ts --out DIR [--spec SPEC.json] [--toolkit DIR] [--kicad-cli PATH]
 *       [--drc FILE,..] [--no-live]
 *
 * Not part of `bun run test` (needs the Python toolkit; the live DRC needs kicad-cli). Default board: C6-eco95
 * (release/C6-eco95/spec.json), whose acceptance.json carries the 2026-11-12/13 judging rules: four named
 * `courtyard_overlap_exceptions`, `inner_neck_allowance_mm: 0` on PWR_LOGIC_3313 / PWR_LCD33_3313, and named PWR
 * classes whose DRC width findings are courtyard proxies. Both sides read the same board, the same DRC report and the
 * same acceptance; the C6_ACCEPTANCE_V1 stack facts boardctx supplies (IO_GND, eight layers, spans) are written into
 * the port's copy, as in parity-rip.ts.
 *
 * DRC reports: one live run (kicad-cli, refilled zones, schematic parity, the project's severities: the oracle's own
 * flags) on a copy of the project, the release package's recorded acceptance.drc.json (fab116, the toolkit's own run on
 * this board) and any --drc files. Requirement variants: as written; no exceptions (the overlaps count in A2); one
 * exception dropped and a pair the board does not have (reported as not present); allowances removed (inner necks
 * forgiven again); allowance 0 on every power class with an inner width. Compared: every A1-A9 result field
 * (numbers to 1e-9), the summary, and the review's drc check findings (claim, key, severity, evidence).
 * Writes acceptance-parity.json / .md into --out.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { checkAcceptance, drcInputFromFile, parseBoard, type Acceptance, type Requirements } from "../src/index";
import { checkDrc } from "../src/review/checks";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    spec: { type: "string", default: "/home/shane/vaio_p_modding/io-c6/release/C6-eco95/spec.json" },
    toolkit: { type: "string", default: "/home/shane/pcb" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    drc: { type: "string" },
    "no-live": { type: "boolean", default: false },
  },
});
if (!a.out) throw new Error("--out is required");
const out = a.out;
const tk = a.toolkit!;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const spec = JSON.parse(await readFile(a.spec!, "utf8"));
const stem: string = spec.stem ?? "C6";
const base: string = spec.base;
const reqDir: string = spec.requirements;
const boardRoot = dirname(reqDir);
const boardFile = join(base, `${stem}.kicad_pcb`);

async function sh(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { env: { ...process.env, PCB_SELFRECORD: "off", ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}\n${(o + e).slice(-2000)}`);
  return o;
}
const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 700));
};
/** Free-text fields the port words for its own tools (A8's note names no toolkit command); compared apart. */
const PROSE = new Set(["note"]);
const proseDiffs = new Set<string>();
function diff(x: unknown, y: unknown, path: string, acc: string[]): void {
  if (typeof x === "number" && typeof y === "number") {
    if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) acc.push(`${path}: ${x} != ${y}`);
  } else if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) acc.push(`${path}: length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diff(x[i], y[i], `${path}[${i}]`, acc);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    const kx = Object.keys(x as object), ky = Object.keys(y as object);
    if (kx.join() !== ky.join() && new Set(kx).size === new Set(ky).size && kx.every((k) => ky.includes(k))) acc.push(`${path}: key order ${kx.join(",")} != ${ky.join(",")}`);
    for (const k of new Set([...kx, ...ky])) {
      if (!(k in (y as object))) acc.push(`${path}.${k}: only in oracle`);
      else if (!(k in (x as object))) acc.push(`${path}.${k}: only in port`);
      else if (PROSE.has(k) && typeof (x as never)[k] === "string") {
        if ((x as never)[k] !== (y as never)[k]) proseDiffs.add(`${path.replace(/\[\d+\]/g, "")}.${k}`);
      } else diff((x as never)[k], (y as never)[k], `${path}.${k}`, acc);
    }
  } else if (x !== y) acc.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
}

// ---- the owner's requirements, and the port's reading of them
const accRaw = JSON.parse(await readFile(join(reqDir, "acceptance.json"), "utf8")) as Acceptance;
const authority = accRaw.authority as unknown as Record<string, string>;
const authFiles = ["circuit", "mechanical", "heights"].map((k) => authority[k]!);
const readAuth = async (k: string) => JSON.parse(await readFile(join(boardRoot, authority[k]!), "utf8"));
const [circuit, mechanical, heights] = [await readAuth("circuit"), await readAuth("mechanical"), await readAuth("heights")];
function portAcceptance(acc0: Acceptance): Acceptance {
  const acc = JSON.parse(JSON.stringify(acc0));
  if (acc.schema === "C6_ACCEPTANCE_V1") {
    acc.stack_policy = { ...acc.stack_policy };
    acc.stack_policy.ground_net ??= "IO_GND";
    acc.stack_policy.copper_layers ??= ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"];
    const pl = acc.stack_policy.plane_layers;
    if (pl && !Array.isArray(pl)) acc.stack_policy.plane_layers = Object.keys(pl);
    acc.stack_policy.plane_layers ??= ["In1.Cu", "In6.Cu"];
    acc.stack_policy.via_spans ??= { through: [["F.Cu", "B.Cu"]], blind: [["In1.Cu", "In6.Cu"]], micro: [["F.Cu", "In1.Cu"], ["In6.Cu", "B.Cu"]] };
    acc.value_exceptions ??= ["A74_C54"];
  }
  return acc;
}

// ---- requirement variants
type Variant = { name: string; acc: Acceptance; note: string };
const clone = (x: Acceptance): Acceptance => JSON.parse(JSON.stringify(x));
const variants: Variant[] = [{ name: "as-written", acc: accRaw, note: "the owner's acceptance.json" }];
const exc = accRaw.courtyard_overlap_exceptions ?? [];
if (exc.length) {
  const v1 = clone(accRaw);
  delete v1.courtyard_overlap_exceptions;
  variants.push({ name: "no-exceptions", acc: v1, note: "courtyard_overlap_exceptions removed: the overlaps count in A2" });
  const v2 = clone(accRaw);
  v2.courtyard_overlap_exceptions = [...exc.slice(1), { refs: ["NOPE1", "NOPE2"], basis: "parity: a pair the board does not have" }, { refs: ["C18_J101"], basis: "parity: one ref names no pair" }];
  variants.push({ name: "one-dropped-one-absent", acc: v2, note: `the first exception (${exc[0]!.refs.join("-")}) dropped; a pair the board lacks and a one-ref entry added` });
}
const pwr = Object.entries(accRaw.net_classes.classes).filter(([n]) => n.startsWith("PWR_"));
if (pwr.some(([, c]) => c.inner_neck_allowance_mm === 0)) {
  const v3 = clone(accRaw);
  for (const c of Object.values(v3.net_classes.classes)) delete c.inner_neck_allowance_mm;
  variants.push({ name: "allowance-removed", acc: v3, note: "inner_neck_allowance_mm removed: inner necks within the pad allowance pass again" });
}
const v4 = clone(accRaw);
for (const [n, c] of Object.entries(v4.net_classes.classes)) if (n.startsWith("PWR_") && c.inner_track_width) c.inner_neck_allowance_mm = 0;
variants.push({ name: "allowance-0-everywhere", acc: v4, note: "inner_neck_allowance_mm 0 on every power class with an inner width" });

// ---- DRC reports
const drcs: Array<{ name: string; file: string }> = [];
if (!a["no-live"]) {
  const proj = join(out, "proj");
  await mkdir(proj, { recursive: true });
  for (const n of await readdir(base))
    if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty")) await cp(join(base, n), join(proj, n), { recursive: true });
  const live = join(out, "live.drc.json");
  const t = Date.now();
  // the oracle's flags: refilled zones, schematic parity, the project's own severities (no --severity-all)
  await sh(["nice", "-n", "15", a["kicad-cli"]!, "pcb", "drc", "--format", "json", "--schematic-parity", "--refill-zones", "-o", live, join(proj, `${stem}.kicad_pcb`)]);
  console.log(`live DRC ${((Date.now() - t) / 1000).toFixed(1)} s`);
  drcs.push({ name: "live", file: live });
}
// release packages of this board, from the toolkit's board registry entry that names this spec
const pkg: string[] = [];
for (const n of await readdir(join(tk, "boards")).catch(() => [] as string[])) {
  if (!n.endsWith(".json") || n.includes(".dispositions") || n.includes(".intent")) continue;
  const e = JSON.parse(await readFile(join(tk, "boards", n), "utf8").catch(() => "{}"));
  if (e.spec === a.spec) pkg.push(...((e.packages as string[] | undefined) ?? []));
}
for (const p of pkg) {
  const f = join(p, "acceptance.drc.json");
  if (existsSync(f) && !drcs.some((d) => d.file === f)) drcs.push({ name: `recorded ${p.split("/").slice(-2, -1)[0]}`, file: f });
}
for (const f of (a.drc ?? "").split(",").filter(Boolean)) drcs.push({ name: `given ${f.split("/").slice(-2).join("/")}`, file: f });

const board = parseBoard(await readFile(boardFile, "utf8"));

// ---- oracle drivers
async function pyAccept(v: Variant, drcFile: string, dir: string) {
  const req = join(dir, "requirements");
  await mkdir(req, { recursive: true });
  // the authority files keep their relative paths under the variant's board root
  for (const rel of authFiles) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await cp(join(boardRoot, rel), join(dir, rel));
  }
  await writeFile(join(req, "acceptance.json"), JSON.stringify(v.acc, null, 1));
  const specFile = join(dir, "spec.json");
  await writeFile(specFile, JSON.stringify({ ...spec, requirements: req }));
  const o = join(dir, "accept.json");
  await sh(["python3", join(tk, "tools/check_acceptance.py"), boardFile, o, "--drc", drcFile], { FLOW_SPEC: specFile });
  return { result: JSON.parse(await readFile(o, "utf8")), specFile };
}
const DRIVER = `
import json, sys, types
from pathlib import Path
import checks
spec, out, stub = sys.argv[1:4]
board = types.SimpleNamespace(cfg={}, spec=spec, pcb=Path('board.kicad_pcb'))
ctx = types.SimpleNamespace(board=board, out=Path(out), cli=stub, drc=None)
r = checks.check_drc(ctx)
print(json.dumps({'status': r.status, 'detail': r.detail, 'findings': [{k: f.to_json()[k] for k in ('layer', 'rule', 'severity', 'claim', 'key', 'evidence')} for f in r.findings]}))
`;
async function pyReviewDrc(specFile: string, drcFile: string, dir: string) {
  const o = join(dir, "review-py");
  await mkdir(o, { recursive: true });
  const stub = join(dir, "kicad-stub.sh");
  await writeFile(stub, `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${drcFile}" "$2"; fi; shift; done\n`);
  await chmod(stub, 0o755);
  const drv = join(dir, "drc-driver.py");
  await writeFile(drv, DRIVER);
  return JSON.parse((await sh(["python3", drv, specFile, o, stub], { FLOW_SPEC: specFile, PYTHONPATH: [join(tk, "review"), join(tk, "tools"), tk].join(":") })).trim().split("\n").pop()!);
}
async function tsReviewDrc(acc: Acceptance, drcFile: string, dir: string) {
  const o = join(dir, "review-ts");
  await mkdir(o, { recursive: true });
  const ctx = {
    out: o,
    env: {
      kicadVersion: "parity",
      kicad: async (args: string[]) => {
        await cp(drcFile, args[args.indexOf("-o") + 1]!);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    project: { pcb: boardFile, cfg: {} },
    acceptance: acc,
    drc: null as string | null,
  };
  const r = await checkDrc(ctx as never);
  return { status: r.status, detail: r.detail, findings: r.findings.map((f) => ({ layer: f.layer, rule: f.rule, severity: f.severity, claim: f.claim, key: f.key, evidence: f.evidence })) };
}

// ---- compare
const summaryTable: Array<Record<string, unknown>> = [];
for (const d of drcs) {
  const drcIn = await drcInputFromFile(d.file);
  for (const v of variants) {
    const dir = join(out, `${d.name.replace(/\W+/g, "-")}--${v.name}`);
    await mkdir(dir, { recursive: true });
    const { result: py, specFile } = await pyAccept(v, d.file, dir);
    const req: Requirements = { acceptance: portAcceptance(v.acc), circuit, mechanical, heights };
    const ts = checkAcceptance(board, req, drcIn, { boardPath: boardFile });
    await writeFile(join(dir, "port-accept.json"), JSON.stringify(ts, null, 1));
    const label = `${d.name} / ${v.name}`;
    record(`${label}: summary`, JSON.stringify(py.summary) === JSON.stringify(ts.summary), { py: py.summary, ts: ts.summary });
    for (const key of Object.keys(py.results)) {
      const dd: string[] = [];
      diff(py.results[key], (ts.results as Record<string, unknown>)[key], key, dd);
      record(`${label}: ${key}`, dd.length === 0, dd.slice(0, 8));
    }
    const a2 = ts.results.A2_drc as Record<string, unknown>;
    summaryTable.push({ drc: d.name, variant: v.name, verdicts: Object.values(ts.summary).map((x) => (x ? "P" : "F")).join(""), A2_errors: a2["errors"], accepted: (a2["accepted_courtyard_overlaps"] as unknown[] | undefined)?.length ?? null, not_present: a2["courtyard_exceptions_not_present"] ?? null, proxy: a2["class_width_proxy_findings_judged_by_A7"], A7: ts.results.A7_widths["undersize_length_mm"] });
    if (v.name === "as-written" || v.name === "no-exceptions" || v.name === "one-dropped-one-absent") {
      const pr = await pyReviewDrc(specFile, d.file, dir);
      const tr = await tsReviewDrc(req.acceptance, d.file, dir);
      const dd: string[] = [];
      diff(pr, tr, "check_drc", dd);
      const judged = (tr.findings as Array<{ key: string; claim: string }>).filter((f) => f.key.startsWith("judged")).map((f) => f.claim.split(":")[0]);
      record(`${label}: review drc check (${tr.findings.length} findings; ${judged.join("; ") || "none judged"})`, dd.length === 0, dd.slice(0, 8));
    }
  }
}

await writeFile(join(out, "acceptance-parity.json"), JSON.stringify({ toolkit: tk, spec: a.spec, proseDiffs: [...proseDiffs], drcs, variants: variants.map((v) => ({ name: v.name, note: v.note })), summaryTable, rows }, null, 1));
const agree = rows.filter((r) => r.agree).length;
await writeFile(
  join(out, "acceptance-parity.md"),
  [
    `# Acceptance parity: ${spec.name ?? stem}`,
    "",
    `Board ${boardFile}; oracle ${tk} (check_acceptance.py, review/checks.py check_drc).`,
    "",
    "| DRC | variant | A1-A9 | A2 errors | accepted overlaps | exceptions not present | proxy items | A7 undersize mm |",
    "|---|---|---|---|---|---|---|---|",
    ...summaryTable.map((s) => `| ${s.drc} | ${s.variant} | ${s.verdicts} | ${JSON.stringify(s.A2_errors)} | ${s.accepted ?? "-"} | ${JSON.stringify(s.not_present ?? "-")} | ${s.proxy} | ${JSON.stringify(s.A7)} |`),
    "",
    "| item | agrees |",
    "|---|---|",
    ...rows.map((r) => `| ${r.item} | ${r.agree ? "yes" : "NO"} |`),
    "",
    `Free-text fields that differ (wording only, compared apart): ${[...proseDiffs].join(", ") || "none"}.`,
    "",
    `${agree}/${rows.length} agree`,
  ].join("\n"),
);
console.log(`\n${agree}/${rows.length} agree`);
process.exit(agree === rows.length ? 0 : 1);

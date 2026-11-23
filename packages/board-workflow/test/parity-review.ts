/**
 * Review parity: the toolkit's `pcb review run` against `runReview` on one board.
 *
 *   bun packages/board-workflow/test/parity-review.ts --board DIR --out DIR [--kicad-cli PATH] [--toolkit DIR] [--no-pack]
 *
 * Not part of `bun run test` (needs the Python toolkit, kicad-cli and the LCSC cache). Both sides run offline on a copy of the
 * board, with the same requirements and the same fetch cache (a copy of the toolkit's), the same checks (all but silk, which
 * belongs to the silk stage). The BOM check reads the BOM decisions the toolkit's own bomcheck wrote, so the TypeScript side
 * tests how a BOM record becomes findings, not bomcheck. Writes parity-review.json and review-parity.md into --out.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runKicadCli, type KicadCli } from "../../kicad/src/index";
import { onboard, openReviewProject, parseBoard, runReview, type BomDecisions, type ReviewEnv, type ReviewRecord } from "../src/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    out: { type: "string" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    "no-pack": { type: "boolean", default: false },
    stress: { type: "boolean", default: false },
    cpl: { type: "string" },
  },
});
if (!a.board || !a.out) throw new Error("--board and --out are required");
const out = a.out;
const toolkit = a.toolkit!;
const cliPath = a["kicad-cli"]!;
await rm(out, { recursive: true, force: true });
const proj = join(out, "proj");
await mkdir(proj, { recursive: true });
for (const n of await readdir(a.board))
  if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty")) await cp(join(a.board, n), join(proj, n), { recursive: true });
const stem = (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!.replace(/\.kicad_pcb$/, "");
const cache = join(out, "fetch-cache");
await cp(join(toolkit, ".cache", "lcsc"), cache, { recursive: true });

const CHECKS = ["identity", "netlist", "erc", "drc", "acceptance", "pinsense", "cards", "decoupling", "current", "impedance", "manual", "mouth", "interconnect", "bom", "ratings", "coverage", "evidence", "custom", ...(a["no-pack"] ? [] : ["pack"])];

// requirements: TypeScript onboarding, used by both sides
await onboard(proj, { name: "parity" });
const reqDir = join(proj, ".fabdesk", "board", "requirements");

// stressed settings: the checks that find nothing on a clean board get something to find (both sides read the same data)
let reviewCfg: Record<string, unknown> = {};
if (a.stress) {
  const b = parseBoard(await readFile(join(proj, `${stem}.kicad_pcb`), "utf8"));
  const count = new Map<string, number>();
  for (const s of b.segments) count.set(s.net, (count.get(s.net) ?? 0) + 1);
  const nets = [...count].filter(([n]) => n && !/[+-]$|_[PN]$|DP|DN/i.test(n)).sort((x, y) => y[1] - x[1]).map(([n]) => n);
  const pwr = nets.filter((n) => /5V|3V3|VBUS|VCC|VDD|\dV\d|VIN|SYS|BAT/i.test(n));
  reviewCfg = {
    currents: Object.fromEntries([...pwr.slice(0, 4), ...nets.slice(0, 3)].map((n, i) => [n, [3, 2, 1.5, 1, 4, 0.8, 0.5][i]!])),
    current_check: { rise_max_c: 5, drop_max_pct: 0.2, min_track_mm: 1 },
    net_voltages: { "^.*5V.*$": 5, ...(pwr[0] ? { [pwr[0]]: 3.3 } : {}) },
    manual_review: ["check the HDMI return path", "confirm the CM5 boot straps"],
    mouth: { edge_mm: 12 },
    decoupling: { max_mm: 1.2, max_mm_bulk: 2 },
    impedance: { model_uncertainty_pct: 0, min_run_mm: 1 },
    assembly: { sides: ["F"], post_assembly: {}, ...(a.cpl ? { cpl: a.cpl } : {}) },
  };
  await mkdir(join(proj, ".fabdesk", "board", "review"), { recursive: true });
  await writeFile(join(proj, ".fabdesk", "board", "review", "config.json"), JSON.stringify(reviewCfg));
}

// ---- oracle
const boards = join(out, "py-boards"), runs = join(out, "py-runs");
await mkdir(boards, { recursive: true });
await writeFile(join(out, "spec.json"), JSON.stringify({ name: "parity", stem, base: proj, requirements: reqDir, fixed: "^$" }));
await writeFile(join(boards, "parity.json"), JSON.stringify({ name: "parity", spec: join(out, "spec.json"), review: reviewCfg }));
const env = { ...process.env, PCB_BOARDS: boards, PCB_RUNS: runs, PCB_PROJECT: proj, PCB_SELFRECORD: "off", PYTHONDONTWRITEBYTECODE: "1" };
async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, text: o + e };
}
let t0 = Date.now();
const py = await sh(["python3", join(toolkit, "review/review.py"), "run", "parity", "--offline", "--checks", CHECKS.join(",")]);
const pySecs = (Date.now() - t0) / 1000;
console.log(py.text.split("\n").slice(-30).join("\n"));
const pyRun = join(runs, "parity", (await readdir(join(runs, "parity"))).filter((n) => /^\d/.test(n)).sort().at(-1)!);
const pyRev = JSON.parse(await readFile(join(pyRun, "review.json"), "utf8")) as ReviewRecord;
const pyBom = join(pyRun, "bom", "bom-decisions.json");

// ---- port
process.env["FABDESK_FETCH_CACHE"] = cache;
const cli: KicadCli = { path: cliPath, version: "unknown" };
const version = (await new Response(Bun.spawn([cliPath, "--version"], { stdout: "pipe" }).stdout).text()).trim();
const rEnv: ReviewEnv = {
  kicad: async (args) => runKicadCli(cli, args, { tolerateExit: true }),
  kicadVersion: version,
  bom: async () => (await Bun.file(pyBom).exists()) ? ((await Bun.file(pyBom).json()) as BomDecisions) : null,
};
const project = await openReviewProject(proj);
t0 = Date.now();
const ts = await runReview(project, rEnv, { checks: CHECKS, offline: true, progress: (n) => console.log("  " + n) });
const tsSecs = (Date.now() - t0) / 1000;

// ---- compare
const norm = (s: string) => s.replace(/(\d)\.0\b/g, "$1").replace(/\s+/g, " ").trim();
const rows: Array<{ check: string; py: number; ts: number; onlyPy: string[]; onlyTs: string[]; sevDiff: string[]; claimDiff: string[]; status: string; detailSame: boolean }> = [];
for (const c of pyRev.checks) {
  const t = ts.review.checks.find((x) => x.name === c.name);
  const pf = pyRev.findings.filter((f) => f.check === c.name), tf = ts.review.findings.filter((f) => f.check === c.name);
  const pm = new Map(pf.map((f) => [f.id, f])), tm = new Map(tf.map((f) => [f.id, f]));
  rows.push({
    check: c.name,
    py: pf.length,
    ts: tf.length,
    onlyPy: [...pm.keys()].filter((k) => !tm.has(k)),
    onlyTs: [...tm.keys()].filter((k) => !pm.has(k)),
    sevDiff: [...pm].filter(([k, f]) => tm.has(k) && tm.get(k)!.severity !== f.severity).map(([k, f]) => `${k}: ${f.severity} vs ${tm.get(k)!.severity}`),
    claimDiff: [...pm].filter(([k, f]) => tm.has(k) && norm(tm.get(k)!.claim) !== norm(f.claim)).map(([k]) => k),
    status: `${c.status} / ${t?.status ?? "missing"}`,
    detailSame: !!t && norm(t.detail) === norm(c.detail),
  });
}
const extra = ts.review.checks.filter((c) => !pyRev.checks.some((x) => x.name === c.name)).map((c) => c.name);
const ok = (r: (typeof rows)[number]) => !r.onlyPy.length && !r.onlyTs.length && !r.sevDiff.length && r.status.split(" / ")[0] === r.status.split(" / ")[1];
const md = [
  `# Review parity: ${stem}`,
  "",
  `Oracle: ${toolkit} (\`review.py run --offline\`, ${pySecs.toFixed(0)} s). Port: runReview (${tsSecs.toFixed(0)} s). kicad: ${version}. Checks: ${CHECKS.join(", ")} (silk is not ported here).`,
  `Findings: oracle ${pyRev.findings.length}, port ${ts.review.findings.length}. Check errors: oracle ${pyRev.checks.filter((c) => c.status === "error").map((c) => c.name).join(",") || "none"}, port ${ts.review.checks.filter((c) => c.status === "error").map((c) => c.name).join(",") || "none"}.`,
  "",
  "| check | status (oracle / port) | findings oracle | findings port | ids same | severities same | claim text same | detail text same |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.check} | ${r.status} | ${r.py} | ${r.ts} | ${!r.onlyPy.length && !r.onlyTs.length ? "yes" : "NO"} | ${r.sevDiff.length ? "NO" : "yes"} | ${r.claimDiff.length ? `NO (${r.claimDiff.length})` : "yes"} | ${r.detailSame ? "yes" : "no"} |`),
  "",
  ...rows.filter((r) => !ok(r)).flatMap((r) => [`## Differences in ${r.check}`, ...r.onlyPy.slice(0, 20).map((i) => `- only in oracle: \`${i}\``), ...r.onlyTs.slice(0, 20).map((i) => `- only in port: \`${i}\``), ...r.sevDiff.map((i) => `- severity ${i}`), ""]),
  `Checks only in the port's record: ${extra.join(", ") || "none"}.`,
  `Verdict: ${rows.every(ok) ? "every check has the same finding ids and severities" : "DIFFERENCES: see above"}.`,
  "",
  "## Claim text differences (informational)",
  ...rows.flatMap((r) => r.claimDiff.slice(0, 5).map((i) => `- ${r.check} \`${i}\``)),
  "",
  "## Detail line differences (informational)",
  ...rows.filter((r) => !r.detailSame).map((r) => `- ${r.check}: oracle \`${pyRev.checks.find((c) => c.name === r.check)!.detail.slice(0, 160)}\` / port \`${ts.review.checks.find((c) => c.name === r.check)!.detail.slice(0, 160)}\``),
  "",
].join("\n");
await writeFile(join(out, "review-parity.md"), md);
await writeFile(join(out, "parity-review.json"), JSON.stringify({ rows, pySecs, tsSecs, py: pyRev.checks, ts: ts.review.checks }, null, 1));
console.log(md);
process.exit(rows.every(ok) ? 0 : 1);

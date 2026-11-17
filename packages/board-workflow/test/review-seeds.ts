/**
 * Seeded-defect bench: plant one known defect into a copy of a project, review, score.
 *
 *   bun packages/board-workflow/test/review-seeds.ts --seeds FILE --base NAME=DIR [--base ...] --out DIR [--only ID,..]
 *
 * Seeds are `data/review/seeds.json` entries. This runner plants the kinds that need no edit tool: `config` (a review
 * setting), `narrow` (every track of a net made narrow) and `touch` (a design file changes after a settled review).
 * `edit` seeds need the edit stage's plan application: they are reported as not planted. A seed counts as caught only
 * when its finding appears on the mutant and is absent on the unseeded base. Not part of `bun run test`.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runKicadCli, type KicadCli } from "../../kicad/src/index";
import { dispose, openReviewProject, reviewGate, runReview, onboard, type FindingRecord, type ReviewConfig, type ReviewEnv } from "../src/index";

const { values: a } = parseArgs({
  options: { seeds: { type: "string" }, base: { type: "string", multiple: true }, out: { type: "string" }, only: { type: "string" }, "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" } },
});
if (!a.seeds || !a.out || !a.base?.length) throw new Error("--seeds, --base NAME=DIR and --out are required");
const bases = Object.fromEntries(a.base.map((b) => b.split("=") as [string, string]));
const cli: KicadCli = { path: a["kicad-cli"]!, version: "unknown" };
const env: ReviewEnv = { kicad: (args) => runKicadCli(cli, args, { tolerateExit: true }), kicadVersion: "bench" };
process.env["FABDESK_FETCH_CACHE"] ??= join(a.out, "fetch-cache");

type Seed = { id: string; class: string; base: string; checks?: string[]; checks_add?: string[]; config?: ReviewConfig; narrow?: { net?: string; nets?: string[]; width: number }; touch?: boolean; edit?: unknown; expect: Record<string, string> };
const spec = JSON.parse(await readFile(a.seeds, "utf8")) as { checks: string[]; seeds: Seed[] };
const copy = async (from: string, to: string) => {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true, filter: (s) => !/-backups|\.zip$|\/\.fabdesk\/board\/review\/runs/.test(s) });
};
const matches = (f: FindingRecord, x: Record<string, string>) =>
  f.severity !== "note" && (!x["rule"] || f.rule === x["rule"]) && (!x["ref"] || f.ref === x["ref"]) && (!x["pad"] || f.pad === x["pad"]) && (!x["side"] || f.claim.includes(` on ${x["side"]} `)) && (!x["net"] || f.net === x["net"]);

async function review(dir: string, checks: string[], cfg: ReviewConfig) {
  await mkdir(join(dir, ".fabdesk", "board", "review"), { recursive: true });
  await writeFile(join(dir, ".fabdesk", "board", "review", "config.json"), JSON.stringify({ ...cfg, checks_only: checks }));
  return runReview(await openReviewProject(dir), env, { offline: true });
}

const rows: Array<{ seed: string; class: string; caught: boolean; planted: boolean; by: string[]; note: string }> = [];
const baseIds = new Map<string, Set<string>>();
for (const s of spec.seeds) {
  if (a.only && !a.only.split(",").includes(s.id)) continue;
  const row = { seed: s.id, class: s.class, caught: false, planted: true, by: [] as string[], note: "" };
  rows.push(row);
  const baseDir = bases[s.base];
  if (!baseDir) {
    Object.assign(row, { planted: false, note: `no --base ${s.base}` });
    continue;
  }
  if (s.edit) {
    Object.assign(row, { planted: false, note: "edit seed: needs the edit stage" });
    continue;
  }
  const checks = [...spec.checks, ...(s.checks_add ?? [])];
  const work = join(a.out, s.id);
  try {
    await copy(baseDir, join(work, "project"));
    if (s.touch) {
      // a design file changes after a fully settled review: the gate must go stale (exit 1)
      const p = await openReviewProject(join(work, "project"));
      const r = await review(join(work, "project"), ["identity", "netlist"], {});
      if (r.review.findings.length) await dispose(p, { id: "*", state: "accept", by: "owner", reason: "seed bench", third_source: "seed bench" });
      const g0 = await reviewGate(p);
      await writeFile(p.pcb, (await readFile(p.pcb, "utf8")) + "\n");
      const g1 = await reviewGate(p);
      row.caught = g0.exit === 0 && g1.exit === Number(s.expect["gate_exit"]);
      row.by = [`gate before edit: exit ${g0.exit}; after: exit ${g1.exit}`];
      continue;
    }
    const cfg = { ...s.config };
    if (s.narrow) {
      const pcb = join(work, "project", (await readdir(join(work, "project"))).find((n) => n.endsWith(".kicad_pcb"))!);
      const nets = s.narrow.nets ?? [s.narrow.net!];
      let n = 0;
      const t = (await readFile(pcb, "utf8")).replace(/\(segment\b[\s\S]*?\n\s*\)/g, (blk) => {
        if (!nets.some((net) => blk.includes(`(net "${net}")`))) return blk;
        n++;
        return blk.replace(/\(width [\d.]+\)/, `(width ${s.narrow!.width})`);
      });
      if (!n) throw new Error(`no segment of ${nets} found to narrow`);
      await writeFile(pcb, t);
    }
    const key = `${s.base}|${checks.join(",")}|${JSON.stringify(cfg)}`;
    if (!baseIds.has(key)) {
      await copy(baseDir, join(work, "base"));
      const b = await review(join(work, "base"), checks, s.narrow ? { ...s.config } : {});
      baseIds.set(key, new Set(b.review.findings.map((f) => f.id)));
    }
    await onboard(join(work, "project"), { name: s.id }).catch(() => {});
    const rv = await review(join(work, "project"), checks, cfg);
    const hit = rv.review.findings.filter((f) => matches(f, s.expect) && !baseIds.get(key)!.has(f.id));
    row.caught = hit.length > 0;
    row.by = hit.map((f) => f.id).slice(0, 3);
  } catch (e) {
    Object.assign(row, { planted: false, note: String(e).slice(0, 200) });
  }
}
const caught = rows.filter((r) => r.caught).length, planted = rows.filter((r) => r.planted).length;
console.log(`seeded defects: ${caught}/${planted} planted seeds caught (${rows.length} seeds; ${rows.length - planted} not planted)`);
for (const r of rows) console.log(`  ${r.seed.padEnd(24)} ${r.caught ? "CAUGHT" : r.planted ? "missed" : "NOT PLANTED " + r.note} ${r.by.join(" ")}  [${r.class}]`);
await writeFile(join(a.out, "seeds-result.json"), JSON.stringify({ caught, planted, seeds: rows.length, rows }, null, 1));

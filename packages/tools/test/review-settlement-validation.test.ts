import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReviewProject, runReview, reviewGate, fixProposals, judge, type Disposition } from "@fabdesk/board-workflow";
import { fakeEnv, PCB } from "../../board-workflow/test/review-fixture";
import { recordReviewGate, readReviewGate, gateLabels } from "../src/board-state";
import { fabricationGate } from "../src/fabrication-gate";
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const json = async (dir: string, path: string, value: unknown) => { await mkdir(join(dir, path, ".."), { recursive: true }); await writeFile(join(dir, path), JSON.stringify(value)); };
const id = "L8:EXPERT:-:-:pending";
async function project(checks = ["identity"]) {
  const dir = await mkdtemp(join(tmpdir(), "settlement-validation-")); dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), PCB);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  await json(dir, ".fabdesk/board/review/config.json", { checks_only: checks });
  await json(dir, ".fabdesk/board/onboard.json", {});
  return openReviewProject(dir);
}
async function gates(p: Awaited<ReturnType<typeof project>>, expected: "open" | "pass") {
  const live = await reviewGate(p);
  await recordReviewGate(p.dir, { ...live, ...gateLabels(live) });
  const saved = await readReviewGate(p.dir);
  let fab = "pass";
  try { await fabricationGate(p.dir, "export_gerbers"); } catch (e) { expect(String(e)).toContain("fabrication refused"); fab = "open"; }
  expect({ live: live.state, saved: saved.state, fab }).toEqual({ live: expected, saved: expected, fab: expected });
  return live;
}
const invalid = [
  { name: "no author", value: { state: "accept", reason: "Prototype waiver" }, why: "no author" },
  { name: "unknown author", value: { state: "accept", by: "nobody", reason: "Prototype waiver" }, why: "author" },
  { name: "unknown state", value: { state: "bogus", by: "agent", reason: "Prototype waiver" }, why: "state" },
];
for (const v of invalid) test(`invalid coverage disposition: ${v.name}`, async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  await json(p.dir, ".fabdesk/board/review/dispositions.json", { [id]: v.value });
  const live = await gates(p, "open");
  expect(live.lines.join("\n")).toContain(`disposition for ${id} ignored:`);
  expect(live.lines.join("\n")).toContain(v.why);
});
for (const v of invalid) test(`ordinary findings ignore ${v.name}`, () => {
  expect(judge({ severity: "question" }, { ...v.value, third_source: "Independent evidence" } as Disposition)[0]).toBe(true);
  expect(judge({ severity: "must-fix" }, { ...v.value, third_source: "Independent evidence" } as Disposition)[0]).toBe(true);
});
for (const decision of ["", "   \t\n"]) test(`blank intent cannot settle coverage: ${JSON.stringify(decision)}`, async () => {
  const p = await project();
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [{ id: "D1", by: "owner", decision, covers: [{ id }] }] });
  await runReview(p, fakeEnv(), { offline: true });
  await gates(p, "open");
});
for (const by of ["agent", "nobody"]) test(`intent cannot impersonate owner: ${by}`, async () => {
  const p = await project();
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [{ id: "D1", by, decision: "Proceed", covers: [{ id }] }] });
  await runReview(p, fakeEnv(), { offline: true }); await gates(p, "open");
});
for (const by of ["agent", "owner"]) for (const state of ["accept", "defer", "false-positive"]) test(`valid coverage ${by} ${state}`, async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  await json(p.dir, ".fabdesk/board/review/dispositions.json", { [id]: { state, by, reason: "Prototype waiver", third_source: "Independent evidence" } });
  await gates(p, "pass");
});
test("blank intent stays open through pack proposals and apply", async () => {
  const p = await project(["pack"]);
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [{ id: "D1", by: "owner", decision: "   ", covers: [{ id }] }] });
  const run = await runReview(p, fakeEnv(), { offline: true });
  await gates(p, "open");
  const fix = await fixProposals(p, { apply: true, build: false });
  expect(fix.settled).toEqual([]);
  expect(JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/dispositions.json"), "utf8"))).toEqual({});
  await gates(p, "open");
  expect(run.review.findings.find(f => f.id === id)?.proposal?.apply.kind).not.toBe("disposition");
});
test("apply revalidates a persisted legacy owner-decision proposal", async () => {
  const p = await project(["pack"]);
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [{ id: "D1", by: "owner", decision: "   ", covers: [{ id }] }] });
  const run = await runReview(p, fakeEnv(), { offline: true });
  const f = run.review.findings.find(f => f.id === id)!;
  f.proposal = { by: "workflow", action: "owner decision D1", effect: "", apply: { kind: "disposition", as: "owner", state: "accept", reason: "owner decision D1 ():    " } };
  await writeFile(join(run.dir, "review.json"), JSON.stringify(run.review));
  await fixProposals(p, { apply: true, build: false });
  expect(JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/dispositions.json"), "utf8"))).toEqual({});
  await gates(p, "open");
});
for (const [state, label] of [["missing", "missing"], ["current", "completed"], ["deferred", "deferred"]]) test(`base-format saved gate normalizes independent coverage: ${state}`, async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  await recordReviewGate(p.dir, await reviewGate(p));
  const path = join(p.dir, ".fabdesk/board/review-gate.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  const detail = { ...saved.independentCoverage, state };
  saved.independentReview = detail; delete saved.independentCoverage;
  await writeFile(path, JSON.stringify(saved));
  const gate = await readReviewGate(p.dir);
  expect(gate.independentReview).toBe(label);
  expect(gate).toHaveProperty("independentCoverage", detail);
});

for (const by of [undefined, "owner"]) test(`valid owner intent retains legacy author support: ${by}`, async () => {
  const p = await project();
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [{ id: "D1", ...(by ? { by } : {}), decision: "Proceed with this prototype", covers: [{ id }] }] });
  await runReview(p, fakeEnv(), { offline: true }); await gates(p, "pass");
});
test("apply revalidates a new proposal after intent becomes blank", async () => {
  const p = await project(["pack"]);
  const intent = { decisions: [{ id: "D1", by: "owner", decision: "Proceed", covers: [{ id }] }] };
  await json(p.dir, ".fabdesk/board/review/intent.json", intent);
  const run = await runReview(p, fakeEnv(), { offline: true });
  expect(run.review.findings.find(f => f.id === id)?.proposal?.apply).toHaveProperty("intent_decision", "D1");
  intent.decisions[0]!.decision = "   ";
  await json(p.dir, ".fabdesk/board/review/intent.json", intent);
  await fixProposals(p, { apply: true, build: false });
  expect(JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/dispositions.json"), "utf8"))).toEqual({});
  await gates(p, "open");
});

for (const by of ["agent", "owner"]) test(`ordinary valid acceptance still passes: ${by}`, () => {
  const disp: Disposition = { state: "accept", by, reason: "Checked against the independent source", third_source: "Independent evidence" };
  expect(judge({ severity: "question" }, disp)[0]).toBe(false);
  expect(judge({ severity: "must-fix" }, disp, { preferences: { workflow_decides: ["must-fix"] } })[0]).toBe(false);
});

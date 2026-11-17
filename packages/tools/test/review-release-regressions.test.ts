import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openReviewProject, runReview, importExpert, reviewGate, stageState, currentReviewHash, dispose, designHash } from "@fabdesk/board-workflow";
import { fakeEnv, PCB } from "../../board-workflow/test/review-fixture";
import { recordReviewGate, readReviewGate } from "../src/board-state";
import { fabricationGate, packageWaivers } from "../src/fabrication-gate";
import { packageFixture } from "./release-package-fixture";
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const json = async (dir: string, path: string, value: unknown) => { await mkdir(join(dir, path, ".."), { recursive: true }); await writeFile(join(dir, path), JSON.stringify(value)); };
async function project(checks = ["pack"]) {
  const dir = await mkdtemp(join(tmpdir(), "stage-regression-")); dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), PCB);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  await json(dir, ".fabdesk/board/review/config.json", { checks_only: checks });
  await json(dir, ".fabdesk/board/onboard.json", {});
  return openReviewProject(dir);
}
const provenance = async (p: { dir: string; pcb: string }) => ({ designHash: await currentReviewHash(p.dir), pcb: p.pcb.slice(p.dir.length + 1) });
for (const skipPack of [false, true]) test(`common gate requires coverage even with accepted question / pack skipped=${skipPack}`, async () => {
  const p = await project(skipPack ? ["identity"] : ["pack"]);
  await runReview(p, fakeEnv(), { offline: true });
  if (!skipPack) await dispose(p, { id: "L8:EXPERT:-:-:pending", state: "accept", by: "owner", reason: "Settled" });
  const gate = await reviewGate(p);
  expect(gate.state).toBe("open");
  expect(gate.lines.join(" ")).toContain("independent");
  await recordReviewGate(p.dir, gate);
  expect((await readReviewGate(p.dir)).state).toBe("open");
  expect(JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review-gate.json"), "utf8")).state).toBe("open");
  await expect(fabricationGate(p.dir, "export_gerbers")).rejects.toThrow("fabrication refused");
});
test("expert evidence cannot be rebound by reimport; unbound evidence is rejected", async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  await expect(importExpert(p, { findings: [] })).rejects.toThrow("provenance");
  const ex = { ...await provenance(p), findings: [] };
  await importExpert(p, ex);
  await writeFile(p.pcb, PCB + "\n"); await runReview(p, fakeEnv(), { offline: true });
  await expect(importExpert(p, ex)).rejects.toThrow("provenance");
  expect((await stageState(p.dir)).independent.state).toBe("covers an earlier design");
});
test("coverage and legacy migration preserve the reviewed board", async () => {
  const p = await project();
  await writeFile(join(p.dir, "other.kicad_pcb"), PCB);
  await runReview(p, fakeEnv(), { offline: true });
  await importExpert(p, { ...await provenance(p), findings: [] });
  // Simulate pre-board-field persisted imports; their source run still has provenance.
  const file = join(p.dir, ".fabdesk/board/review/independent.json");
  const legacy = JSON.parse(await readFile(file, "utf8")); delete legacy.pcb; await writeFile(file, JSON.stringify(legacy));
  const other = await openReviewProject(p.dir, "other.kicad_pcb");
  await runReview(other, fakeEnv(), { offline: true });
  await expect(importExpert(other, { designHash: legacy.hash, pcb: "board.kicad_pcb", findings: [] })).rejects.toThrow("provenance");
  expect((await stageState(p.dir, other.pcb)).independent.state).toBe("covers an earlier design");
  expect((await reviewGate(other)).state).toBe("open");
  expect(JSON.parse(await readFile(file, "utf8")).pcb).toBe("board.kicad_pcb");
  await importExpert(other, { ...await provenance(other), findings: [] });
  const gate = await reviewGate(other);
  expect(gate.state).toBe("pass");
  await recordReviewGate(p.dir, gate);
  expect((await readReviewGate(p.dir, other.pcb)).state).toBe("pass");
  expect((await readReviewGate(p.dir, p.pcb)).state).toBe("stale");
});
test("legacy run-only imports retain their original design and board after edits", async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  const original = await provenance(p);
  await importExpert(p, { ...original, findings: [] });
  await rm(join(p.dir, ".fabdesk/board/review/independent.json"));
  await writeFile(p.pcb, PCB + "\n");
  await runReview(p, fakeEnv(), { offline: true });
  const migrated = JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/independent.json"), "utf8"));
  expect(migrated.hash).toBe(original.designHash);
  expect(migrated.pcb).toBe(original.pcb);
  expect((await stageState(p.dir)).independent.state).toBe("covers an earlier design");
});
test("owner deferral never suppresses current expert problems on rerun", async () => {
  const p = await project(); await runReview(p, fakeEnv(), { offline: true });
  await dispose(p, { id: "L8:EXPERT:-:-:pending", state: "defer", by: "owner", reason: "Unavailable" });
  await importExpert(p, { ...await provenance(p), findings: [{ severity: "PROBLEM", claim: "Unsafe clearance", evidence: "Measured violation" }] });
  expect((await reviewGate(p)).state).toBe("open");
  const again = await runReview(p, fakeEnv(), { offline: true });
  expect(again.review.findings.some(f => f.claim === "Unsafe clearance")).toBe(true);
  expect((await reviewGate(p)).state).toBe("open");
  await json(p.dir, ".fabdesk/board/review/config.json", { checks_only: ["identity"] });
  const withoutPack = await runReview(p, fakeEnv(), { offline: true });
  expect(withoutPack.review.findings.some(f => f.claim === "Unsafe clearance")).toBe(true);
  expect((await reviewGate(p)).state).toBe("open");
});
test("release currency validates the recorded package and all evidence", async () => {
  const p = await project(); const out = await packageFixture(p.dir);
  expect((await stageState(p.dir)).release.state).toBe("current");
  await writeFile(join(out, "evidence.txt"), "altered");
  expect((await stageState(p.dir)).release.state).toBe("stale");
  await packageFixture(p.dir); await rm(join(out, "evidence.txt"));
  expect((await stageState(p.dir)).release.state).toBe("stale");
  await packageFixture(p.dir); await writeFile(join(out, "manifest.json"), "{}");
  expect((await stageState(p.dir)).release.state).toBe("stale");
  await packageFixture(p.dir); await rm(out, { recursive: true });
  await packageFixture(p.dir, "exports/release-unrelated", false);
  expect((await stageState(p.dir)).release.state).toBe("stale");
});
for (const change of ["board.kicad_sch", ".fabdesk/board/requirements/board.json"]) test(`legacy acceptance cannot complete after ${change} changes`, async () => {
  const p = await project(); const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const summary = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`A${i + 1}`, true]));
  await json(p.dir, ".fabdesk/board/accept/index.json", [{ sha256: sha(PCB), summary }]);
  await json(p.dir, change, { changed: true });
  const paths = ["renders/pcb.svg", "renders/board.glb", "renders/schematic.svg", "reports/drc.json", "reports/erc.json"];
  for (const path of paths) { await mkdir(join(p.dir, path, ".."), { recursive: true }); await writeFile(join(p.dir, path), "fixture"); }
  await json(p.dir, "reports/board-completion.json", { pcb: "board.kicad_pcb", boardSha256: sha(PCB), designHash: await currentReviewHash(p.dir), checksPass: true, artifacts: paths.map(path => ({ path, sha256: sha("fixture") })) });
  expect((await stageState(p.dir)).board.complete).toBe(false);
  await json(p.dir, ".fabdesk/board/accept/index.json", [{ pcb: "board.kicad_pcb", sha256: sha(PCB), designHash: (await designHash(p.dir)).design, summary, parityChecked: true }]);
  expect((await stageState(p.dir)).board.complete).toBe(true);
});
test("package waiver helper returns the final saved manifest", async () => {
  const p = await project(); const out = await packageFixture(p.dir);
  await fabricationGate(p.dir, "board_release fab", "Owner authorized prototype");
  const result = await packageWaivers(p.dir, out);
  expect(result).toEqual(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  expect(result?.reviewWaivers).toHaveLength(1);
});

for (const [changed, problem] of [[false, true], [true, true], [true, false]]) test(`latest legacy import wins, changed design=${changed}, problem=${problem}`, async () => {
  const p = await project(["identity"]);
  const run = (second: number) => runReview(p, fakeEnv(), { offline: true, now: () => new Date(`2026-11-18T00:00:0${second}Z`) });
  await run(1); await importExpert(p, { ...await provenance(p), findings: [] });
  if (changed) await writeFile(p.pcb, PCB + "\n");
  await run(2);
  await importExpert(p, { ...await provenance(p), findings: problem ? [{ severity: "PROBLEM", claim: "Later unsafe clearance", evidence: "Measured violation" }] : [] });
  const hash = await currentReviewHash(p.dir);
  const ordinary = await run(3);
  const legacy = ordinary.review;
  legacy.checks = legacy.checks.filter(c => c.name !== "expert");
  legacy.findings = legacy.findings.filter(f => f.check !== "expert");
  await writeFile(join(ordinary.dir, "review.json"), JSON.stringify(legacy));
  await rm(join(p.dir, ".fabdesk/board/review/independent.json"));
  expect((await stageState(p.dir)).independent.coveredDesign).toBe(hash);
  const migrated = JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/independent.json"), "utf8"));
  expect(migrated.findings.map((f: { claim: string }) => f.claim)).toEqual(problem ? ["Later unsafe clearance"] : []);
  // The live gate must consume recovered findings even before the next run carries them.
  const check = async () => {
    expect((await reviewGate(p)).state).toBe(problem ? "open" : "pass");
    if (problem) await expect(fabricationGate(p.dir, "export_gerbers")).rejects.toThrow("fabrication refused");
    else expect(await fabricationGate(p.dir, "export_gerbers")).toBeNull();
  };
  await check();
  const again = await run(4);
  expect(again.review.findings.some(f => f.claim === "Later unsafe clearance")).toBe(!!problem);
  await check();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function publishFixture(dir: string, pcb = "board.kicad_pcb") {
  const paths = ["renders/pcb.svg", "renders/board.glb", "renders/schematic.svg", "reports/drc.json", "reports/erc.json"];
  for (const path of paths) { await mkdir(join(dir, path, ".."), { recursive: true }); await writeFile(join(dir, path), "published"); }
  await json(dir, "reports/board-completion.json", { pcb, boardSha256: sha(await readFile(join(dir, pcb), "utf8")), designHash: await currentReviewHash(dir), checksPass: true, artifacts: paths.map(path => ({ path, sha256: sha("published") })) });
}
async function acceptFixture(dir: string, pcb: string, named = true) {
  await json(dir, ".fabdesk/board/accept/index.json", [{ ...(named ? { pcb } : {}), sha256: sha(await readFile(join(dir, pcb), "utf8")), designHash: (await designHash(dir)).design, parityChecked: true, summary: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`A${i + 1}`, true])) }]);
}
for (const identical of [false, true]) test(`publication covers only its named board, identical bytes=${identical}`, async () => {
  const p = await project();
  await writeFile(join(p.dir, "other.kicad_pcb"), identical ? PCB : PCB + "\n");
  await acceptFixture(p.dir, "other.kicad_pcb"); await publishFixture(p.dir);
  expect((await stageState(p.dir, "other.kicad_pcb")).board.status).toContain("previews missing");
  await acceptFixture(p.dir, "board.kicad_pcb");
  expect((await stageState(p.dir)).board.complete).toBe(true);
  const file = join(p.dir, "reports/board-completion.json");
  const receipt = JSON.parse(await readFile(file, "utf8")); receipt.boardSha256 = sha("wrong"); await writeFile(file, JSON.stringify(receipt));
  expect((await stageState(p.dir)).board.complete).toBe(false);
  delete receipt.pcb; delete receipt.boardSha256; await writeFile(file, JSON.stringify(receipt));
  expect((await stageState(p.dir)).board.complete).toBe(false);
});
test("unnamed acceptance cannot establish completion for an ambiguous board", async () => {
  const p = await project(); await writeFile(join(p.dir, "other.kicad_pcb"), PCB);
  await publishFixture(p.dir, "other.kicad_pcb"); await acceptFixture(p.dir, "other.kicad_pcb", false);
  expect((await stageState(p.dir, "other.kicad_pcb")).board.complete).toBe(false);
});
test("saved gate expires when independent evidence changes without a run rewrite", async () => {
  const p = await project(["identity"]); await runReview(p, fakeEnv(), { offline: true });
  await importExpert(p, { ...await provenance(p), findings: [] });
  await recordReviewGate(p.dir, await reviewGate(p));
  expect((await readReviewGate(p.dir)).state).toBe("pass");
  const latest = JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/latest.json"), "utf8"));
  const runFile = join(p.dir, ".fabdesk/board/review/runs", latest.run, "review.json");
  const previous = await readFile(runFile);
  await importExpert(p, { ...await provenance(p), findings: [{ severity: "PROBLEM", claim: "New problem", evidence: "Measured violation" }] });
  await writeFile(runFile, previous);
  expect((await readReviewGate(p.dir)).state).toBe("stale");
  expect((await reviewGate(p)).state).toBe("open");
});
test("legacy import without a board cannot borrow another import's provenance", async () => {
  const p = await project(["identity"]);
  await writeFile(join(p.dir, "other.kicad_pcb"), PCB);
  const other = await openReviewProject(p.dir, "other.kicad_pcb");
  await runReview(other, fakeEnv(), { offline: true, now: () => new Date("2026-11-18T00:00:01Z") });
  await importExpert(other, { ...await provenance(other), findings: [{ severity: "PROBLEM", claim: "Board B problem", evidence: "Measured" }] });
  const file = join(p.dir, ".fabdesk/board/review/independent.json");
  const saved = JSON.parse(await readFile(file, "utf8")); delete saved.pcb;
  await runReview(p, fakeEnv(), { offline: true, now: () => new Date("2026-11-18T00:00:02Z") });
  await importExpert(p, { ...await provenance(p), findings: [] });
  // Persisted legacy evidence belongs to B; the newer A run shares its design hash.
  await writeFile(file, JSON.stringify(saved));
  const stages = await stageState(p.dir);
  expect(stages.independent.coveredBoard).toBe("other.kicad_pcb");
  expect(stages.independent.state).toBe("covers an earlier design");
});
test("saved gate detects legacy evidence migration on its first read", async () => {
  const p = await project(["identity"]); await runReview(p, fakeEnv(), { offline: true });
  await importExpert(p, { ...await provenance(p), findings: [] });
  await recordReviewGate(p.dir, await reviewGate(p));
  await rm(join(p.dir, ".fabdesk/board/review/independent.json"));
  const file = join(p.dir, ".fabdesk/board/review-gate.json");
  const gate = JSON.parse(await readFile(file, "utf8")); delete gate.basis.independent;
  await writeFile(file, JSON.stringify(gate));
  expect((await readReviewGate(p.dir)).state).toBe("stale");
});
test("ambiguous legacy imports remain unverified", async () => {
  const p = await project(["identity"]); await writeFile(join(p.dir, "other.kicad_pcb"), PCB);
  await runReview(p, fakeEnv(), { offline: true, now: () => new Date("2026-11-18T00:00:01Z") });
  await importExpert(p, { ...await provenance(p), findings: [] });
  const other = await openReviewProject(p.dir, "other.kicad_pcb");
  await runReview(other, fakeEnv(), { offline: true, now: () => new Date("2026-11-18T00:00:02Z") });
  await importExpert(other, { ...await provenance(other), findings: [] });
  const file = join(p.dir, ".fabdesk/board/review/independent.json");
  const saved = JSON.parse(await readFile(file, "utf8")); delete saved.pcb; await writeFile(file, JSON.stringify(saved));
  expect((await stageState(p.dir, other.pcb)).independent.coveredBoard).toBeNull();
  expect((await reviewGate(other)).state).not.toBe("pass");
});

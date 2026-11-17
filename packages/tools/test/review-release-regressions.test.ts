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
  await json(p.dir, "reports/board-completion.json", { designHash: await currentReviewHash(p.dir), checksPass: true, artifacts: paths.map(path => ({ path, sha256: sha("fixture") })) });
  expect((await stageState(p.dir)).board.complete).toBe(false);
  await json(p.dir, ".fabdesk/board/accept/index.json", [{ sha256: sha(PCB), designHash: (await designHash(p.dir)).design, summary, parityChecked: true }]);
  expect((await stageState(p.dir)).board.complete).toBe(true);
});
test("package waiver helper returns the final saved manifest", async () => {
  const p = await project(); const out = await packageFixture(p.dir);
  await fabricationGate(p.dir, "board_release fab", "Owner authorized prototype");
  const result = await packageWaivers(p.dir, out);
  expect(result).toEqual(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  expect(result?.reviewWaivers).toHaveLength(1);
});

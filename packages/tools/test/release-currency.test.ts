import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { stageState } from "@fabdesk/board-workflow";
import { inspectProject, planMilestones, remainingMilestones } from "../../../apps/core/src/finish-it-plan";
import { recordReviewGate } from "../src/board-state";
import { packageFixture } from "./release-package-fixture";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function project(same = false) {
  const dir = await mkdtemp(join(tmpdir(), "release-currency-"));
  await writeFile(join(dir, "board.kicad_pcb"), '(kicad_pcb (footprint "A"))');
  await writeFile(join(dir, "other.kicad_pcb"), same ? '(kicad_pcb (footprint "A"))' : '(kicad_pcb (footprint "B"))');
  return dir;
}

for (const same of [false, true]) test(`release covers only its selected PCB (identical bytes: ${same})`, async () => {
  const dir = await project(same);
  await packageFixture(dir);
  expect((await stageState(dir, "board.kicad_pcb")).release.state).toBe("current");
  expect((await stageState(dir, "other.kicad_pcb")).release.state).toBe("stale");
});

test("a secondary-board package cannot finish the default board", async () => {
  const dir = await project();
  await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify({ netlist: { components: [{ ref: "R1", value: "1k", footprint: "R" }], nets: [] } }));
  await mkdir(join(dir, "reports"));
  await writeFile(join(dir, "reports/drc.json"), JSON.stringify({ counts: { errors: 0, unconnected: 0 }, pcbRevision: { sha256: sha(await readFile(join(dir, "board.kicad_pcb"), "utf8")) }, schematicParityChecked: true }));
  await mkdir(join(dir, ".fabdesk/board/accept"), { recursive: true });
  await writeFile(join(dir, ".fabdesk/board/accept/index.json"), JSON.stringify([{ sha256: sha(await readFile(join(dir, "board.kicad_pcb"), "utf8")), summary: { A1: true, A2: true } }]));
  await mkdir(join(dir, ".fabdesk/board/review"), { recursive: true });
  await writeFile(join(dir, ".fabdesk/board/review/dispositions.json"), JSON.stringify({ "L8:EXPERT:-:-:pending": { state: "defer", by: "owner", reason: "Owner defers independent review" } }));
  await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
  await packageFixture(dir, "exports/release-other", true, {}, "other.kicad_pcb");
  expect((await stageState(dir, "other.kicad_pcb")).release.state).toBe("current");
  const snapshot = await inspectProject(dir, { boardChecks: true });
  expect(remainingMilestones(planMilestones(snapshot))).toEqual(["release"]);
});

for (const field of ["receipt hash", "manifest hash", "manifest board"]) test(`release rejects conflicting ${field}`, async () => {
  const dir = await project();
  const out = await packageFixture(dir);
  const receiptPath = join(dir, ".fabdesk/board/release/last-fab.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (field === "receipt hash") receipt.boardSha256 = "wrong";
  else {
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    if (field === "manifest hash") manifest.sources.pcb = "wrong";
    else manifest.sources.pcb_path = "other.kicad_pcb";
    const bytes = JSON.stringify(manifest);
    await writeFile(join(out, "manifest.json"), bytes);
    receipt.manifestSha256 = sha(bytes);
  }
  await writeFile(receiptPath, JSON.stringify(receipt));
  expect((await stageState(dir)).release.state).toBe("stale");
});

for (const recover of [false, true]) test(`legacy receipt uses only recoverable board provenance (${recover})`, async () => {
  const dir = await project();
  const out = await packageFixture(dir);
  const receiptPath = join(dir, ".fabdesk/board/release/last-fab.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  delete receipt.pcb;
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  delete manifest.sources.pcb_path;
  if (recover) manifest.gerbcheck = { pcb: join(dir, "board.kicad_pcb") };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(out, "manifest.json"), bytes);
  receipt.manifestSha256 = sha(bytes);
  await writeFile(receiptPath, JSON.stringify(receipt));
  expect((await stageState(dir)).release.state).toBe(recover ? "current" : "stale");
  expect((await stageState(dir, "other.kicad_pcb")).release.state).toBe("stale");
});

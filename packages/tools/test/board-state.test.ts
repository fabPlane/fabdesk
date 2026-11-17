import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designHash, onboard } from "@fabdesk/board-workflow";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { acceptanceSatisfied, projectHasPlacedBoard, readAcceptanceState, initDoneMode, readDoneMode, readOnboardingCheck, readBoardOverview, releaseAdvisories, confirmOnboarding, readReviewGate, recordAcceptance, recordReviewGate, writeDoneMode } from "../src/board-state";

async function project(board: string, index?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "acc-"));
  await writeFile(join(dir, "board.kicad_pcb"), board);
  if (index) {
    await mkdir(join(dir, ".fabdesk/board/accept"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/accept/index.json"), JSON.stringify(index));
  }
  return dir;
}
const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "R_0402" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A"))
    (pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "B")))
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.05)) (layer "Edge.Cuts")))`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("readAcceptanceState", () => {
  test("none before any measurement", async () => {
    expect(await readAcceptanceState(await project("(kicad_pcb)"))).toEqual({ state: "none", failing: [], pass: false, baselineFailing: [], regressions: [] });
  });
  test("current and passing when the newest result is on the saved board", async () => {
    const dir = await project("(kicad_pcb a)", [{ at: "t", sha256: sha("(kicad_pcb a)"), summary: { A1: true, A2: true } }]);
    expect(await readAcceptanceState(dir)).toMatchObject({ state: "current", pass: true, failing: [] });
  });
  test("names failing checks", async () => {
    const dir = await project("b", [{ at: "t", sha256: sha("b"), summary: { A1: true, A3: false, A8: false } }]);
    expect(await readAcceptanceState(dir)).toMatchObject({ state: "current", pass: false, failing: ["A3", "A8"] });
  });
  test("stale when the board changed since, never a pass", async () => {
    const dir = await project("new", [{ at: "t", sha256: sha("old"), summary: { A1: true } }]);
    expect(await readAcceptanceState(dir)).toMatchObject({ state: "stale", pass: false });
  });
});

describe("readAcceptanceState: the board measured, the full design, parity", () => {
  test("a run that skipped parity does not pass A3; a requirements change makes a result stale; any board name works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acc2-"));
    await writeFile(join(dir, "main.kicad_pcb"), "m");
    const design = (await designHash(dir)).design;
    const all = { A1: true, A2: true, A3: true, A4: true, A5: true, A6: true, A7: true, A8: true, A9: true };
    await mkdir(join(dir, ".fabdesk/board/accept"), { recursive: true });
    const write = (e: object[]) => writeFile(join(dir, ".fabdesk/board/accept/index.json"), JSON.stringify(e));
    await write([{ at: "t", sha256: sha("m"), designHash: design, pcb: "main.kicad_pcb", parityChecked: true, summary: all }]);
    expect(await readAcceptanceState(dir)).toMatchObject({ state: "current", pass: true });
    await write([{ at: "t", sha256: sha("m"), designHash: design, pcb: "main.kicad_pcb", parityChecked: false, summary: all }]);
    const skipped = await readAcceptanceState(dir);
    expect(skipped).toMatchObject({ state: "current", pass: false, failing: ["A3"], parityChecked: false });
    expect(acceptanceSatisfied(skipped, "no-regression")).toBe(false);
    await write([{ at: "t", sha256: sha("m"), designHash: design, pcb: "main.kicad_pcb", parityChecked: true, summary: all }]);
    await mkdir(join(dir, ".fabdesk/board/requirements"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/requirements/requirements.json"), "{}");
    expect((await readAcceptanceState(dir)).state).toBe("stale");
  });
});

describe("projectHasPlacedBoard", () => {
  test("recognizes a project's sole board with a custom name", async () => {
    const dir = await project(BOARD);
    await rename(join(dir, "board.kicad_pcb"), join(dir, "panel.kicad_pcb"));
    expect(await projectHasPlacedBoard(dir)).toBe(true);
  });
  test("a blank board is not an existing board, one with a footprint is", async () => {
    expect(await projectHasPlacedBoard(await project("(kicad_pcb (version 1))"))).toBe(false);
    expect(await projectHasPlacedBoard(await project('(kicad_pcb\n  (footprint "R:0603"\n))'))).toBe(true);
    expect(await projectHasPlacedBoard(await mkdtemp(join(tmpdir(), "nob-")))).toBe(false);
  });
});

describe("no-regression judging", () => {
  const entries = (board: string) => [
    { at: "t0", sha256: sha("first"), summary: { A1: true, A2: false, A3: false, A8: false } },
    { at: "t1", sha256: sha(board), summary: { A1: true, A2: false, A3: false, A8: true } },
  ];
  test("pre-existing failures are the baseline; nothing new is a pass in no-regression, never in strict", async () => {
    const a = await readAcceptanceState(await project("now", entries("now")));
    expect(a).toMatchObject({ state: "current", pass: false, baselineFailing: ["A2", "A3", "A8"], failing: ["A2", "A3"], regressions: [] });
    expect(acceptanceSatisfied(a, "no-regression")).toBe(true);
    expect(acceptanceSatisfied(a, "strict")).toBe(false);
  });
  test("a newly failing check is a regression in both modes", async () => {
    const a = await readAcceptanceState(await project("now", [{ at: "t0", sha256: sha("first"), summary: { A1: true, A5: true } }, { at: "t1", sha256: sha("now"), summary: { A1: false, A5: true } }]));
    expect(a.regressions).toEqual(["A1"]);
    expect(acceptanceSatisfied(a, "no-regression")).toBe(false);
  });
  test("a stale result never satisfies", async () => {
    expect(acceptanceSatisfied(await readAcceptanceState(await project("changed", entries("other"))), "no-regression")).toBe(false);
  });
  test("done mode defaults to strict and persists", async () => {
    const dir = await project("b");
    expect(await readDoneMode(dir)).toBe("strict");
    await writeDoneMode(dir, "no-regression");
    expect(await readDoneMode(dir)).toBe("no-regression");
  });
});

describe("initDoneMode", () => {
  test("an already placed, never-measured board is judged by no new failure; set once", async () => {
    const dir = await project("b");
    expect(await initDoneMode(dir, true)).toBe("no-regression");
    expect(await initDoneMode(dir, false)).toBe("no-regression");
    expect(await initDoneMode(await project("b"), false)).toBe("strict");
  });
  test("a board board_check already measured is strict: the failures may be this project's own", async () => {
    const dir = await project("b", [{ at: "t", sha256: sha("b"), summary: { A1: false } }]);
    expect(await initDoneMode(dir, true)).toBe("strict");
  });
});

describe("review gate record", () => {
  test("none before any review; pass / open / stale / errors as recorded for the saved board", async () => {
    const dir = await project("board-1");
    expect(await readReviewGate(dir)).toEqual({ state: "none" });
    await mkdir(join(dir, ".fabdesk/board/review"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/review/dispositions.json"), JSON.stringify({ "L8:EXPERT:-:-:pending": { state: "defer", by: "owner", reason: "Fixture owner deferral" } }));
    await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
    expect(await readReviewGate(dir)).toMatchObject({ state: "pass", open: 0 });
    await recordReviewGate(dir, { current: true, open: 4, mustFix: 1 });
    expect(await readReviewGate(dir)).toMatchObject({ state: "open", open: 4, mustFix: 1 });
    await recordReviewGate(dir, { current: false, open: 0, mustFix: 0 });
    expect((await readReviewGate(dir)).state).toBe("stale");
    await recordReviewGate(dir, { current: true, open: 0, mustFix: 0, errors: true });
    expect((await readReviewGate(dir)).state).toBe("errors");
  });
  test("a board change after the review makes a pass stale", async () => {
    const dir = await project("board-1");
    await mkdir(join(dir, ".fabdesk/board/review"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/review/dispositions.json"), JSON.stringify({ "L8:EXPERT:-:-:pending": { state: "defer", by: "owner", reason: "Fixture owner deferral" } }));
    await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
    await writeFile(join(dir, "board.kicad_pcb"), "board-2");
    expect((await readReviewGate(dir)).state).toBe("stale");
  });
  test("the gate follows the review's one design hash: a schematic or requirements change makes a pass stale, an unrelated file does not", async () => {
    const pass = async () => {
      const dir = await project("board-1");
      await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch a)");
      await mkdir(join(dir, ".fabdesk/board/requirements"), { recursive: true });
      await writeFile(join(dir, ".fabdesk/board/requirements/requirements.json"), "{\"a\":1}");
      await mkdir(join(dir, ".fabdesk/board/review"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/review/dispositions.json"), JSON.stringify({ "L8:EXPERT:-:-:pending": { state: "defer", by: "owner", reason: "Fixture owner deferral" } }));
    await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
      expect((await readReviewGate(dir)).state).toBe("pass");
      return dir;
    };
    const sch = await pass();
    await writeFile(join(sch, "board.kicad_sch"), "(kicad_sch b)");
    expect((await readReviewGate(sch)).state).toBe("stale");
    const sheet = await pass();
    await mkdir(join(sheet, "sheets"), { recursive: true });
    await writeFile(join(sheet, "sheets", "power.kicad_sch"), "(kicad_sch power)");
    expect((await readReviewGate(sheet)).state).toBe("stale");
    const req = await pass();
    await writeFile(join(req, ".fabdesk/board/requirements/requirements.json"), "{\"a\":2}");
    expect((await readReviewGate(req)).state).toBe("stale");
    const other = await pass();
    await writeFile(join(other, "notes.txt"), "bench notes");
    await mkdir(join(other, ".fabdesk/board/accept"), { recursive: true });
    await writeFile(join(other, ".fabdesk/board/accept/index.json"), "[]");
    expect((await readReviewGate(other)).state).toBe("pass");
  });
  test("a record without a design hash (board-only, older) reads as stale", async () => {
    const dir = await project("board-1");
    await mkdir(join(dir, ".fabdesk/board"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/review-gate.json"), JSON.stringify({ state: "pass", open: 0, mustFix: 0, boardSha256: sha("board-1") }));
    expect((await readReviewGate(dir)).state).toBe("stale");
  });
});

describe("onboarding check", () => {
  const withOnboard = async (review: string[]) => {
    const dir = await project("b");
    await mkdir(join(dir, ".fabdesk/board"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/onboard.json"), JSON.stringify({ review, decided: ["46 fixed parts"], counts: { nets: 220 } }));
    return dir;
  };
  test("none before onboarding; unconfirmed guesses; confirmed; stale when onboarding is derived again", async () => {
    expect(await readOnboardingCheck(await project("b"))).toBeUndefined();
    const dir = await withOnboard(["planes: confirm the plane layers", "fixed: confirm every connector"]);
    expect(await readOnboardingCheck(dir)).toMatchObject({ confirmed: false, toConfirm: ["planes: confirm the plane layers", "fixed: confirm every connector"], decided: ["46 fixed parts"] });
    expect(await confirmOnboarding(dir, "checked planes and pairs")).toBe(true);
    expect((await readOnboardingCheck(dir))?.confirmed).toBe(true);
    await writeFile(join(dir, ".fabdesk/board/onboard.json"), JSON.stringify({ review: ["new guess"], decided: [], counts: {} }));
    expect((await readOnboardingCheck(dir))?.confirmed).toBe(false);
  });
  test("nothing to confirm without onboarding", async () => {
    expect(await confirmOnboarding(await project("b"))).toBe(false);
  });
  test("reads the record where onboarding writes it, and board_check confirm clears the warning with who and when", async () => {
    const p = await tempProject("onboard-confirm");
    await writeFile(join(p.dir, "board.kicad_pcb"), BOARD);
    await onboard(p.dir, { refresh: true, name: "t" });
    const ob = await readOnboardingCheck(p.dir);
    expect(ob?.confirmed).toBe(false);
    expect(ob!.toConfirm.length).toBeGreaterThan(0);
    expect((await releaseAdvisories(p.dir)).some((l) => l.startsWith("Onboarding:") && l.includes("board_check"))).toBe(true);
    const registry = createRegistry();
    const factory = contextFactory(mockServices([p]), p);
    const call = (args: Record<string, unknown>) => registry.invoke("board_check", args, (ref) => factory({ def: registry.get("board_check")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} } as never));
    const r = (await call({ confirm: true, by: "owner", note: "checked against the schematic" })) as { text: string; json: { confirmed: boolean; by: string } };
    expect(r.text).toContain("Onboarding confirmed by owner");
    expect(r.json).toMatchObject({ confirmed: true, by: "owner" });
    expect(await readOnboardingCheck(p.dir)).toMatchObject({ confirmed: true, by: "owner" });
    expect((await readBoardOverview(p.dir)).onboarding).toMatchObject({ confirmed: true, by: "owner" });
    expect((await releaseAdvisories(p.dir)).some((l) => l.startsWith("Onboarding:"))).toBe(false);
    // onboarding again needs a new confirmation
    await onboard(p.dir, { refresh: true, name: "t", fixed: ["R1"], now: () => new Date(0) });
    expect((await readOnboardingCheck(p.dir))?.confirmed).toBe(false);
    const fresh = await tempProject("onboard-none");
    await writeFile(join(fresh.dir, "board.kicad_pcb"), BOARD);
    const freshFactory = contextFactory(mockServices([fresh]), fresh);
    await expect(registry.invoke("board_check", { confirm: true }, (ref) => freshFactory({ def: registry.get("board_check")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} } as never))).rejects.toThrow(/nothing to confirm/);
  });
});

describe("board overview", () => {
  test("history follows the full design and custom board name, and counts skipped parity as failing", async () => {
    const dir = await project(BOARD);
    await rename(join(dir, "board.kicad_pcb"), join(dir, "panel.kicad_pcb"));
    const design = (await designHash(dir)).design;
    await mkdir(join(dir, ".fabdesk/board/accept"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/accept/index.json"), JSON.stringify([
      { at: "t", sha256: sha(BOARD), designHash: design, pcb: "panel.kicad_pcb", parityChecked: false, summary: { A1: true, A3: true } },
    ]));
    expect((await readBoardOverview(dir)).history).toEqual([{ at: "t", failing: ["A3"], pass: false, current: true }]);
    await writeFile(join(dir, "panel.kicad_sch"), "(kicad_sch changed)");
    expect((await readBoardOverview(dir)).history[0]?.current).toBe(false);
  });
  test("recent results (newest first, which one is the saved board), edit candidates, review gate, onboarding", async () => {
    const dir = await project("b", [
      { at: "2026-11-12T01:00:00Z", sha256: sha("old"), summary: { A1: true, A8: false } },
      { at: "2026-11-12T02:00:00Z", sha256: sha("b"), summary: { A1: true, A8: true } },
    ]);
    await mkdir(join(dir, ".fabdesk/board/edits/e1"), { recursive: true });
    await mkdir(join(dir, ".fabdesk/board/edits/e2"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/edits/e1/result.json"), JSON.stringify({ id: "move-d605", verdict: "PASS", started: "2026-11-12T03:00:00", total_s: 107.3, churn: { collateral_nets: 0 } }));
    await writeFile(join(dir, ".fabdesk/board/edits/e2/result.json"), JSON.stringify({ id: "swap-j3", verdict: "FAIL regress ['A1']", started: "2026-11-12T04:00:00", total_s: 40, churn: { collateral_nets: 3 } }));
    await recordReviewGate(dir, { current: true, open: 2, mustFix: 1 });
    const o = await readBoardOverview(dir);
    expect(o.history.map((h) => [h.pass, h.current])).toEqual([[true, true], [false, false]]);
    expect(o.candidates.map((c) => [c.id, c.seconds, c.collateralNets])).toEqual([["swap-j3", 40, 3], ["move-d605", 107, 0]]);
    expect(o.review).toMatchObject({ state: "open", open: 2, mustFix: 1 });
    expect(o.onboarding).toBeNull();
  });
  test("empty for a project that never used the board workflow", async () => {
    expect(await readBoardOverview(await project("b"))).toEqual({ history: [], candidates: [], review: { state: "none" }, onboarding: null });
  });
});

describe("releaseAdvisories", () => {
  test("empty without board workflow state; names what is unmeasured, failing, stale or unsettled", async () => {
    expect(await releaseAdvisories(await project("b"))).toEqual([]);
    const dir = await project("b", [{ at: "t", sha256: sha("b"), summary: { A1: true, A8: false } }]);
    await recordReviewGate(dir, { current: true, open: 3, mustFix: 1 });
    const lines = await releaseAdvisories(dir);
    expect(lines).toEqual(["A1-A9 failing A8", "Review: 3 findings open (1 must-fix)"]);
    await writeDoneMode(dir, "no-regression");
    expect((await releaseAdvisories(dir))[0]).toBe("A1-A9: no new failure; A8 failed before the work");
  });
  test("a board folder without results says nothing was measured", async () => {
    const dir = await project("b");
    await mkdir(join(dir, ".fabdesk/board"), { recursive: true });
    expect(await releaseAdvisories(dir)).toEqual(["A1-A9 not measured on this board: board_check", "Review not run: board_review run"]);
  });
});

describe("recordAcceptance", () => {
  test("a recorded measurement of the saved board reads back as current with its failing codes", async () => {
    const dir = await project("b");
    await recordAcceptance(dir, { at: "t0", sha256: sha("first"), results: [{ code: "A1", status: "pass", figures: {}, evidence: [] }, { code: "A8", status: "fail", figures: { n: 2 }, evidence: ["x"] }] });
    await recordAcceptance(dir, { at: "t1", sha256: sha("b"), results: [{ code: "A1", status: "pass", figures: {}, evidence: [] }, { code: "A8", status: "pass", figures: {}, evidence: [] }] });
    expect(await readAcceptanceState(dir)).toMatchObject({ state: "current", pass: true, baselineFailing: ["A8"], regressions: [] });
  });
});

test("stage readers agree after schematic-only and board-only changes", async () => {
  const { stageState, currentReviewHash, openReviewProject, loadCurrent, reviewBasis } = await import("@fabdesk/board-workflow");
  const dir = await mkdtemp(join(tmpdir(), "stages-agree-"));
  const pcb = join(dir, "board.kicad_pcb");
  await writeFile(pcb, "(kicad_pcb)");
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  const home = join(dir, ".fabdesk/board");
  await mkdir(join(home, "review/runs/first"), { recursive: true });
  await mkdir(join(home, "release"), { recursive: true });
  const hash = await currentReviewHash(dir);
  await writeFile(join(home, "review/latest.json"), JSON.stringify({ run: "first" }));
  await writeFile(join(home, "review/runs/first/review.json"), JSON.stringify({ hash, pcb: "board.kicad_pcb", checks: [], findings: [] }));
  await (await import("./release-package-fixture")).packageFixture(dir);
  await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
  expect((await stageState(dir)).review.state).toBe("current");
  expect((await stageState(dir)).release.state).toBe("current");
  for (const [name, text] of [["board.kicad_sch", "(kicad_sch (version 1))"], ["board.kicad_pcb", "(kicad_pcb (version 2))"]]) {
    await writeFile(join(dir, name!), text!);
    expect((await stageState(dir)).review.state).toBe("stale");
    expect((await stageState(dir)).release.state).toBe("stale");
    expect((await readReviewGate(dir)).state).toBe("stale");
    expect((await loadCurrent(await openReviewProject(dir))).state).toContain("stale");
  }
});

test("Amendment 1 separates request completion from board completion", async () => {
  const { savedStageLine, currentReviewHash } = await import("@fabdesk/board-workflow");
  const dir = await project(BOARD);
  const home = join(dir, ".fabdesk/board/accept");
  await mkdir(home, { recursive: true });
  const pcb = join(dir, "board.kicad_pcb");
  const { readFile } = await import("node:fs/promises");
  const summary = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`A${i + 1}`, true]));
  const entry = { parityChecked: true, sha256: createHash("sha256").update(await readFile(pcb)).digest("hex"), designHash: (await designHash(dir)).design, summary, figures: { A1: 3 } };
  await writeFile(join(home, "index.json"), JSON.stringify([{ ...entry, summary: { ...summary, A1: false } }]));
  let line = await savedStageLine(dir);
  expect(line).toContain("Board: 3 opens remain");
  expect(line).toContain("request scope");
  expect(line.match(/Recommended next:/g)).toHaveLength(1);
  await writeFile(join(home, "index.json"), JSON.stringify([{ ...entry, figures: { A1: 0 } }]));
  expect(await savedStageLine(dir)).toContain("Board: previews missing or stale");
  await mkdir(join(dir, "reports"), { recursive: true });
  await mkdir(join(dir, "renders"), { recursive: true });
  const outputs = ["renders/pcb.svg", "renders/board.glb", "renders/schematic.svg", "reports/drc.json", "reports/erc.json"];
  for (const path of outputs) await writeFile(join(dir, path), "published");
  await writeFile(join(dir, "reports/board-completion.json"), JSON.stringify({
    designHash: await currentReviewHash(dir), checksPass: true,
    artifacts: outputs.map(path => ({ path, sha256: createHash("sha256").update("published").digest("hex") })),
  }));
  expect(await savedStageLine(dir)).toContain("Board: complete");
  for (const invalid of [
    { ...entry, summary: { ...summary, A7: false } },
    { ...entry, parityChecked: false },
    { ...entry, parityChecked: undefined },
    { ...entry, summary: { A1: true } },
  ]) {
    await writeFile(join(home, "index.json"), JSON.stringify([invalid]));
    expect(await savedStageLine(dir)).not.toContain("Board: complete");
  }
  await writeFile(join(home, "index.json"), JSON.stringify([{ ...entry, figures: { A1: 0 } }]));
  await writeFile(join(dir, "renders/board.glb"), "changed");
  expect(await savedStageLine(dir)).not.toContain("Board: complete");
  await writeFile(pcb, BOARD + "\n");
  expect(await savedStageLine(dir)).toContain("Board: checks missing or stale");
});

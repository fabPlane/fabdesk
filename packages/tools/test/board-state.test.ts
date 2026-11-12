import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("projectHasPlacedBoard", () => {
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
    await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
    await writeFile(join(dir, "board.kicad_pcb"), "board-2");
    expect((await readReviewGate(dir)).state).toBe("stale");
  });
});

describe("onboarding check", () => {
  const withOnboard = async (review: string[]) => {
    const dir = await project("b");
    await mkdir(join(dir, ".fabdesk/board/onboard"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/onboard/onboard.json"), JSON.stringify({ review, decided: ["46 fixed parts"], counts: { nets: 220 } }));
    return dir;
  };
  test("none before onboarding; unconfirmed guesses; confirmed; stale when onboarding is derived again", async () => {
    expect(await readOnboardingCheck(await project("b"))).toBeUndefined();
    const dir = await withOnboard(["planes: confirm the plane layers", "fixed: confirm every connector"]);
    expect(await readOnboardingCheck(dir)).toMatchObject({ confirmed: false, toConfirm: ["planes: confirm the plane layers", "fixed: confirm every connector"], decided: ["46 fixed parts"] });
    expect(await confirmOnboarding(dir, "checked planes and pairs")).toBe(true);
    expect((await readOnboardingCheck(dir))?.confirmed).toBe(true);
    await writeFile(join(dir, ".fabdesk/board/onboard/onboard.json"), JSON.stringify({ review: ["new guess"], decided: [], counts: {} }));
    expect((await readOnboardingCheck(dir))?.confirmed).toBe(false);
  });
  test("nothing to confirm without onboarding", async () => {
    expect(await confirmOnboarding(await project("b"))).toBe(false);
  });
});

describe("board overview", () => {
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
    expect(await releaseAdvisories(dir)).toEqual(["A1-A9 not measured on this board: board_check", "Review not run: board_check"]);
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

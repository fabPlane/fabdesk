import { describe, expect, test } from "bun:test";
import { acceptSummary, AcceptRecord, boardChecksLabel, boardReviewLabel, BoardChecks } from "../src/board-checks";

const base: BoardChecks = { used: true, state: "current", failing: [], baselineFailing: [], regressions: [], mode: "strict" };
describe("boardChecksLabel", () => {
  test("says what is known and never approves", () => {
    expect(boardChecksLabel({ ...base, state: "none" })).toBe("A1-A9 not measured yet");
    expect(boardChecksLabel({ ...base, state: "stale" })).toBe("A1-A9 measured on an earlier board");
    expect(boardChecksLabel(base)).toBe("A1-A9 pass");
    expect(boardChecksLabel({ ...base, failing: ["A3"], regressions: ["A3"] })).toBe("A1-A9: newly failing A3");
    expect(boardChecksLabel({ ...base, failing: ["A2", "A3"], baselineFailing: ["A2", "A3"], mode: "no-regression" })).toBe("No new failure; 2 checks failed before the work (A2, A3)");
    expect(boardChecksLabel({ ...base, failing: ["A8"], baselineFailing: ["A8"] })).toBe("A1-A9 failing A8");
  });
});

describe("board overview in the schema", () => {
  test("an older answer without the new fields still parses; the review label reads each state", () => {
    expect(BoardChecks.safeParse({ used: true, state: "none", failing: [], baselineFailing: [], regressions: [], mode: "strict" }).success).toBe(true);
    expect(boardReviewLabel({ state: "pass" })).toBe("Review: every finding settled");
    expect(boardReviewLabel({ state: "open", open: 3, mustFix: 1 })).toBe("Review: 3 findings open (1 must-fix)");
    expect(boardReviewLabel({ state: "none" })).toBe("Review not run");
  });
});

describe("acceptance records", () => {
  test("summary counts pass and na as passing; the record parses with defaults", () => {
    expect(acceptSummary([{ code: "A1", status: "pass" }, { code: "A2", status: "na" }, { code: "A3", status: "fail" }, { code: "A4", status: "error" }])).toEqual({ A1: true, A2: true, A3: false, A4: false });
    const r = AcceptRecord.parse({ at: "t", sha256: "x", results: [{ code: "A3", status: "fail" }] });
    expect(r.results[0]).toEqual({ code: "A3", status: "fail", figures: {}, evidence: [] });
    expect(AcceptRecord.safeParse({ at: "t", sha256: "x", results: [{ code: "A10", status: "pass" }] }).success).toBe(false);
  });
});

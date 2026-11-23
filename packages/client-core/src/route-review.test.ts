import { expect, test } from "bun:test";
import { parseRouteReview, routeRunMatchesSource, selectOwnedRouteRun } from "./route-review";
const record = () => ({ json: { run: { id: "run_test", projectId: "project", status: "completed", startingPcbRevision: "a".repeat(64), canonicalMatchesStart: true, candidate: { available: true, reopenable: true, path: ".fabdesk/runs/run_test/candidate.kicad_pcb", sha256: "b".repeat(64) }, application: { state: "manual", reason: null }, result: { state: "partial", open: ["GND"], quality: { text: "Three opens remain.", warnings: [] as { kind: string; text: string }[] } } } } });
test("a validated partial candidate stays explicitly partial and needs separate application", () => {
  const review = parseRouteReview(record(), "project", "run_test");
  expect(review.canApply).toBe(true); expect(review.applied).toBe(false);
  expect(review.resultState).toBe("partial"); expect(review.openNets).toEqual(["GND"]);
});
test("stale, rejected, running, unvalidated and warned candidates never enable Apply", () => {
  const changes: Array<(r: ReturnType<typeof record>["json"]["run"]) => void> = [r => { r.canonicalMatchesStart = false; }, r => { r.application.state = "rejected"; }, r => { r.status = "running"; }, r => { r.candidate.reopenable = false; }, r => { r.result.quality.warnings = [{ kind: "narrowing", text: "Narrower copper" }]; }, r => { r.application.state = "applied"; }];
  for (const change of changes) {
    const value = record(); change(value.json.run); expect(parseRouteReview(value, "project", "run_test").canApply).toBe(false);
  }
});
test("another project/run or an unowned candidate path is refused", () => {
  expect(() => parseRouteReview(record(), "other", "run_test")).toThrow("another project");
  expect(() => parseRouteReview(record(), "project", "run_other")).toThrow("another project");
  const value = record(); value.json.run.candidate.path = "../candidate.kicad_pcb";
  expect(() => parseRouteReview(value, "project", "run_test")).toThrow("outside");
});
test("member history and review require the captured source and qualify its candidate file", () => {
  const board = { sourceId: "io", manifestSha256: "a".repeat(64) }, value = record();
  const member = { json: { ...value.json, _board: { projectId: "project", ...board }, run: { ...value.json.run, board, sourceDirectory: "boards/io" } } };
  expect(routeRunMatchesSource(member.json.run, "project", board)).toBe(true);
  expect(routeRunMatchesSource(member.json.run, "project")).toBe(false);
  expect(routeRunMatchesSource(member.json.run, "project", { ...board, sourceId: "lcd" })).toBe(false);
  expect(parseRouteReview(member, "project", "run_test", board).candidatePath).toBe("boards/io/.fabdesk/runs/run_test/candidate.kicad_pcb");
  expect(() => parseRouteReview(member, "project", "run_test")).toThrow("another board source");
  expect(() => parseRouteReview(member, "project", "run_test", { ...board, manifestSha256: "b".repeat(64) })).toThrow("selected board source");
});


test("run selection uses durable project/source ownership and retains a selected run outside the history page", () => {
  const a = { id: "a", projectId: "A", status: "completed" };
  const foreign = { id: "b", projectId: "B", status: "running" };
  const member = { ...a, id: "member", board: { sourceId: "io", manifestSha256: "a".repeat(64) } };
  expect(selectOwnedRouteRun([foreign, member, a], { projectId: "A" }, { currentId: "b", current: foreign, seen: null, followNew: true })).toBe("a");
  expect(selectOwnedRouteRun([foreign], { projectId: "A" }, { currentId: "a", current: a, seen: null, followNew: true })).toBe("a");
  expect(selectOwnedRouteRun([foreign], { projectId: "A" }, { currentId: "b", current: foreign, seen: null, followNew: true })).toBeNull();
  expect(selectOwnedRouteRun([member], { projectId: "A", board: { ...member.board, manifestSha256: "b".repeat(64) } }, { currentId: "member", current: member, seen: null, followNew: true })).toBeNull();
});

test("a new owned live run follows automatically while manual playback and explicit history choices stay put", () => {
  const a = { id: "a", projectId: "A", status: "completed" };
  const next = { id: "next", projectId: "A", status: "running" };
  const foreign = { id: "b", projectId: "B", status: "running" };
  const history = [foreign, next, a], selection = { currentId: "a", current: a, seen: new Set(["a"]), followNew: true };
  expect(selectOwnedRouteRun(history, { projectId: "A" }, selection)).toBe("next");
  expect(selectOwnedRouteRun([{ ...next, status: "completed" }, a], { projectId: "A" }, selection)).toBe("next");
  expect(selectOwnedRouteRun(history, { projectId: "A" }, { ...selection, followNew: false })).toBe("a");
  expect(selectOwnedRouteRun(history, { projectId: "A" }, { ...selection, seen: new Set(history.map(row => row.id)) })).toBe("a");
  expect(selectOwnedRouteRun([foreign, a], { projectId: "A" }, selection)).toBe("a");
});

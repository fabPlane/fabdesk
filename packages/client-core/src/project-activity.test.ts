import { expect, test } from "bun:test";
import type { ProjectJob } from "./project-jobs";
import { activityArtifacts, activityGroups, activityOutcome } from "./project-activity";

const job = (id: string, changes: Partial<ProjectJob> = {}): ProjectJob => ({ id, projectId: "p", kind: "bom_read", status: "done", progress: 1, note: null, result: null, error: null, startedAt: null, endedAt: null, ...changes });
const manifest = [{ name: "bom_read", annotations: { readOnlyHint: true } }, { name: "render_board", annotations: {} }];
test("groups only adjacent successful reads with identical project and board ownership", () => {
  const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
  const jobs = [job("a"), job("b"), job("c", { kind: "render_board" }), job("d"), job("e", { board }), job("f", { board }), job("g", { status: "failed" }), job("h", { result: { isError: true } }), job("i", { projectId: "other" })];
  expect(activityGroups(jobs, manifest).map(group => group.map(row => row.id))).toEqual([["a", "b"], ["c"], ["d"], ["e", "f"], ["g"], ["h"], ["i"]]);
  expect(activityGroups([job("a"), job("b")], [])).toHaveLength(2);
});
test("reports measured findings without implying a design passed or is current", () => {
  expect(activityOutcome(job("j", { kind: "verify_erc", result: { json: { counts: { errors: 0, warnings: 0 } } } }))).toBe("Saved report: 0 errors · 0 warnings. Review coverage and freshness in Checks.");
  expect(activityOutcome(job("j", { kind: "verify_erc", result: { json: { counts: { errors: -1, warnings: 0 } } } }))).toBe("Run finished. Review its recorded result.");
  expect(activityOutcome(job("j", { result: { json: { lines: [{}, {}], complete: false } } }))).toBe("2 BOM lines read · incomplete source coverage");
  expect(activityOutcome(job("j", { result: { isError: true } }))).toContain("reported concerns");
});
test("opens exact existing outputs without borrowing foreign paths or packaged ZIP entries", () => {
  const files = [{ path: "exports/video.mp4" }, { path: "renders/top.png" }, { path: "exports/fab.zip" }];
  const value = job("j", { result: { json: { path: "/projects/p/exports/fab.zip", files: { mp4: "/projects/p/exports/video.mp4", poster: "renders/top.png", foreign: "/projects/p-other/renders/top.png", unsafe: "../renders/top.png" } } } });
  expect(activityArtifacts(value, "p", "/projects/p", files)).toEqual(["exports/fab.zip", "exports/video.mp4", "renders/top.png"]);
  expect(activityArtifacts(value, "other", "/projects/p", files)).toEqual([]);
  expect(activityArtifacts({ ...value, result: { json: { _board: { projectId: "other" }, path: "renders/top.png" } } }, "p", "/projects/p", files)).toEqual([]);
  expect(activityArtifacts({ ...value, result: { json: { files: ["gerbers/front.gbr", "renders/top.png"] } } }, "p", "/projects/p", files)).toEqual(["renders/top.png"]);
  expect(activityArtifacts({ ...value, result: { json: { modelPath: "renders/top.png" } } }, "p", "/projects/p", files)).toEqual(["renders/top.png"]);
});

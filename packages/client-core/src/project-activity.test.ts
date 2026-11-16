import { expect, test } from "bun:test";
import type { ProjectJob } from "./project-jobs";
import { activityArtifacts, activityGroups, activityNeedsAttention, activityOutcome } from "./project-activity";

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

test("keeps failed tasks and recorded concerns discoverable without flagging every finished run", () => {
  for (const value of [job("failed", { status: "failed" }), job("error", { result: { isError: true } }), job("incomplete", { result: { json: { complete: false } } }), job("checks", { kind: "verify_drc", result: { json: { counts: { errors: 0, warnings: 3 } } } })]) {
    expect(activityNeedsAttention(value)).toBe(true);
    expect(activityGroups([value, { ...value, id: "next" }], manifest)).toHaveLength(2);
  }
  for (const value of [job("unknown"), job("cancelled", { status: "cancelled" }), job("running", { status: "running", result: { isError: true } }), job("clean", { kind: "verify_erc", result: { json: { counts: { errors: 0, warnings: 0 } } } }), job("invalid", { kind: "verify_erc", result: { json: { counts: { errors: "2", warnings: -1 } } } })]) {
    expect(activityNeedsAttention(value)).toBe(false);
  }
});

test("a reported tool error takes precedence over a partial zero-error report or BOM", () => {
  for (const kind of ["verify_erc", "bom_read"]) {
    expect(activityOutcome(job("partial", { kind, result: { isError: true, json: { counts: { errors: 0, warnings: 0 }, lines: [] } } }))).toContain("reported concerns");
  }
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

test("Windows absolute outputs resolve within the current project without accepting sibling or traversal paths", () => {
  const files = [{ path: "exports/fab.zip" }, { path: "renders/top.png" }];
  const value = job("windows", { result: { json: { path: "C:\\Projects\\Pulse\\exports\\fab.zip", files: [
    "c:/projects/pulse/renders/top.png", "C:\\Projects\\Pulse-other\\renders\\top.png",
    "D:\\Projects\\Pulse\\renders\\top.png", "C:\\Projects\\Pulse\\..\\renders\\top.png",
    "C:\\Projects\\Pulse\\exports\\missing.zip", "exports\\fab.zip",
  ] } } });
  expect(activityArtifacts(value, "p", "C:\\Projects\\Pulse", files)).toEqual(["exports/fab.zip", "renders/top.png"]);
  expect(activityArtifacts(value, "p", "C:/Projects/Pulse/", files)).toEqual(["exports/fab.zip", "renders/top.png"]);
  expect(activityArtifacts(value, "p", "/projects/p", files)).toEqual([]);
});

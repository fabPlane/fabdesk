import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblyReviewRows } from "./assembly-review";
const source = { id: "io", name: "I/O source", location: "project", directory: "boards/io" };
const fixture = () => ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), editing: "explicit-source-tools", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io" }, { id: "right", name: "Right", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available", previewPath: "boards/io/renders/pcb.svg" }] });
test("source review deduplicates shared boards and captures explicit ownership without electrical claims", () => {
  const rows = assemblyReviewRows(fixture(), new Map([["io", { data: "matches-source", isFetching: false, isError: false }]]));
  expect(rows).toHaveLength(1); expect(rows[0]!.instances).toHaveLength(2);
  expect(rows[0]!.status).toBe("Preview matches saved PCB"); expect(rows[0]!.warning).toBe(false);
  expect(rows[0]!.board).toEqual({ sourceId: "io", manifestSha256: "a".repeat(64) });
  expect(rows[0]!.selection).toMatchObject({ projectId: "p", instanceId: "left", sourceId: "io" });
});
test("changed/missing previews warn, fetching and errors never present an old match as current", () => {
  for (const data of ["source-changed", "artifact-changed", "missing-source", "missing-artifact"] as const) expect(assemblyReviewRows(fixture(), new Map([["io", { data, isFetching: false, isError: false }]]))[0]!.warning).toBe(true);
  for (const flags of [{ isFetching: true, isError: false }, { isFetching: false, isError: true }]) expect(assemblyReviewRows(fixture(), new Map([["io", { data: "matches-source", ...flags }]]))[0]!.status).not.toBe("Preview matches saved PCB");
});
test("unavailable sources cannot refresh or inspect even when a preview claims a match", () => {
  const data = fixture(); data.sources[0]!.status = "blocked"; data.sources[0]!.reason = "Directory unavailable";
  const row = assemblyReviewRows(data, new Map([["io", { data: "matches-source", isFetching: false, isError: false }]]))[0]!;
  expect(row.warning).toBe(true); expect(row.note).toBe("Directory unavailable"); expect(row.board).toBeNull(); expect(row.selection).toBeNull();
  data.sources[0]!.status = "available"; data.manifestSha256 = null;
  expect(assemblyReviewRows(data, new Map())[0]!.board).toBeNull();
  data.mode = "single"; expect(assemblyReviewRows(data, new Map())).toEqual([]);
});

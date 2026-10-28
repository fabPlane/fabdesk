import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { LiveAssemblyPreviewQueue } from "./live-assembly-previews";
function fixture() {
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  const data = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), editing: "explicit-source-tools", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io" }, { id: "right", name: "Right", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available", pcbSha256: "b".repeat(64), previewPath: "boards/io/renders/pcb.svg" }] });
  const stale = [{ sourceId: "io", data: "source-changed" as const, isFetching: false, isError: false }];
  return { data, stale, queue: new LiveAssemblyPreviewQueue() };
}
test("initial stale previews stay explicit; live saves coalesce by source and capture one owner", () => {
  const { data, stale, queue } = fixture(); queue.observe(data, stale);
  expect(queue.next(stale)).toBeNull();
  data.sources[0]!.pcbSha256 = "c".repeat(64); queue.observe(data, stale);
  data.sources[0]!.pcbSha256 = "d".repeat(64); queue.observe(data, stale);
  const next = queue.next(stale)!; expect(next.sourceSha256).toBe("d".repeat(64)); expect(next.selection.sourceId).toBe("io"); expect(next.selection.projectId).toBe("p");
  expect(queue.next(stale)).toBeNull(); // Failed render cannot create an automatic retry loop.
  queue.observe(data, stale); expect(queue.next(stale)).toBeNull();
});
test("pending reads wait, while current/manual/unverified outputs are never overwritten", () => {
  for (const state of ["matches-source", "artifact-changed", "untracked", "missing-artifact"] as const) {
    const { data, stale, queue } = fixture(); queue.observe(data, stale); data.sources[0]!.pcbSha256 = "c".repeat(64);
    const fetching = [{ ...stale[0]!, isFetching: true }]; queue.observe(data, fetching); expect(queue.next(fetching)).toBeNull();
    const verified = [{ ...stale[0]!, data: state }]; queue.observe(data, verified); expect(queue.next(stale)).toBeNull();
  }
  const { data, stale, queue } = fixture(); queue.observe(data, stale); data.sources[0]!.pcbSha256 = "c".repeat(64);
  const fetching = [{ ...stale[0]!, isFetching: true }]; queue.observe(data, fetching); expect(queue.next(fetching)).toBeNull();
  queue.observe(data, stale); expect(queue.next(stale)?.sourceSha256).toBe("c".repeat(64));
});
test("membership/project changes reset observation, and unavailable sources cannot inherit a pending update", () => {
  for (const change of ["manifest", "project", "unavailable"] as const) {
    const { data, stale, queue } = fixture(); queue.observe(data, stale); data.sources[0]!.pcbSha256 = "c".repeat(64); queue.observe(data, stale);
    if (change === "manifest") data.manifestSha256 = "d".repeat(64); else if (change === "project") data.projectId = "other"; else data.sources[0]!.status = "blocked";
    queue.observe(data, stale); expect(queue.next(stale)).toBeNull();
  }
});

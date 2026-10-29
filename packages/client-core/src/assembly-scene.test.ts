import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySourceSelection, nextAssemblyReviewSelection, restoreAssemblySelection, assemblyLinkShape, assemblyScene, assemblySourcesToReview, captureAssemblySelection, assemblySelectionState, inspectAssemblyBoard } from "./assembly-scene";
const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
const data = () => ProjectBoardSources.parse({ projectId: "project", mode: "assembly", manifestSha256: "a".repeat(64), editing: "single-board-only", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left I/O", sourceId: "io", presentation: { units: "canvas-px", x: -100, y: -40 } }, { id: "right", name: "Right I/O", sourceId: "io", presentation: { units: "canvas-px", x: 360, y: 240 } }], connections: [{ id: "link", name: "Declared link", a: { instanceId: "left", connector: "J1" }, b: { instanceId: "right", connector: "J1" } }] }, sources: [{ source, status: "available", pcbPath: "boards/io/board.kicad_pcb", previewPath: "boards/io/renders/pcb.svg" }] });
test("scene membership uses physical instances without duplicating source ownership or converting canvas positions to millimetres", () => {
  const scene = assemblyScene(data());
  expect(scene.nodes.map(node => node.instance.id)).toEqual(["left", "right"]);
  expect(scene.nodes[0]!.source!).toBe(scene.nodes[1]!.source!);
  expect(scene.nodes[0]?.x).toBe(-100); expect(scene.nodes[0]?.y).toBe(-40);
  expect(scene.bounds.x).toBeLessThan(-100); expect(scene.bounds.width).toBeGreaterThan(460);
  expect(scene.links[0]?.a.instance.id).toBe("left"); expect(scene.links[0]?.b.instance.id).toBe("right");
});
test("captured selections go stale on membership or project changes and never retarget a familiar instance", () => {
  const snapshot = data(), selection = captureAssemblySelection(snapshot, "left")!;
  expect(assemblySelectionState(snapshot, selection)).toBe("owned");
  expect(assemblySelectionState({ ...snapshot, manifestSha256: "b".repeat(64) }, selection)).toBe("stale");
  expect(assemblySelectionState({ ...snapshot, projectId: "other" }, selection)).toBe("stale");
  expect(assemblySelectionState(snapshot, { ...selection, sourceId: "different" })).toBe("stale");
  snapshot.sources[0]!.status = "missing";
  expect(assemblySelectionState(snapshot, selection)).toBe("unavailable");
  expect(captureAssemblySelection(snapshot, "unknown")).toBeNull();
});
test("readable map cards retain saved coordinates and link ports follow their actual bounds", () => {
  const snapshot = data(), original = JSON.stringify(snapshot);
  const scene = assemblyScene(snapshot, { left: { sourceId: "io", units: "canvas-px", x: -180, y: 15 } });
  const a = scene.nodes[0]!, b = scene.nodes[1]!;
  expect([a.x, a.y, b.x, b.y]).toEqual([-180, 15, 360, 240]);
  for (const node of scene.nodes) {
    expect(node.width).toBeGreaterThanOrEqual(260);
    expect(scene.bounds.x).toBeLessThan(node.x);
    expect(scene.bounds.y).toBeLessThan(node.y);
    expect(scene.bounds.x + scene.bounds.width).toBeGreaterThan(node.x + node.width);
    expect(scene.bounds.y + scene.bounds.height).toBeGreaterThan(node.y + node.height);
  }
  const forward = assemblyLinkShape(a, b), reverse = assemblyLinkShape(b, a);
  expect(forward.start.x).toBeGreaterThan(a.x + a.width);
  expect(forward.end.x).toBeLessThan(b.x);
  expect(reverse.start).toEqual(forward.end);
  expect(reverse.end).toEqual(forward.start);
  const below = { ...b, x: a.x, y: a.y + 400 };
  const vertical = assemblyLinkShape(a, below);
  expect(vertical.start.y).toBeGreaterThan(a.y + a.height);
  expect(vertical.end.y).toBeLessThan(below.y);
  expect(JSON.stringify(snapshot)).toBe(original);
});
test("source attention includes unresolved ownership and changed previews, but never counts shared instances or unknown checks as passes", () => {
  const snapshot = data();
  expect(assemblySourcesToReview(snapshot, new Map([["io", "source-changed"]]))).toEqual(["io"]);
  expect(assemblySourcesToReview(snapshot, new Map([["io", "untracked"]]))).toEqual([]);
  snapshot.sources[0]!.status = "unresolved";
  expect(assemblySourcesToReview(snapshot, new Map([["io", "matches-source"]]))).toEqual(["io"]);
  snapshot.sources[0]!.status = "blocked";
  expect(assemblySourcesToReview(snapshot, new Map())).toEqual(["io"]);
});
const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
function native() { return { contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" }, _board: { projectId: "project", ...board }, revision: "b".repeat(64), coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" }, results: { components: { total: 201, returned: 1, truncated: true, rows: [{ ref: "R1", value: "1k", footprint: "R_0402", x: 105, y: 100, rotation: 0, locked: false, flipped: false }] }, board_geometry: { total: 1, returned: 1, truncated: false, rows: [{ id: "outline", owner: "board", kind: "rectangle", layer: 47, locked: false, toolOwnedOutline: false, start: { x: 100, y: 95 }, end: { x: 115, y: 105 } }] } } }; }
test("native summaries retain explicit scope, total versus shown counts, source SHA and verified rectangular bounds", async () => {
  const payload = native();
  const result = await inspectAssemblyBoard({ callTool: async () => ({ result: { ok: true, text: "", json: payload } }) }, "project", board);
  expect(result.partCount).toBe(201); expect(result.parts).toHaveLength(1); expect(result.truncated).toBe(true);
  expect(result.sourceSha256).toBe("b".repeat(64)); expect(result.outlineBounds).toEqual({ minX: 100, minY: 95, maxX: 115, maxY: 105 });
});
test("legacy or mismatched native responses cannot become facts for a selected member", async () => {
  for (const identity of [undefined, { ...board, projectId: "wrong" }, { ...board, projectId: "project", sourceId: "wrong" }, { ...board, projectId: "project", manifestSha256: "c".repeat(64) }]) {
    const payload = { ...native(), _board: identity };
    await expect(inspectAssemblyBoard({ callTool: async () => ({ result: { ok: true, text: "", json: payload } }) }, "project", board)).rejects.toThrow("does not belong");
  }
});
test("partial native geometry never supplies a misleading outline bound", async () => {
  const payload = native(); payload.results.board_geometry.truncated = true;
  const result = await inspectAssemblyBoard({ callTool: async () => ({ result: { ok: true, text: "", json: payload } }) }, "project", board);
  expect(result.outlineBounds).toBeNull();
});

test("restored board workspaces validate persisted ownership without silently selecting a replacement", () => {
  const snapshot = data(), saved = captureAssemblySelection(snapshot, "right")!;
  expect(restoreAssemblySelection(snapshot, JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  for (const invalid of [null, [], "right", {}, { ...saved, manifestSha256: "bad" }, { ...saved, instanceId: "missing" }, { ...saved, sourceId: "other" }, { ...saved, projectId: "other" }, { ...saved, manifestSha256: "b".repeat(64) }]) expect(restoreAssemblySelection(snapshot, invalid)).toBeNull();
  snapshot.sources[0]!.status = "missing";
  expect(restoreAssemblySelection(snapshot, saved)).toBeNull();
});

function reviewData() {
  const snapshot = data();
  const missing = { id: "missing", name: "Missing source", location: "unresolved" as const, provenance: { path: "missing.kicad_pcb" } };
  snapshot.assembly!.sources.push(missing);
  snapshot.assembly!.instances.push({ id: "missing-board", sourceId: "missing", name: "Missing board" });
  snapshot.sources.push({ source: missing, status: "unresolved" });
  return snapshot;
}
test("source review cycles distinct designs rather than repeating the first warning or shared instances", () => {
  const snapshot = reviewData(), attention = ["missing", "io", "io", "undeclared"];
  const first = nextAssemblyReviewSelection(snapshot, attention, null)!;
  expect(first.instanceId).toBe("left");
  const next = nextAssemblyReviewSelection(snapshot, attention, captureAssemblySelection(snapshot, "right"))!;
  expect(next.instanceId).toBe("missing-board");
  expect(assemblySelectionState(snapshot, next)).toBe("unavailable");
  expect(nextAssemblyReviewSelection(snapshot, attention, next)).toEqual(first);
  expect(attention).toEqual(["missing", "io", "io", "undeclared"]);
});
test("source review follows the current declaration after stale selection or attention changes", () => {
  const snapshot = reviewData(), missing = captureAssemblySelection(snapshot, "missing-board")!;
  for (const stale of [{ ...missing, projectId: "other" }, { ...missing, manifestSha256: "b".repeat(64) }, { ...missing, instanceId: "removed" }]) {
    expect(nextAssemblyReviewSelection(snapshot, ["io", "missing"], stale)?.instanceId).toBe("left");
  }
  expect(nextAssemblyReviewSelection(snapshot, ["missing"], captureAssemblySelection(snapshot, "left"))).toEqual(missing);
  expect(nextAssemblyReviewSelection(snapshot, ["io"], captureAssemblySelection(snapshot, "right"))?.instanceId).toBe("left");
});
test("source review never invents instances or crosses a missing assembly declaration", () => {
  const snapshot = reviewData();
  expect(nextAssemblyReviewSelection(snapshot, [], null)).toBeNull();
  expect(nextAssemblyReviewSelection(snapshot, ["not-declared"], null)).toBeNull();
  expect(nextAssemblyReviewSelection({ ...snapshot, mode: "single", assembly: null }, ["io"], null)).toBeNull();
  expect(nextAssemblyReviewSelection({ ...snapshot, manifestSha256: null }, ["io"], null)).toBeNull();
});

test("source-task navigation preserves the chosen shared instance and rejects stale or unavailable ownership", () => {
  const snapshot = data(), right = captureAssemblySelection(snapshot, "right")!;
  expect(captureAssemblySourceSelection(snapshot, "io", right)).toEqual(right);
  expect(captureAssemblySourceSelection(snapshot, "io", { ...right, projectId: "other" })?.instanceId).toBe("left");
  const changed = { ...snapshot, manifestSha256: "b".repeat(64) };
  expect(captureAssemblySourceSelection(changed, "io", right)).toMatchObject({ instanceId: "left", manifestSha256: changed.manifestSha256 });
  expect(captureAssemblySourceSelection(snapshot, "unknown", right)).toBeNull();
  const unavailable = { ...snapshot, sources: snapshot.sources.map(row => ({ ...row, status: "blocked" as const })) };
  expect(captureAssemblySourceSelection(unavailable, "io", right)).toBeNull();
  expect(captureAssemblySourceSelection({ ...snapshot, mode: "single", assembly: null }, "io", right)).toBeNull();
});

test("choosing another source captures its instance instead of keeping the old source", () => {
  const snapshot = data(), aux = { id: "aux", name: "Aux", location: "project", directory: "boards/aux" };
  const extended = ProjectBoardSources.parse({ ...snapshot,
    assembly: { ...snapshot.assembly, sources: [...snapshot.assembly!.sources, aux], instances: [...snapshot.assembly!.instances, { id: "aux-main", name: "Aux main", sourceId: "aux" }] },
    sources: [...snapshot.sources, { source: aux, status: "available", pcbPath: "boards/aux/board.kicad_pcb" }],
  });
  expect(captureAssemblySourceSelection(extended, "aux", captureAssemblySelection(extended, "right"))).toMatchObject({ instanceId: "aux-main", sourceId: "aux", projectId: snapshot.projectId });
});

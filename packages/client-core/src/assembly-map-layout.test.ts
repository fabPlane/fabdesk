import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblyMapLayoutKey, parseAssemblyMapPosition, restoreAssemblyMapLayout } from "./assembly-map-layout";
import { assemblyScene, assemblyLinkShape } from "./assembly-scene";
function fixture() {
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  return ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), editing: "explicit-source-tools", observedAt: "2026-10-29T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io", presentation: { units: "canvas-px", x: 20, y: 40 } }, { id: "right", name: "Right", sourceId: "io" }], connections: [{ id: "cable", name: "Cable", a: { instanceId: "left", connector: "J1" }, b: { instanceId: "right", connector: "J2" } }] }, sources: [{ source, status: "available", pcbSha256: "b".repeat(64) }] });
}
test("map positions move one physical instance and its logical connection without modifying engineering sources", () => {
  const data = fixture(), before = JSON.stringify(data), original = assemblyScene(data);
  const layout = { right: { units: "canvas-px" as const, sourceId: "io", x: 640, y: -120 } };
  const scene = assemblyScene(data, layout);
  expect(scene.nodes[0]!.x).toBe(20); expect(scene.nodes[0]!.y).toBe(40);
  expect(scene.nodes[1]!.x).toBe(640); expect(scene.nodes[1]!.y).toBe(-120);
  expect(scene.nodes[1]!.source!).toBe(original.nodes[1]!.source!);
  expect(assemblyLinkShape(scene.links[0]!.a, scene.links[0]!.b)).not.toEqual(assemblyLinkShape(original.links[0]!.a, original.links[0]!.b));
  expect(scene.bounds.width).toBeGreaterThan(original.bounds.width);
  expect(JSON.stringify(data)).toBe(before);
  expect(restoreAssemblyMapLayout(data, layout).get("right")).not.toBe(layout.right);
});
test("restored map layouts reject nonfinite, out-of-bounds, inherited or unrelated instance/source positions", () => {
  const data = fixture();
  for (const x of [NaN, Infinity, -Infinity, 1e6 + 1, -1e6 - 1, "20", null]) {
    expect(restoreAssemblyMapLayout(data, { right: { units: "canvas-px" as const, sourceId: "io", x, y: 0 } }).size).toBe(0);
  }
  expect(parseAssemblyMapPosition({ units: "canvas-px" as const, sourceId: "io", x: 1, y: Infinity })).toBeNull();
  expect(parseAssemblyMapPosition({ units: "mm", sourceId: "io", x: 1, y: 2 })).toBeNull();
  expect(parseAssemblyMapPosition({ sourceId: "io", x: 1, y: 2 })).toBeNull();
  expect(restoreAssemblyMapLayout(data, { right: { units: "canvas-px" as const, sourceId: "other", x: 1, y: 2 }, undeclared: { units: "canvas-px" as const, sourceId: "io", x: 3, y: 4 } }).size).toBe(0);
  expect(restoreAssemblyMapLayout(data, Object.create({ right: { units: "canvas-px" as const, sourceId: "io", x: 3, y: 4 } })).size).toBe(0);
  for (const saved of [null, [], 12, "bad"]) expect(restoreAssemblyMapLayout(data, saved).size).toBe(0);
  expect(assemblyScene(data, { right: { units: "canvas-px" as const, sourceId: "wrong", x: 0, y: 0 } }).nodes).toEqual(assemblyScene(data).nodes);
});
test("view arrangement survives source refreshes but cannot retarget a reused instance to another source", () => {
  const data = fixture(), layout = { right: { units: "canvas-px" as const, sourceId: "io", x: -50, y: 90 } };
  data.sources[0]!.pcbSha256 = "c".repeat(64); data.manifestSha256 = "d".repeat(64);
  expect(restoreAssemblyMapLayout(data, layout).get("right")).toEqual(layout.right);
  const different = { id: "different", name: "Different board", location: "project" as const, directory: "boards/different" };
  data.assembly!.sources.push(different); data.sources.push({ source: different, status: "missing" });
  data.assembly!.instances[1]!.sourceId = different.id;
  expect(restoreAssemblyMapLayout(data, layout).size).toBe(0);
  expect(restoreAssemblyMapLayout({ ...data, mode: "single", assembly: null }, layout).size).toBe(0);
});
test("map storage is scoped to both endpoint and project, not ambiguous joined names", () => {
  expect(assemblyMapLayoutKey("http://local", "p")).not.toBe(assemblyMapLayoutKey("http://remote", "p"));
  expect(assemblyMapLayoutKey("http://local", "p")).not.toBe(assemblyMapLayoutKey("http://local", "other"));
  expect(JSON.parse(assemblyMapLayoutKey("http://local/a:b", "p:c"))).toEqual(["http://local/a:b", "p:c"]);
});

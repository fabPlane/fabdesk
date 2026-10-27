import { expect, test } from "bun:test";
import { AssemblyRelativePath, BoardSourceSelection, ProjectAssembly } from "./assembly";
const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
const instance = { id: "io-1", sourceId: "io", name: "I/O main" };
const base = { contract: "fabplane.assembly.v1", sources: [source], instances: [instance], connections: [] };

test("one editable source can supply repeated physical instances with presentation-only positions", () => {
  const value = ProjectAssembly.parse({ ...base, instances: [instance, { ...instance, id: "io-2", presentation: { units: "canvas-px", x: 340, y: 50 } }] });
  expect(value.sources).toHaveLength(1); expect(value.instances).toHaveLength(2);
});
test("source, instance and connection identities cannot collide or point at undeclared ownership", () => {
  for (const change of [{ sources: [source, source] }, { instances: [instance, instance] }, { instances: [{ ...instance, sourceId: "missing" }] }, { connections: [{ id: "link", name: "Link", a: { instanceId: "io-1", connector: "J1" }, b: { instanceId: "missing", connector: "J2" } }] }]) expect(ProjectAssembly.safeParse({ ...base, ...change }).success).toBe(false);
  expect(ProjectAssembly.safeParse({ ...base, sources: [source, { ...source, id: "alias" }] }).success).toBe(false);
});
test("portable directories reject path traversal, absolute paths, Windows aliases and empty segments", () => {
  for (const path of ["../outside", "/absolute", "C:/board", "boards\\io", "boards//io", "boards/./io", "boards/io/..", "board\0bad"]) expect(AssemblyRelativePath.safeParse(path).success).toBe(false);
  expect(ProjectAssembly.safeParse({ ...base, sources: [{ ...source, directory: "." }] }).success).toBe(true);
});
test("unresolved provenance is retained without claiming that sources, geometry or compatibility were verified", () => {
  const unresolved = { id: "lcd", name: "LCD R2.6", location: "unresolved" as const, provenance: { repository: "https://github.com/example/lcd", ref: "revision", path: "variants/lcd.kicad_pcb", sha256: "a".repeat(64) } };
  expect(ProjectAssembly.parse({ ...base, sources: [unresolved], instances: [{ ...instance, sourceId: "lcd" }] }).sources[0]).toEqual(unresolved);
  expect(ProjectAssembly.safeParse({ ...base, sources: [{ ...source, status: "PASS" }] }).success).toBe(false);
  expect(ProjectAssembly.safeParse({ ...base, instances: [{ ...instance, presentation: { units: "mm", x: 1, y: 2 } }] }).success).toBe(false);
});
test("connections use physical instance endpoints and do not acquire a status from imported viewer labels", () => {
  const link = { id: "cable", name: "Cable", a: { instanceId: "io-1", connector: "J1" }, b: { instanceId: "io-2", connector: "J2" } };
  const value = { ...base, instances: [instance, { ...instance, id: "io-2" }], connections: [link] };
  expect(ProjectAssembly.safeParse(value).success).toBe(true);
  expect(ProjectAssembly.safeParse({ ...value, connections: [{ ...link, status: "PASS" }] }).success).toBe(false);
  expect(ProjectAssembly.safeParse({ ...value, connections: [{ ...link, b: link.a }] }).success).toBe(false);
});

test("board selectors require a declared source identity and an exact lowercase manifest SHA", () => {
  expect(BoardSourceSelection.safeParse({ sourceId: "io", manifestSha256: "a".repeat(64) }).success).toBe(true);
  for (const value of [{ sourceId: "../io", manifestSha256: "a".repeat(64) }, { sourceId: "io", manifestSha256: "main" }, { sourceId: "io", manifestSha256: "A".repeat(64) }, { sourceId: "io", manifestSha256: "a".repeat(64), directory: "../outside" }]) expect(BoardSourceSelection.safeParse(value).success).toBe(false);
});

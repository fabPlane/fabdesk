import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { QueryClient } from "@tanstack/react-query";
import { ProjectBoardSources, type SchematicFocus } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { schematicFocusFilesMatch, schematicFocusFromResult, schematicFocusChoicesFromResult, schematicFocusScope, schematicFocusHierarchyMatches } from "./schematic-focus";
import { handleCoreEvent } from "./events";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const focus: SchematicFocus = { id: crypto.randomUUID(), projectId: "p", reference: "U1", value: "MCU", requestedAt: Date.now(), sourcePath: "board.kicad_sch", sourceSha256: hash("native"), svgPath: ".fabdesk/canvas-focus/a.svg", svgSha256: hash("drawing"), points: [{ x: 10, y: 20, unit: 1 }], page: { width: 170, height: 660 } };
test("navigation requires both exact source and exact preview bytes", async () => {
  expect(await schematicFocusFilesMatch(focus, "native", "drawing")).toBe(true);
  expect(await schematicFocusFilesMatch(focus, "changed native", "drawing")).toBe(false);
  expect(await schematicFocusFilesMatch(focus, "native", "changed drawing")).toBe(false);
});
test("member focus requires the current declaration and confines every file to its declared source", () => {
  const sources = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), observedAt: new Date().toISOString(), editing: "explicit-source-tools", assembly: { contract: "fabplane.assembly.v1", sources: [{ id: "io", name: "I/O", location: "project", directory: "boards/io" }], instances: [{ id: "main-io", sourceId: "io", name: "I/O main" }], connections: [] }, sources: [{ source: { id: "io", name: "I/O", location: "project", directory: "boards/io" }, status: "available", schematicPath: "boards/io/board.kicad_sch" }] });
  const member: SchematicFocus = { ...focus, board: { sourceId: "io", manifestSha256: sources.manifestSha256! }, sourcePath: "boards/io/child.kicad_sch", svgPath: "boards/io/.fabdesk/canvas-focus/a.svg", sheet: { identity: "child", hierarchyPath: "/Child/", pageNumber: 2 }, sourceFiles: [{ path: "boards/io/child.kicad_sch", sha256: focus.sourceSha256 }] };
  expect(schematicFocusScope(member, sources)?.board?.instanceId).toBe("main-io");
  for (const changed of [{ ...member, projectId: "other" }, { ...member, sourcePath: "board.kicad_sch" }, { ...member, svgPath: "boards/other/focus.svg" }, { ...member, board: { sourceId: "io", manifestSha256: "b".repeat(64) } }, { ...member, sourceFiles: [{ path: "board.kicad_pro", sha256: focus.sourceSha256 }] }]) expect(schematicFocusScope(changed, sources)).toBeNull();
  expect(schematicFocusScope(focus, sources)).toBeNull();
  expect(schematicFocusScope(member, { ...sources, sources: sources.sources.map(row => ({ ...row, status: "missing" })) })).toBeNull();
});
test("hierarchy verification invalidates focus when any referenced sheet or metadata changes", async () => {
  const request = { ...focus, sourceFiles: [{ path: "board.kicad_sch", sha256: hash("native") }, { path: "child.kicad_sch", sha256: hash("child") }, { path: "board.kicad_pro", sha256: hash("metadata") }] };
  const files: Record<string, string> = { "board.kicad_sch": "native", "child.kicad_sch": "child", "board.kicad_pro": "metadata" };
  expect(await schematicFocusHierarchyMatches(request, async path => files[path]!)).toBe(true);
  files["child.kicad_sch"] = "edited";
  expect(await schematicFocusHierarchyMatches(request, async path => files[path]!)).toBe(false);
  await expect(schematicFocusHierarchyMatches(request, async () => { throw new Error("missing"); })).rejects.toThrow("missing");
});
test("live focus events reach an optional client sink without depending on chat message history", () => {
  const received: SchematicFocus[] = [], qc = new QueryClient(), client = {} as CoreClient;
  handleCoreEvent({ topic: "project.schematic_focus", ts: Date.now(), focus }, { qc, client, onSchematicFocus: f => received.push(f) });
  expect(received).toEqual([focus]);
  expect(() => handleCoreEvent({ topic: "project.schematic_focus", ts: Date.now(), focus }, { qc, client })).not.toThrow();
});

test("component navigation can be reopened explicitly from recognized successful result envelopes", () => {
  for (const output of [{ focus }, { json: { focus } }, { structuredContent: { focus } }, { structured_content: { focus } }, { result: { structuredContent: { focus } } }]) expect(schematicFocusFromResult(output)?.reference).toBe("U1");
  expect(schematicFocusFromResult({ isError: true, structuredContent: { focus } })).toBeNull();
  expect(schematicFocusFromResult({ content: [{ type: "text", text: JSON.stringify({ focus }) }] })).toBeNull();
  expect(schematicFocusFromResult({ focus: { ...focus, sourcePath: "some-other-source" } })).toBeNull();
});
test("ambiguous native choices require structured source data and never come from prose or failed tools", () => {
  const focusChoices = { projectId: "p", reference: "U2", expectedHierarchyRevision: "a".repeat(64), sheets: [{ identity: "root/left", hierarchyPath: "/Left/", sourcePath: "child.kicad_sch" }, { identity: "root/right", hierarchyPath: "/Right/", sourcePath: "child.kicad_sch" }] };
  expect(schematicFocusChoicesFromResult({ json: { focusChoices } })?.sheets).toHaveLength(2);
  expect(schematicFocusChoicesFromResult({ isError: true, json: { focusChoices } })).toBeNull();
  expect(schematicFocusChoicesFromResult({ text: JSON.stringify({ focusChoices }) })).toBeNull();
  expect(schematicFocusChoicesFromResult({ focusChoices: { ...focusChoices, expectedHierarchyRevision: "unknown" } })).toBeNull();
});

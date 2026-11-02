import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { QueryClient } from "@tanstack/react-query";
import type { SchematicFocus } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { schematicFocusFilesMatch, schematicFocusFromResult } from "./schematic-focus";
import { handleCoreEvent } from "./events";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const focus: SchematicFocus = { id: crypto.randomUUID(), projectId: "p", reference: "U1", value: "MCU", requestedAt: Date.now(), sourcePath: "board.kicad_sch", sourceSha256: hash("native"), svgPath: ".fabdesk/canvas-focus/a.svg", svgSha256: hash("drawing"), points: [{ x: 10, y: 20, unit: 1 }], page: { width: 170, height: 660 } };
test("navigation requires both exact source and exact preview bytes", async () => {
  expect(await schematicFocusFilesMatch(focus, "native", "drawing")).toBe(true);
  expect(await schematicFocusFilesMatch(focus, "changed native", "drawing")).toBe(false);
  expect(await schematicFocusFilesMatch(focus, "native", "changed drawing")).toBe(false);
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

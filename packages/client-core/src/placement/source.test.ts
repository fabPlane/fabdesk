import { expect, test } from "bun:test";
import { decodePlacementDraft, encodePlacementDraft, placementSourceDraftPath, placementSourceKey, placementSourceTarget } from "./source";
import { readPlacement } from "./index";
import { readFileSync } from "node:fs";
const session = readPlacement(readFileSync(new URL("./fixtures/usb-timer.kicad_pcb", import.meta.url), "utf8"), "timer");
const source = { projectId: "project", path: "board.kicad_pcb", sha256: "a".repeat(64) };
test("only the exact project, board and revision can automatically restore a placement draft", () => {
  const text = encodePlacementDraft(source, session);
  expect(JSON.parse(decodePlacementDraft(text, source)).parts).toEqual(session.parts);
  for (const changed of [{ ...source, projectId: "another" }, { ...source, path: "boards/io/board.kicad_pcb" }, { ...source, sha256: "b".repeat(64) }]) {
    expect(() => decodePlacementDraft(text, changed)).toThrow("another board or source revision");
    expect(placementSourceKey("core", changed)).not.toBe(placementSourceKey("core", source));
  }
  expect(() => decodePlacementDraft(JSON.stringify(session), source)).toThrow();
  expect(() => decodePlacementDraft("{", source)).toThrow();
});
test("device recovery and memory cache are isolated by core endpoint as well as source", () => {
  expect(placementSourceKey("http://core/", source)).toBe(placementSourceKey("http://core", source));
  expect(placementSourceKey("http://other", source)).not.toBe(placementSourceKey("http://core", source));
});

import { ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySelection } from "../assembly-scene";
test("placement requires explicit available assembly ownership and never guesses a member", () => {
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  const data = ProjectBoardSources.parse({ projectId: "project", mode: "assembly", manifestSha256: "a".repeat(64), editing: "explicit-source-tools", observedAt: "2026-11-04T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "I/O", sourceId: "io", presentation: { units: "canvas-px", x: 0, y: 0 } }], connections: [] }, sources: [{ source, status: "available", pcbPath: "boards/io/board.kicad_pcb" }] });
  const selection = captureAssemblySelection(data, "left")!;
  expect(placementSourceTarget(data, null)).toBeNull();
  expect(placementSourceTarget(data, selection)).toEqual({ path: "boards/io/board.kicad_pcb", sourceId: "io" });
  expect(placementSourceTarget({ ...data, manifestSha256: "b".repeat(64) }, selection)).toBeNull();
  expect(placementSourceTarget({ ...data, projectId: "other" }, selection)).toBeNull();
  for (const status of ["missing", "blocked", "unresolved"] as const) {
    expect(placementSourceTarget({ ...data, sources: [{ ...data.sources[0]!, status }] }, selection)).toBeNull();
  }
});

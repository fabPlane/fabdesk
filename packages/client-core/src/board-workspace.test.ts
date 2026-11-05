import { expect, test } from "bun:test";
import type { BoardPartSummary, BoardTimelineEntry } from "@fabdesk/protocol";
import { BOARD_WORKSPACE_PATHS } from "./board-workspace-keys";
import { changeDescription, defaultTimelineIndex, highlightBoardDrawing, hitTestBoardPart, partLinkPeer, sameEndpoint, sharedNetLabel, sortedBoardParts, timelineEntryLabel, timelinePair } from "./board-workspace";

const part = (ref: string, minX: number, minY: number, maxX: number, maxY: number): BoardPartSummary => ({ ref, x: (minX + maxX) / 2, y: (minY + maxY) / 2, bounds: { minX, minY, maxX, maxY }, nets: [] });
const entry = (ref: string, total: number | null): BoardTimelineEntry => ({ ref, kind: "git", title: ref, sha256: ref, parts: 1, size: null, ...(total === null ? {} : { changes: { added: total, removed: 0, moved: 0, changed: 0, renamed: 0, unchanged: 1 } }) });

test("hit testing picks the part under the point, and the smallest when stacked", () => {
  const parts = [part("LARGE", 0, 0, 20, 20), part("SMALL", 5, 5, 6, 6)];
  expect(hitTestBoardPart(parts, { x: 5.5, y: 5.5 })?.ref).toBe("SMALL");
  expect(hitTestBoardPart(parts, { x: 15, y: 15 })?.ref).toBe("LARGE");
});

test("hit testing reaches a nearby small part and ignores empty board", () => {
  const parts = [part("R1", 10, 10, 11, 11)];
  expect(hitTestBoardPart(parts, { x: 11.5, y: 10.5 })?.ref).toBe("R1");
  expect(hitTestBoardPart(parts, { x: 30, y: 30 })).toBeNull();
});

test("highlighting marks selected parts and zooms without losing the drawing", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g data-ref="J1"></g></svg>';
  expect(highlightBoardDrawing(svg, {})).toBe(svg);
  const out = highlightBoardDrawing(svg, { refs: ["J1"], focus: { minX: 10, minY: 10, maxX: 12, maxY: 12 } });
  expect(out).toContain('.bp-part[data-ref="J1"]');
  expect(out).toContain('<g data-ref="J1"></g>');
  expect(out).toContain('viewBox="3 5 16 12"');
});

test("highlighting cannot break out of its stylesheet through a reference", () => {
  const out = highlightBoardDrawing('<svg viewBox="0 0 1 1"></svg>', { refs: ['A"]]></style><script>'] });
  expect(out.match(/<\/style>/g)).toHaveLength(1);
  expect(out).toContain('A\\"');
});

test("a change filter fades other parts", () => {
  const out = highlightBoardDrawing('<svg viewBox="0 0 1 1"></svg>', { roles: ["added"] });
  expect(out).toContain(".bp-part{opacity:.3}");
  expect(out).toContain('.bp-part[data-role="added"]{opacity:1}');
});

test("a timeline selection compares an entry with the one before it", () => {
  const entries = [entry("a", null), entry("b", 2), entry("c", 0)];
  expect(timelinePair(entries, 1)).toEqual({ from: entries[0]!, to: entries[1]! });
  expect(timelinePair(entries, 0)).toBeNull();
  expect(timelinePair(entries, 9)).toBeNull();
});

test("the timeline opens on the newest revision that changed parts", () => {
  expect(defaultTimelineIndex([entry("a", null), entry("b", 2), entry("c", 0)])).toBe(1);
  expect(defaultTimelineIndex([entry("a", null), entry("b", 0)])).toBe(1);
  expect(defaultTimelineIndex([entry("a", null)])).toBe(0);
  expect(defaultTimelineIndex([])).toBe(-1);
});

test("export bundles get a short label", () => {
  expect(timelineEntryLabel({ kind: "export", title: "mechanical-3638418e9a1f-80ce01cd" })).toBe("Export 3638418e");
  expect(timelineEntryLabel({ kind: "export", title: "hardware/io/io.kicad_pcb" })).toBe("io");
  expect(timelineEntryLabel({ kind: "git", title: "Fix USB" })).toBe("Fix USB");
});

test("a part's link peer is found from either end", () => {
  const a = { boardPath: "a.kicad_pcb", ref: "J1" }, b = { boardPath: "b.kicad_pcb", ref: "J2" };
  const links = [{ a, b }];
  expect(partLinkPeer(links, a)?.peer).toEqual(b);
  expect(partLinkPeer(links, b)?.peer).toEqual(a);
  expect(partLinkPeer(links, { boardPath: "a.kicad_pcb", ref: "J9" })).toBeNull();
  // The same reference on another board is a different part.
  expect(partLinkPeer(links, { boardPath: "c.kicad_pcb", ref: "J1" })).toBeNull();
  expect(sameEndpoint(a, null)).toBe(false);
});

test("connectors sort first, then in natural reference order", () => {
  expect(sortedBoardParts([{ ref: "R10" }, { ref: "R2" }, { ref: "J10" }, { ref: "J2" }]).map((p) => p.ref)).toEqual(["J2", "J10", "R2", "R10"]);
});

test("copy for shared nets and changes", () => {
  expect([0, 1, 2].map(sharedNetLabel)).toEqual(["No shared net names", "1 shared net name", "2 shared net names"]);
  expect(changeDescription({ kind: "moved", reasons: ["moved", "rotated"], distance: 5 })).toBe("Moved 5 mm · rotated");
  expect(changeDescription({ kind: "renamed", fromRef: "C1", toRef: "C2", reasons: ["reference"] })).toBe("Was C1");
  expect(changeDescription({ kind: "added", toRef: "C2", reasons: [] })).toBe("Only on the newer revision");
});

test("board files and link files refresh these views; unrelated files do not", () => {
  for (const path of ["hardware/io/io.kicad_pcb", "fabplane.connections.json", "fabplane.assembly.json", "cad/enclosure-design.json"]) expect(BOARD_WORKSPACE_PATHS.test(path)).toBe(true);
  for (const path of ["NOTES.md", "renders/pcb.svg", "my-fabplane.connections.json"]) expect(BOARD_WORKSPACE_PATHS.test(path)).toBe(false);
});

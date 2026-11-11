import { expect, test } from "bun:test";
import type { BoardPartSummary, BoardTimelineEntry } from "@fabdesk/protocol";
import { BOARD_WORKSPACE_PATHS } from "./board-workspace-keys";
import { boardPickerLabel, canEditLinkPins, changeDescription, connectionCandidates, defaultTimelineIndex, highlightBoardDrawing, hitTestBoardPad, hitTestBoardPart, linkPinMap, pairLinkLines, pairPinLines, partLinkPeer, partPins, pinCheckLabel, pinPairsForLink, rankConnectionTargets, sameEndpoint, sharedNetLabel, sortedBoardParts, suggestPinMap, timelineEntryLabel, timelineIndexForCard, timelinePair, timelineStep } from "./board-workspace";

const part = (ref: string, minX: number, minY: number, maxX: number, maxY: number): BoardPartSummary => ({ ref, x: (minX + maxX) / 2, y: (minY + maxY) / 2, bounds: { minX, minY, maxX, maxY }, nets: [], connector: false, pads: [] });
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

const pad = (pin: string, x: number, net?: string) => ({ pin, ...(net ? { net } : {}), bounds: { minX: x, minY: 0, maxX: x + 1, maxY: 1 } });

test("stepping moves through the timeline and stops at both ends", () => {
  const entries = [entry("a", null), entry("b", 1), entry("c", 1), entry("d", 1)];
  expect(timelineStep(entries, 2, -1)).toBe(1);
  expect(timelineStep(entries, 2, 1)).toBe(3);
  expect(timelineStep(entries, 1, -1)).toBeNull();
  expect(timelineStep(entries, 3, 1)).toBeNull();
});

test("every card can be selected, and the oldest opens the first step", () => {
  const entries = [entry("a", null), entry("b", 1), entry("c", 1)];
  expect(timelineIndexForCard(entries, 0)).toBe(1);
  expect(timelineIndexForCard(entries, 1)).toBe(1);
  expect(timelineIndexForCard(entries, 2)).toBe(2);
  expect(timelineIndexForCard([entry("a", null)], 0)).toBe(0);
});

test("selecting a part highlights it without moving the camera", () => {
  const svg = '<svg viewBox="0 0 100 80"><g data-ref="J1"></g></svg>';
  const out = highlightBoardDrawing(svg, { refs: ["J1"], mappedPins: ["1"], activePin: "2" });
  expect(out).toContain('viewBox="0 0 100 80"');
  expect(out).toContain('.bp-part[data-ref="J1"] .bp-pad[data-pin="1"]{fill:#16a34a}');
  expect(out).toContain('.bp-part[data-ref="J1"] .bp-pad[data-pin="2"]{fill:#ea580c');
  expect(out).toContain('.bp-part[data-ref="J1"] .bp-pin{display:inline}');
});

test("pad hit testing finds the exact pin, then the nearest within reach", () => {
  const part = { ...hitPart(), pads: [pad("1", 0), pad("2", 3)] };
  expect(hitTestBoardPad(part, { x: 0.5, y: 0.5 })).toBe("1");
  expect(hitTestBoardPad(part, { x: 3.5, y: 0.5 })).toBe("2");
  expect(hitTestBoardPad(part, { x: 4.2, y: 0.5 })).toBe("2");
  expect(hitTestBoardPad(part, { x: 2, y: 0.5 })).toBeNull();
});

function hitPart() { return part("J1", 0, 0, 5, 1); }

test("a repeated pin number is one row, in natural order", () => {
  expect(partPins({ pads: [pad("10", 0), pad("2", 1, "A"), pad("2", 2, "A"), pad("1", 3)] }).map((row) => row.pin)).toEqual(["1", "2", "10"]);
  expect(partPins(null)).toEqual([]);
});

test("a suggested pin map only joins named nets", () => {
  const source = { pads: [pad("1", 0, "SDA"), pad("2", 1, "Net-(J1-Pad2)"), pad("3", 2)] };
  const target = { pads: [pad("7", 0, "SDA"), pad("8", 1, "Net-(J1-Pad2)")] };
  expect(suggestPinMap(source, target)).toEqual({ "1": "7" });
  expect(suggestPinMap(source, null)).toEqual({});
});

test("a repeated net gets one target pin each, not all the first match", () => {
  const gnd = (...pins: string[]) => ({ pads: pins.map((pin, index) => pad(pin, index, "GND")) });
  // Same pin numbers line up one to one.
  expect(suggestPinMap(gnd("1", "2", "3", "4"), gnd("1", "2", "3", "4"))).toEqual({ "1": "1", "2": "2", "3": "3", "4": "4" });
  // Different numbers take the remaining pins in order.
  expect(suggestPinMap(gnd("1", "2"), gnd("7", "9"))).toEqual({ "1": "7", "2": "9" });
  // A same-numbered pin is not taken by an earlier pin on the way.
  expect(suggestPinMap(gnd("1", "2"), gnd("2", "5"))).toEqual({ "2": "2", "1": "5" });
  // More source pins than target pins leaves the extras unmapped.
  expect(suggestPinMap(gnd("1", "2", "3"), gnd("4"))).toEqual({ "1": "4" });
});

test("a same-numbered pin on another net is not a match", () => {
  const source = { pads: [pad("1", 0, "SDA"), pad("2", 1, "SCL")] };
  const target = { pads: [pad("1", 0, "SCL"), pad("2", 1, "SDA")] };
  expect(suggestPinMap(source, target)).toEqual({ "1": "2", "2": "1" });
});

test("suggestions match nets across hierarchical sheets, as the pin check does", () => {
  expect(suggestPinMap({ pads: [pad("1", 0, "/power/SDA")] }, { pads: [pad("7", 0, "SDA")] })).toEqual({ "1": "7" });
});

test("a pin map reads and saves correctly from either end of a link", () => {
  const a = { boardPath: "a.kicad_pcb", ref: "J1" }, b = { boardPath: "b.kicad_pcb", ref: "J2" };
  const link = { a, pins: [{ a: "1", b: "7" }] };
  expect(linkPinMap(link, a)).toEqual({ "1": "7" });
  expect(linkPinMap(link, b)).toEqual({ "7": "1" });
  expect(linkPinMap({ a, pins: undefined }, a)).toEqual({});
  expect(pinPairsForLink({ "1": "7", "2": "" }, true)).toEqual([{ a: "1", b: "7" }]);
  expect(pinPairsForLink({ "7": "1" }, false)).toEqual([{ a: "1", b: "7" }]);
});

test("likely targets come first: shared named nets, then connectors", () => {
  const rows = [{ ref: "R1", nets: [] }, { ref: "J9", nets: [] }, { ref: "U1", nets: ["SDA"] }, { ref: "C1", nets: ["Net-(X)"] }];
  expect(rankConnectionTargets({ nets: ["SDA", "Net-(X)"] }, rows).map((row) => row.ref)).toEqual(["U1", "J9", "C1", "R1"]);
});

test("lines join a link's two parts whichever way round the boards are shown", () => {
  const link = { id: "l1", a: { boardPath: "a", ref: "J1" }, b: { boardPath: "b", ref: "J2" }, state: "current" as const };
  const a = [part("J1", 0, 0, 2, 2)], b = [part("J2", 10, 10, 12, 12)];
  expect(pairLinkLines([link], "a", "b", a, b, "l1")[0]).toMatchObject({ tone: "linked", selected: true, left: { x: 1, y: 1 }, right: { x: 11, y: 11 } });
  expect(pairLinkLines([link], "b", "a", b, a)[0]).toMatchObject({ left: { x: 11, y: 11 }, right: { x: 1, y: 1 } });
  expect(pairLinkLines([{ ...link, state: "needs-review" }], "a", "b", a, b)[0]?.tone).toBe("review");
  // Only links with an end on each board shown get a line.
  expect(pairLinkLines([link], "a", "c", a, b)).toEqual([]);
  expect(pairLinkLines([link], "a", "b", a, [])).toEqual([]);
});

test("pin lines take their colour from the pin check and follow the source side", () => {
  const source = { ...part("J1", 0, 0, 4, 2), pads: [pad("1", 0)] }, target = { ...part("J2", 10, 10, 14, 12), pads: [pad("7", 10)] };
  const check = { rows: [{ a: "1", b: "7", kind: "conflict" as const, aNet: "/sheet/GND" }, { a: "1", b: "missing", kind: "match" as const }] };
  const lines = pairPinLines(check, true, source, target);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ tone: "conflict", label: "GND", left: { x: 0.5 }, right: { x: 10.5 } });
  expect(pairPinLines(check, false, source, target)[0]).toMatchObject({ left: { x: 10.5 }, right: { x: 0.5 } });
  expect(pairPinLines(check, true, source, null)).toEqual([]);
});

test("likely targets are parts sharing named nets, most first", () => {
  const candidates = connectionCandidates({ nets: ["SDA", "SCL", "Net-(X)"] }, [{ ref: "A", nets: ["SDA"] }, { ref: "B", nets: ["SDA", "SCL"] }, { ref: "C", nets: ["Net-(X)"] }, { ref: "D", nets: [] }]);
  expect([...candidates]).toEqual([["B", 2], ["A", 1]]);
  expect(connectionCandidates(null, [{ ref: "A", nets: ["SDA"] }]).size).toBe(0);
  // A shared ground alone would mark nearly every part on the board.
  expect(connectionCandidates({ nets: ["GND", "+3V3"] }, [{ ref: "A", nets: ["GND", "+3V3"] }]).size).toBe(0);
});

test("likely targets match nets across hierarchical sheets, counting each shared name once", () => {
  const source = { nets: ["/Sensors/SDA", "/Sensors/SCL", "GND"] };
  const parts = [{ ref: "J9", nets: ["SDA", "SCL", "GND"] }, { ref: "U1", nets: ["/Other/SDA", "/Another/SDA"] }, { ref: "C1", nets: ["GND"] }];
  expect([...connectionCandidates(source, parts)]).toEqual([["J9", 2], ["U1", 1]]);
  expect(rankConnectionTargets(source, parts).map((row) => row.ref)).toEqual(["J9", "U1", "C1"]);
});

test("the pin check reads as a plain sentence and never claims verification", () => {
  expect(pinCheckLabel({ status: "none", rows: [], unmapped: [] })).toBe("No pins stated yet");
  expect(pinCheckLabel({ status: "agree", rows: [{ a: "1", b: "2", kind: "match" }], unmapped: [] })).toBe("All 1 pins agree by net name");
  expect(pinCheckLabel({ status: "conflict", rows: [{ a: "1", b: "2", kind: "conflict" }, { a: "2", b: "3", kind: "differs" }], unmapped: ["4"] })).toBe("1 power conflict, 1 with different names, 1 named pin not mapped");
});

test("many-to-one maps cannot be silently edited from their lossy direction", () => {
  const a = { boardPath: "a.kicad_pcb", ref: "J1" }, b = { boardPath: "b.kicad_pcb", ref: "J2" };
  const link = { a, b, pins: [{ a: "1", b: "1" }, { a: "2", b: "1" }] };
  expect(canEditLinkPins(link, a)).toBe(true);
  expect(canEditLinkPins(link, b)).toBe(false);
  expect(canEditLinkPins({ a, pins: [] }, b)).toBe(true);
});


test("duplicate board names are distinguished by their paths", () => {
  const boards = [{ name: "board", path: "controller/board.kicad_pcb" }, { name: "board", path: "sensor/board.kicad_pcb" }, { name: "power", path: "power.kicad_pcb" }];
  expect(boardPickerLabel(boards[0]!, boards)).toBe("board · controller/board.kicad_pcb");
  expect(boardPickerLabel(boards[1]!, boards)).toBe("board · sensor/board.kicad_pcb");
  expect(boardPickerLabel(boards[2]!, boards)).toBe("power");
});

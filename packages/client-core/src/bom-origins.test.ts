import { expect, test } from "bun:test";
import type { BomSourceCoverage, ProjectBomSnapshot } from "@fabdesk/protocol";
import { bomOrigins } from "./bom-origins";

const source = (overrides: Partial<BomSourceCoverage> = {}): BomSourceCoverage => ({ sourceId: null, name: "Main board", directory: ".", multiplier: 1, instanceIds: [], componentCount: 6, status: "native-schematic", ...overrides });
const snapshot = (coverage: BomSourceCoverage[]): ProjectBomSnapshot => ({ contract: "fabplane.project-bom.v1", projectId: "p", manifestSha256: null, revision: "r", capturedAt: "2026-11-05T00:00:00Z", coverage, complete: true, inputs: [], absentInputs: [], notes: [], lines: [
  { source: "pcb", kind: "pcb", refs: ["R1", "R2"], name: "Resistors", qty: 2 },
  ...["J1", "SW1", "D1", "R3"].map(ref => ({ source: "pcb" as const, kind: "pcb" as const, refs: [ref], name: ref, qty: 1 })),
] });

test("explains five grouped BOM lines as six on-board parts without conflating boards and designs", () => {
  expect(bomOrigins(snapshot([source()]))).toEqual({ boards: 1, designs: 1, readDesigns: 1, attention: 0, mountedParts: 6, hardwareParts: 0, lines: 5 });
});
test("shared designs count physical boards while hardware quantity is counted only once", () => {
  const value = snapshot([source({ sourceId: "io", multiplier: 2 }), source({ sourceId: "unused", multiplier: 0, status: "unused" })]);
  value.lines = value.lines.map(line => ({ ...line, qty: line.qty * 2 }));
  value.lines.push({ source: "offboard", kind: "fastener", refs: ["H1"], name: "Screws", qty: 8 });
  expect(bomOrigins(value)).toEqual({ boards: 2, designs: 1, readDesigns: 1, attention: 0, mountedParts: 12, hardwareParts: 8, lines: 6 });
});
test("a read netlist still needs attention and unavailable sources are not represented as read", () => {
  const value = snapshot([source({ status: "saved-netlist" }), source({ sourceId: "missing", status: "unavailable", componentCount: 0 })]);
  expect(bomOrigins(value)).toMatchObject({ designs: 2, readDesigns: 1, attention: 2, boards: 2 });
});

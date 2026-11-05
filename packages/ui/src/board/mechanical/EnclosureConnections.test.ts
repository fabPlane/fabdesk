import { expect, test } from "bun:test";
import { defaultEnclosureDesign, type EnclosureBoardSummary } from "@fabdesk/client-core";
import { enclosureConnectionError } from "./EnclosureConnections";

const features: EnclosureBoardSummary = {
  pcbRevision: "one",
  thicknessMm: 1.6,
  outline: { minX: 0, minY: 0, maxX: 20, maxY: 10, widthMm: 20, heightMm: 10 },
  holes: [],
  connectors: [{ ref: "J1", x: 0, y: 0, edge: "minX", widthMm: 5, heightMm: 2 }],
};
const design = defaultEnclosureDesign(null);
design.boards = ["a.kicad_pcb", "b.kicad_pcb"].map((path) => ({
  path,
  x: 0,
  y: 0,
  z: 5,
  rotation: 0,
}));
const boards = design.boards.map((placement) => ({ placement, features }));
const from = { boardPath: "a.kicad_pcb", ref: "J1" },
  to = { boardPath: "b.kicad_pcb", ref: "J1" };
test("connections require distinct, selected, readable ports and valid physical lengths", () => {
  expect(enclosureConnectionError(design, boards, from, to, 100, 10)).toBeNull();
  expect(enclosureConnectionError(design, boards, from, from, 100, 10)).toContain("different");
  expect(
    enclosureConnectionError(design, boards, from, { ...to, ref: "missing" }, 100, 10),
  ).toContain("unavailable");
  expect(
    enclosureConnectionError({ ...design, boards: [design.boards[0]!] }, boards, from, to, 100, 10),
  ).toContain("unavailable");
  expect(enclosureConnectionError(design, boards, from, to, NaN, 10)).toContain("length");
  expect(enclosureConnectionError(design, boards, from, to, 100, 100)).toContain("Extra room");
});
test("the same cable cannot be added twice with its endpoints reversed", () => {
  const linked = { ...design, connections: [{ id: "c", from, to, length: 100, slack: 10 }] };
  expect(enclosureConnectionError(linked, boards, from, to, 100, 10)).toContain(
    "already connected",
  );
  expect(enclosureConnectionError(linked, boards, to, from, 100, 10)).toContain(
    "already connected",
  );
  expect(linked.connections).toHaveLength(1);
});

test("incomplete cable guides explain the exact missing endpoint instead of silently disabling Add", () => {
  const empty = { boardPath: "", ref: "" };
  expect(enclosureConnectionError(design, boards, empty, empty, 100, 10)).toContain(
    "board and connector",
  );
  expect(enclosureConnectionError(design, boards, empty, to, 100, 10)).toContain("From board");
  expect(enclosureConnectionError(design, boards, from, empty, 100, 10)).toContain("To board");
  expect(
    enclosureConnectionError(design, boards, { ...from, ref: "" }, { ...to, ref: "" }, 100, 10),
  ).toContain("both Port menus");
  expect(enclosureConnectionError(design, boards, { ...from, ref: "" }, to, 100, 10)).toContain(
    "From port",
  );
  expect(enclosureConnectionError(design, boards, from, { ...to, ref: "" }, 100, 10)).toContain(
    "To port",
  );
  expect(enclosureConnectionError(design, boards, from, to, 100, 10)).toBeNull();
});

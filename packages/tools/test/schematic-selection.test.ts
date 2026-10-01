import { expect, test } from "bun:test";
import { selectSchematic, type SchematicSelection } from "../src/tools/schematic-selection";
import type { NativeSchematicSnapshot } from "../src/services";

const symbol = (ref: string, x: number) => ({
  id: ref,
  reference: ref,
  value: "1k",
  footprint: "",
  libId: "Device:R",
  position: { x, y: 10 },
  rotation: 0,
  mirrorX: false,
  mirrorY: false,
  pins: [
    { id: `${ref}:1`, number: "1", name: "", net: "/A", position: { x, y: 5 } },
    { id: `${ref}:2`, number: "2", name: "", net: "/B", position: { x, y: 15 } },
  ],
});
const snapshot: NativeSchematicSnapshot = {
  revision: 3,
  pcbRevision: 1,
  symbols: [symbol("R1", 10), symbol("R2", 20), symbol("R3", 40)],
  wires: [
    { id: "wa", start: { x: 10, y: 5 }, end: { x: 20, y: 5 } },
    { id: "wb", start: { x: 10, y: 15 }, end: { x: 20, y: 15 } },
    { id: "cross", start: { x: 15, y: 0 }, end: { x: 15, y: 10 } },
  ],
  localLabels: [{ id: "la", text: "A", position: { x: 15, y: 5 } }],
  globalLabels: [],
  junctions: [{ id: "ja", position: { x: 12, y: 5 } }],
  noConnects: [],
  texts: [{ id: "note", text: "unrelated", position: { x: 50, y: 50 } }],
  nets: [
    { name: "/A", itemCount: 5, itemIds: ["R1:1", "R2:1", "wa", "la", "ja"] },
    { name: "/B", itemCount: 3, itemIds: ["R1:2", "R2:2", "wb"] },
  ],
  erc: { errors: 0, warnings: 0 },
};
const options = (more: Partial<SchematicSelection> = {}): SchematicSelection => ({
  references: [],
  netNames: [],
  objectIds: [],
  kinds: ["symbols", "pins", "wires", "labels", "junctions", "texts", "noConnects"],
  expand: "none",
  limit: 1000,
  ...more,
});
test("selectors compose as union; kind filter follows expansion", () => {
  const result = selectSchematic(snapshot, options({ references: ["R1"], objectIds: ["note"] }));
  expect(result.symbols.map((s) => s.reference)).toEqual(["R1"]);
  expect(result.texts.map((t) => t.id)).toEqual(["note"]);
  expect(result.wires).toHaveLength(0);
  const expanded = selectSchematic(
    snapshot,
    options({ references: ["R1"], expand: "nets", kinds: ["wires", "junctions"] }),
  );
  expect(expanded.wires.map((w) => w.id)).toEqual(["wa", "wb"]);
  expect(expanded.junctions[0]?.position).toEqual({ x: 12, y: 5 });
});
test("net selection includes physical geometry but does not fan out through other pins", () => {
  const result = selectSchematic(snapshot, options({ netNames: ["/A"] }));
  expect(result.wires.map((w) => w.id)).toEqual(["wa"]);
  expect(result.symbols.every((s) => s.pins.every((p) => p.number === "1"))).toBe(true);
  expect(result.localLabels.map((l) => l.id)).toEqual(["la"]);
  expect(result.junctions.map((j) => j.id)).toEqual(["ja"]);
});
test("interior crossing without anchor does not create a connection", () => {
  const result = selectSchematic({ ...snapshot, localLabels: [] }, options({ netNames: ["/A"] }));
  expect(result.wires.map((w) => w.id)).toEqual(["wa"]);
});
test("bounded results explicitly count omitted pins and unrelated objects", () => {
  const result = selectSchematic(snapshot, options({ limit: 2 }));
  expect(result.selection.returned).toBe(2);
  expect(result.selection.truncated).toBe(true);
  expect(result.selection.matched).toBe(15);
});
test("unknown selectors fail specifically", () => {
  expect(() => selectSchematic(snapshot, options({ references: ["missing"] }))).toThrow(
    "references: unknown component missing",
  );
  expect(() => selectSchematic(snapshot, options({ objectIds: ["missing"] }))).toThrow(
    "objectIds: unknown object missing",
  );
  expect(() => selectSchematic(snapshot, options({ netNames: ["missing"] }))).toThrow(
    "netNames: unknown net missing",
  );
});

test("authoritative net selection cannot absorb crossing/T-connected wires or same-text labels on other nets", () => {
  const other = {
    ...snapshot,
    wires: [...snapshot.wires, { id: "tee", start: { x: 15, y: 5 }, end: { x: 15, y: 20 } }],
    globalLabels: [{ id: "global-A", text: "A", position: { x: 15, y: 5 } }],
    localLabels: [...snapshot.localLabels, { id: "child-A", text: "A", position: { x: 10, y: 5 } }],
    nets: [
      ...snapshot.nets,
      { name: "A", itemCount: 2, itemIds: ["tee", "global-A"] },
      { name: "/child/A", itemCount: 1, itemIds: ["child-A"] },
    ],
  };
  const selected = selectSchematic(other, options({ netNames: ["/A"], expand: "nets" }));
  expect(selected.wires.map((w) => w.id)).toEqual(["wa"]);
  expect(selected.globalLabels).toHaveLength(0);
  expect(selected.localLabels.map((l) => l.id)).toEqual(["la"]);
});

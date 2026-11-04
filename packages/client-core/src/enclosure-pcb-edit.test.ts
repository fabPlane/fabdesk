import { expect, test } from "bun:test";
import { defaultEnclosureDesign } from "./enclosure-design";
import { planEnclosurePcbEdit } from "./enclosure-pcb-edit";

function design() {
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.boards = [{ path: "board.kicad_pcb", x: 10, y: -5, z: 5, rotation: 90 }];
  return d;
}
test("rotated enclosure placement does not block edits in native PCB coordinates", () => {
  const d = design();
  expect(planEnclosurePcbEdit(d, { kind: "component", reference: "J1", x: 12, y: 8 })).toEqual({
    footprints: [{ reference: "J1", position: { x: 12, y: 8 } }],
  });
  expect(planEnclosurePcbEdit(d, { kind: "hole", x: 4, y: 6, diameter: 3 })).toEqual({
    holes: [{ x: 4, y: 6, diameter: 3 }],
  });
  expect(() => planEnclosurePcbEdit(d, { kind: "outline" })).toThrow(/rotation/);
});
test("rectangular sizing accounts for placement offset and clearance, refusing an empty interior", () => {
  const d = design();
  d.boards[0]!.rotation = 0;
  d.space = { ...d.space, x: 20, y: 30, width: 40, depth: 24, clearance: 2 };
  expect(planEnclosurePcbEdit(d, { kind: "outline" })).toEqual({
    outline: [
      { x: 12, y: 37 },
      { x: 48, y: 37 },
      { x: 48, y: 57 },
      { x: 12, y: 57 },
    ],
  });
  d.space.width = 4;
  expect(() => planEnclosurePcbEdit(d, { kind: "outline" })).toThrow(/twice/);
});
test("unconfirmed dimensions, missing boards and invalid hole sizes are refused before dispatch", () => {
  const d = design();
  for (const diameter of [0, 0.49, 20.1, NaN])
    expect(() => planEnclosurePcbEdit(d, { kind: "hole", x: 0, y: 0, diameter })).toThrow(
      /diameter/,
    );
  d.confirmed = false;
  expect(() => planEnclosurePcbEdit(d, { kind: "component", reference: "J1", x: 1, y: 2 })).toThrow(
    /Confirm/,
  );
  d.confirmed = true;
  d.boards = [];
  expect(() => planEnclosurePcbEdit(d, { kind: "outline" })).toThrow(/Add/);
});

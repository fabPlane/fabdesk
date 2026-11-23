import { describe, expect, test } from "bun:test";
import { blockInventory, blockLines } from "../src/layout/blocks";
import { placementCheck, placementLines, pyFloorDiv, pyMod } from "../src/layout/placement";
import { pose, setPose } from "../src/layout/text";

const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, o: { rot?: number; sheet?: string; crt?: boolean; side?: "F" | "B"; locked?: boolean } = {}) => `
	(footprint "Lib:${ref}"
		${o.locked ? "(locked yes)" : ""}
		(layer "${o.side ?? "F"}.Cu")
		(at ${x} ${y} ${o.rot ?? 0})
		(property "Reference" "${ref}" (at 0 0))
		(property "Value" "V${ref}" (at 0 0))
		${o.sheet ? `(sheetfile "${o.sheet}.kicad_sch")` : ""}
		${o.crt === false ? "" : `(fp_rect (start -1 -1) (end 1 1) (layer "${o.side ?? "F"}.CrtYd"))`}
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py} ${o.rot ?? 0}) (size 0.6 0.6) (layers "F.Cu") (net "${net}"))`).join("\n")}
	)`;

// U1's eight signal pads face away (+x) from the four resistors it connects to (at -x): turning it 180 degrees fixes that
const u1Pads: Array<[string, string, number, number]> = Array.from({ length: 8 }, (_, i) => [String(i + 1), `S${i}`, 3, (i - 3.5) * 0.1]);
const BOARD = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	${fp("U1", 20, 15, u1Pads, { sheet: "mcu" })}
	${Array.from({ length: 4 }, (_, k) => fp(`R${k + 1}`, 8, 9 + 4 * k, [["1", `S${2 * k}`, 0, -0.5], ["2", `S${2 * k + 1}`, 0, 0.5]], { sheet: "mcu" })).join("")}
	${fp("J1", 2, 2, [["1", "GND", 0, 0], ["2", "VIN", 1, 0]], { sheet: "power", locked: true })}
	${fp("C1", 30, 5, [["1", "GND", 0, 0], ["2", "VIN", 1, 0]], { sheet: "power", crt: false })}
)`;

describe("placementCheck (placement_check.py)", () => {
  const r = placementCheck(BOARD, { ground: "GND", fixed: /^J/, outline: [0, 0, 40, 30] });

  test("HPWL per net and total, ground left out", () => {
    // S0..S7: each net joins a U1 pad at x=23 to a resistor pad at x=8: 15 mm plus the y offset
    expect(r.nets).toBe(9); // S0..S7 and VIN (GND skipped)
    expect(r.hpwl_total_mm).toBeGreaterThan(8 * 15);
  });

  test("flags a part whose best turn saves >= 15 %", () => {
    const u1 = r.rotation.all.find((x) => x.ref === "U1")!;
    expect(u1.best_turn_deg).toBe(180);
    expect(u1.flag).toBe(true);
    expect(r.rotation.flagged.map((x) => x.ref)).toEqual(["U1"]);
    // fewer than 8 pads: not a candidate
    expect(r.rotation.checked).toBe(1);
  });

  test("per block, by the block holding most of a net's pads", () => {
    const b = placementCheck(BOARD, { ground: "GND", blocks: { core: { parts: ["U1"] }, res: { parts: ["R1", "R2", "R3", "R4"] }, pwr: { parts: ["J1", "C1"] } } });
    expect(Object.keys(b.hpwl_by_block_mm!)).toEqual(["core", "pwr"]); // one U1 pad, one R pad: the first holder wins the tie
  });

  test("RUDY and via sites", () => {
    expect(r.congestion.cell_mm).toBe(2);
    expect(r.congestion.max).toBeGreaterThan(0);
    expect(r.via_sites.free_fraction).toBeGreaterThan(0.8);
    expect(r.via_sites.free_fraction).toBeLessThan(1);
    expect(Object.keys(r.via_sites.free_by_10mm_cell)).toEqual(["0,0", "10,0", "20,0", "30,0", "0,10", "10,10", "20,10", "30,10", "0,20", "10,20", "20,20", "30,20"]);
    expect(placementLines(r).join("\n")).toContain("U1 turn 180");
  });

  test("python float arithmetic helpers", () => {
    expect(pyFloorDiv(1, 0.1)).toBe(9); // Python: 1 // 0.1 == 9.0, Math.floor(1 / 0.1) == 10
    expect(pyFloorDiv(-3.5, 2)).toBe(-2);
    expect(pyFloorDiv(7.9, 2)).toBe(3);
    expect(pyMod(-90, 360)).toBe(270);
  });
});

describe("blockInventory (block_inventory.py)", () => {
  test("sheet blocks, and anchor blocks inside a split sheet", () => {
    const sheets = blockInventory(BOARD, { ground: "GND", anchor: /^(.*_)?(U|IC)\d/ });
    expect(Object.keys(sheets)).toEqual(["mcu", "power"]);
    expect(sheets["power"]!.locked).toEqual(["J1"]);
    expect(sheets["power"]!.no_courtyard).toEqual(["C1"]);
    expect(sheets["mcu"]!.count).toBe(5);
    expect(sheets["mcu"]!.area_F).toBe(20); // five 2 x 2 courtyards
    const split = blockInventory(BOARD, { split: ["mcu"], ground: "GND", anchor: /^(.*_)?(U|IC)\d/ });
    expect(split["U1"]!.parts).toEqual(["U1", "R1", "R2", "R3", "R4"]);
    expect(split["U1"]!.label).toBe("VU1");
    expect(blockLines(split).at(-1)).toContain("total courtyard area");
  });
});

describe("pose of a transform without rotate", () => {
  test("reads 0 degrees and writes the rotation on a turn", () => {
    const body = `(footprint "L:X"\n    (transform\n      (translate 1.0000 2.0000)\n      (scale 1 1))\n    (layer "F.Cu")\n    (pad "1" smd rect (at 0.5 0 0) (size 1 1)))`;
    expect(pose(body)).toEqual([1, 2, 0]);
    const turned = setPose(body, 3, 4, 90);
    expect(pose(turned)).toEqual([3, 4, 90]);
    expect(turned).toContain("(at 0.5 0 90)");
  });
});

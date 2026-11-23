/** The toolkit's flow/pairseat.py, ported: rows checked against the Python oracle on the same board (2026-11-13). */
import { describe, expect, test } from "bun:test";
import { parseBoard } from "../src/board";
import { pairSeat, seatGroups } from "../src/layout/pairseat";
import type { Acceptance } from "../src/requirements";
import { SEAT_BOARD } from "./fixtures";

const acc = (pairs: Array<[string, string]>) => ({ net_classes: { classes: { PAIR_X: { pairs } } } }) as unknown as Acceptance;
const PAIRS: Array<[string, string]> = [["USB_C_DP", "USB_C_DN"], ["LV1_P", "LV1_N"], ["USB_DP", "USB_DN"]];

describe("pairSeat", () => {
  test("seats each pass-through part on its chip pins, chip frame, the rotation nearest its pins, partners spread along the side", () => {
    const rows = pairSeat(parseBoard(SEAT_BOARD), acc(PAIRS), /^(J1)$/);
    expect(Object.keys(rows)).toEqual(["U1"]);
    const u1 = rows["U1"]!;
    expect(u1.anchor).toBe("U1");
    expect(u1.tolerance_mm).toBe(0.3);
    // oracle: python3 flow/pairseat.py on SEAT_BOARD
    expect([...u1.members].sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: "FL1", at: [0, 4.6], rot: 270, pads: { FL1: ["1", "2"], U1: ["5", "6"] } },
      { ref: "R1", at: [-4.4, -0.45], rot: 180, pads: { R1: ["1"], U1: ["1"] } },
      { ref: "R2", at: [-4.4, 0.45], rot: 180, pads: { R2: ["1"], U1: ["2"] } },
    ]);
  });
  test("a pair net that reaches a fixed part, a second chip or more than two pads is not a pass-through", () => {
    expect(pairSeat(parseBoard(SEAT_BOARD), acc(PAIRS), /^(J1|R1|R2|FL1)$/)).toEqual({});
    expect(pairSeat(parseBoard(SEAT_BOARD), acc([["USB_DP", "USB_DN"]]), /^(J1)$/)).toEqual({});
  });
  test("seated members move into the chip's group; emptied groups go", () => {
    const rows = pairSeat(parseBoard(SEAT_BOARD), acc(PAIRS), /^(J1)$/);
    const groups = seatGroups(
      [
        { name: "u1", role: "core", refs: ["U1"], anchor: "U1", why: "" },
        { name: "misc", role: "core", refs: ["R1", "R2", "FL1"], why: "" },
      ],
      rows,
    );
    expect(groups).toEqual([{ name: "u1", role: "core", refs: ["U1", "FL1", "R2", "R1"], anchor: "U1", why: "" }]);
  });
});

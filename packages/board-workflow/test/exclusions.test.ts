import { describe, expect, test } from "bun:test";
import { carryExclusions, readDrcExclusions, withDrcExclusions, withExclusionChanges } from "../src/edit/exclusions";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fp = (uuid: string, ref: string, lib: string, x: number, y: number, rot: number, pads: Array<[string, string]> = []) =>
  `\t(footprint "${lib}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid}")\n\t\t(at ${x} ${y} ${rot})\n\t\t(property "Reference" "${ref}"\n\t\t\t(at 0 0 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "${U(900 + Number(uuid.slice(-3)))}")\n\t\t)\n` +
  pads.map(([n, u]) => `\t\t(pad "${n}" smd rect\n\t\t\t(at 0 0)\n\t\t\t(size 1 1)\n\t\t\t(layers "F.Cu")\n\t\t\t(uuid "${u}")\n\t\t)\n`).join("") +
  `\t)\n`;
const board = (...fps: string[]) => `(kicad_pcb\n\t(version 20241229)\n${fps.join("")}\t(segment\n\t\t(start 0 0)\n\t\t(end 1 1)\n\t\t(width 0.2)\n\t\t(layer "F.Cu")\n\t\t(net "GND")\n\t\t(uuid "${U(500)}")\n\t)\n)\n`;
const overlap = (...uuids: string[]) => ({ type: "courtyards_overlap", severity: "error", items: uuids.map((uuid) => ({ uuid, description: "Footprint" })) });

describe("DRC exclusions that follow an edit", () => {
  // J1 overlaps J601 on purpose; the edit swaps J601 with J502 (same footprint id), so J502 now overlaps J1 there
  const swapSource = board(fp(U(1), "J1", "Conn:Big", 10, 10, 0), fp(U(601), "J601", "Conn:JST4", 20, 10, 0), fp(U(502), "J502", "Conn:JST4", 40, 40, 90));
  const swapAfter = board(fp(U(1), "J1", "Conn:Big", 10, 10, 0), fp(U(601), "J601", "Conn:JST4", 40, 40, 90), fp(U(502), "J502", "Conn:JST4", 20, 10, 0));
  const swapEx = [{ key: `courtyards_overlap|15000000|10000000|${U(1)}|${U(601)}`, comment: "Intentional Overlap" }];

  test("(b) replaced: an identical part at the excluded one's old pose takes over the exclusion at the same position", () => {
    const r = carryExclusions({ exclusions: swapEx, source: swapSource, after: swapAfter, sourceViolations: [], afterViolations: [overlap(U(502), U(1))], editId: "swap-1" });
    expect(r.carried).toHaveLength(1);
    expect(r.carried[0]!.how).toBe("replaced");
    // the candidate violation's item order is KiCad's main/aux order, which the key must repeat
    expect(r.entries).toEqual([{ key: `courtyards_overlap|15000000|10000000|${U(502)}|${U(1)}`, comment: "Intentional Overlap [carried by edit swap-1]" }]);
    expect(r.carried[0]!.line).toBe("courtyards_overlap J1 + J601 at (15, 10) -> J502 + J1 at (15, 10) (J502 took J601's place)");
    // carried again by a later edit: one note, not two
    const again = carryExclusions({ exclusions: r.entries, source: swapAfter, after: swapSource, sourceViolations: [], afterViolations: [overlap(U(1), U(601))], editId: "swap-2" });
    expect(again.entries[0]!.comment).toBe("Intentional Overlap [carried by edit swap-2]");
  });

  test("(b) is refused for a different footprint id, a pose off by more than 1 um, or a violation the source already had", () => {
    const otherLib = swapAfter.replace('(footprint "Conn:JST4"\n\t\t(layer "F.Cu")\n\t\t(uuid "' + U(502), '(footprint "Conn:JST6"\n\t\t(layer "F.Cu")\n\t\t(uuid "' + U(502));
    expect(otherLib).not.toBe(swapAfter);
    const off = board(fp(U(1), "J1", "Conn:Big", 10, 10, 0), fp(U(601), "J601", "Conn:JST4", 40, 40, 90), fp(U(502), "J502", "Conn:JST4", 20.002, 10, 0));
    for (const after of [otherLib, off]) {
      const r = carryExclusions({ exclusions: swapEx, source: swapSource, after, sourceViolations: [], afterViolations: [overlap(U(502), U(1))], editId: "e" });
      expect(r.carried).toEqual([]);
      expect(r.entries).toEqual(swapEx);
    }
    const had = carryExclusions({ exclusions: swapEx, source: swapSource, after: swapAfter, sourceViolations: [overlap(U(1), U(502))], afterViolations: [overlap(U(502), U(1))], editId: "e" });
    expect(had.carried).toEqual([]);
  });

  test("(a) moved together: the same pair after one rigid motion is re-keyed to the moved position", () => {
    // R1 and R2 overlap at (11, 10); both turn a quarter and move: R1 (10,10,0) -> (30,30,90), R2 (12,10,0) -> (30,28,90)
    const src = board(fp(U(3), "R1", "R:0603", 10, 10, 0, [["1", U(31)]]), fp(U(4), "R2", "R:0603", 12, 10, 0));
    const aft = board(fp(U(3), "R1", "R:0603", 30, 30, 90, [["1", U(31)]]), fp(U(4), "R2", "R:0603", 30, 28, 90));
    const ex = [
      { key: `courtyards_overlap|11000000|10000000|${U(3)}|${U(4)}`, comment: "" },
      { key: `clearance|10500000|10000000|${U(31)}|${U(4)}`, comment: "ok" },
    ];
    const r = carryExclusions({ exclusions: ex, source: src, after: aft, sourceViolations: [], afterViolations: [overlap(U(4), U(3)), { type: "clearance", items: [{ uuid: U(31) }, { uuid: U(4) }] }], editId: "mv" });
    expect(r.carried.map((c) => c.how)).toEqual(["moved together", "moved together"]);
    expect(r.entries.map((e) => e.key)).toEqual([`courtyards_overlap|30000000|29000000|${U(4)}|${U(3)}`, `clearance|30000000|29500000|${U(31)}|${U(4)}`]);
    expect(r.carried[1]!.line).toBe("clearance R1.1 + R2 at (10.5, 10) -> R1.1 + R2 at (30, 29.5) (moved together)");
  });

  test("not carried: only one of the pair moved (the marker lands somewhere new), or nothing corresponds", () => {
    const src = board(fp(U(3), "R1", "R:0603", 10, 10, 0), fp(U(4), "R2", "R:0603", 12, 10, 0), fp(U(5), "R3", "R:0603", 50, 50, 0));
    const aft = board(fp(U(3), "R1", "R:0603", 10.5, 10, 0), fp(U(4), "R2", "R:0603", 12, 10, 0), fp(U(5), "R3", "R:0603", 13, 10, 0));
    const ex = [{ key: `courtyards_overlap|11000000|10000000|${U(3)}|${U(4)}`, comment: "x" }];
    const r = carryExclusions({ exclusions: ex, source: src, after: aft, sourceViolations: [], afterViolations: [overlap(U(3), U(4)), overlap(U(4), U(5))], editId: "e" });
    expect(r.carried).toEqual([]);
    expect(r.entries).toEqual(ex);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("not carried: courtyards_overlap exclusion for R1 + R2 at (11, 10)");
    // an exclusion whose parts the edit did not touch is left alone (it still matches as before)
    const still = carryExclusions({ exclusions: ex, source: src, after: src.replace("(at 50 50 0)", "(at 13 10 0)"), sourceViolations: [], afterViolations: [overlap(U(4), U(5))], editId: "e" });
    expect(still).toEqual({ entries: ex, carried: [], notes: [] });
  });

  test("the project file keeps every byte but the exclusions array, in the form it used", () => {
    const pro = `{\n  "board": {\n    "design_settings": {\n      "defaults": {\n        "size": 1.0\n      },\n      "drc_exclusions": [\n        [\n          "a|1|2|${U(1)}|${U(2)}",\n          "keep [this] \\"quoted\\""\n        ]\n      ],\n      "meta": {\n        "version": 2\n      }\n    }\n  }\n}\n`;
    expect(readDrcExclusions(pro)?.map(({ key, comment }) => ({ key, comment }))).toEqual([{ key: `a|1|2|${U(1)}|${U(2)}`, comment: 'keep [this] "quoted"' }]);
    const out = withDrcExclusions(pro, [{ key: `a|3|4|${U(1)}|${U(2)}`, comment: "c" }]);
    expect(out).toContain('"size": 1.0');
    expect(out).toBe(pro.replace(`"a|1|2|`, `"a|3|4|`).replace('"keep [this] \\"quoted\\""', '"c"'));
    const bare = `{"board":{"design_settings":{"drc_exclusions":["k|1|2|${U(1)}|${U(2)}"]}}}`;
    expect(JSON.parse(withDrcExclusions(bare, [{ key: "k2", comment: "dropped" }])).board.design_settings.drc_exclusions).toEqual(["k2"]);
    expect(readDrcExclusions("{}")).toBeNull();
  });

  // KiCad 10.99 (design settings v3) stores each exclusion as an object with the IPC API's error type
  const v3 = (entries: unknown[]) => `${JSON.stringify({ board: { design_settings: { drc_exclusions: entries, meta: { version: 3 } } } }, null, 2)}\n`;
  const marker = (type: string, items: string[], x: number, y: number, comment: string, layer?: string) => ({ comment, marker: { error_type: type, items: items.map((value) => ({ value })), ...(layer ? { layer } : {}), position: { x_nm: String(x), y_nm: String(y) } } });

  test("v3 entries read as the same keys, a re-keyed one is written back as a v3 object, the rest untouched", () => {
    const sliver = marker("DRCET_COPPER_SLIVER", [U(9)], 5, 6, "sliver ok", "BL_F_Cu");
    const pro = v3([marker("DRCET_OVERLAPPING_FOOTPRINTS", [U(1), U(601)], 15000000, 10000000, "Intentional Overlap"), marker("DRCET_DANGLING_VIA", [U(7)], 1, 2, "Testpoint"), sliver]);
    const read = readDrcExclusions(pro)!;
    expect(read.map((e) => e.key).slice(0, 2)).toEqual([`courtyards_overlap|15000000|10000000|${U(1)}|${U(601)}`, `via_dangling|1|2|${U(7)}|00000000-0000-0000-0000-000000000000`]);
    expect(read[2]!.key).toStartWith("?"); // a layer marker: never re-keyed, only kept
    const r = carryExclusions({ exclusions: read, source: swapSource, after: swapAfter, sourceViolations: [], afterViolations: [overlap(U(502), U(1))], editId: "swap-1" });
    const out = JSON.parse(withDrcExclusions(pro, r.entries)).board.design_settings.drc_exclusions;
    expect(out[0]).toEqual(marker("DRCET_OVERLAPPING_FOOTPRINTS", [U(502), U(1)], 15000000, 10000000, "Intentional Overlap [carried by edit swap-1]"));
    expect(out.slice(1)).toEqual([marker("DRCET_DANGLING_VIA", [U(7)], 1, 2, "Testpoint"), sliver]);
  });

  test("an edit's change lands on a project file KiCad has since re-stored as v3 (what adopt does after a KiCad 10.99 save)", () => {
    const from = [{ key: `courtyards_overlap|15000000|10000000|${U(1)}|${U(601)}`, comment: "Intentional Overlap" }, { key: `via_dangling|1|2|${U(7)}|00000000-0000-0000-0000-000000000000`, comment: "Testpoint" }];
    const to = [{ key: `courtyards_overlap|15000000|10000000|${U(502)}|${U(1)}`, comment: "Intentional Overlap [carried by edit e]" }, from[1]!];
    const saved = v3([marker("DRCET_DANGLING_VIA", [U(7)], 1, 2, "Testpoint"), marker("DRCET_OVERLAPPING_FOOTPRINTS", [U(1), U(601)], 15000000, 10000000, "Intentional Overlap")]);
    const out = JSON.parse(withExclusionChanges(saved, from, to)).board.design_settings.drc_exclusions;
    expect(out).toEqual([marker("DRCET_DANGLING_VIA", [U(7)], 1, 2, "Testpoint"), marker("DRCET_OVERLAPPING_FOOTPRINTS", [U(502), U(1)], 15000000, 10000000, "Intentional Overlap [carried by edit e]")]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSexpr, release } from "../src";
import { checkCoverage } from "../src/review/checks";
import { boardParts as reviewParts } from "../src/review/geometry";

const { assembled, notFittedReason, placedPart, footprintFlags, copperOnlyShape } = release;

const fp = (lib: string, ref: string, extra: string, pads: string) =>
  `  (footprint "${lib}" (layer "F.Cu") (at 10 10 0) ${extra}
    (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "v" (at 0 0 0) (layer "F.Fab"))
${pads})\n`;
const smd = (net: string) => `    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "${net}"))\n    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "B"))`;
const board = `(kicad_pcb (version 20260206) (generator "pcbnew")
${fp("R:R_0402", "R1", "", smd("A"))}${fp("R:R_0402", "R2", "(exclude_from_bom yes)", smd("A"))}${fp("R:R_0402", "R3", "(dnp no)", smd("A"))}${fp("C:C_0402", "C1", "(attr smd exclude_from_pos_files)", smd("A"))}${fp("MountingHole:MountingHole_3.2mm_M3_Pad_Via", "H1", "", `    (pad "1" thru_hole circle (at 0 0) (size 6 6) (drill 3.2) (layers "*.Cu") (net 3 "GND"))`)}${fp("Jumper:SolderJumper_Open", "Q7", "", smd("A"))}${fp("TestPoint:TestPoint_Pad_1.0x1.0mm", "TP1", "", `    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A"))`)})
`;

describe("one fitted-part definition for review and release", () => {
  test("reasons, flags, placement", () => {
    const base = { ref: "R1", lib: "R:R_0402", flags: [] as string[], pads: [{ net: "A" }] };
    expect(notFittedReason(base)).toBeNull();
    expect(notFittedReason({ ...base, flags: ["dnp"] })).toBe("dnp");
    expect(notFittedReason({ ...base, flags: ["exclude_from_bom"] })).toBe("exclude_from_bom");
    expect(notFittedReason({ ...base, flags: ["board_only"] })).toBe("board_only");
    expect(notFittedReason({ ...base, lib: "MountingHole:MountingHole_3.2mm_M3_Pad" })).toBe("board_feature");
    expect(notFittedReason({ ...base, footprint: "Jumper:SolderJumper_Open" })).toBe("board_feature");
    expect(notFittedReason({ ...base, pads: [] })).toBe("no_pads");
    expect(notFittedReason({ ...base, pads: [{ net: "unconnected-(R1-Pad1)" }] })).toBe("not_netted");
    expect(assembled({ ...base, ref: "J1", pads: [{ net: "" }] })).toBe(true); // a mechanical-only connector is still bought
    expect(placedPart(base, false)).toBe(true);
    expect(placedPart({ ...base, flags: ["exclude_from_pos_files"] }, false)).toBe(false);
    expect(placedPart(base, true)).toBe(false);
    expect(copperOnlyShape({ ref: "TP1", pads: [{ type: "smd" }], models: [] })).toBe(true);
    expect(copperOnlyShape({ ref: "TP1", pads: [{ type: "smd" }], models: ["tp.step"] })).toBe(false);
    const root = parseSexpr(board);
    const flags = Object.fromEntries(release.boardParts(root).map((p) => [p.ref, p.flags]));
    expect(flags["R2"]).toEqual(["exclude_from_bom"]);
    expect(flags["R3"]).toEqual([]);
    expect(flags["C1"]).toEqual(["exclude_from_pos_files", "smd"]);
    // the review reads the same flags (it used to miss KiCad 9's `(exclude_from_bom yes)`)
    expect(Object.fromEntries(reviewParts(root).map((p) => [p.ref, p.flags]))).toEqual(flags);
    expect(footprintFlags(["footprint", "x", ["attr", "smd", "board_only"], ["dnp", "yes"]])).toEqual(["board_only", "dnp", "smd"]);
  });

  test("release: board features are not BOM lines and do not block the BOM gate", async () => {
    const parts = release.boardParts(parseSexpr(board)).filter(assembled).map((p) => p.ref);
    expect(parts.sort()).toEqual(["C1", "R1", "R3", "TP1"]);
    const record = (refs: string[], over: Record<string, unknown> = {}) => ({ line: refs[0]!, refs, status: "RESOLVED", lcsc: "C25744", qty_per_board: refs.length, value: "v", mpn_board: null, checks: {}, evidence: [], risks: [], owner: [], ...over });
    const records = [record(["R1", "R3"]), record(["C1"]), record(["TP1"], { lcsc: null, copper_only: true })];
    expect(() => release.assertReleaseBom({ records } as never, board)).not.toThrow();
    expect(() => release.assertReleaseBom({ records: records.slice(1) } as never, board)).toThrow("R1 (missing)");
  });

  test("review coverage: same fitted set; the CPL rule matches the release's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fitted-"));
    try {
      const cpl = join(dir, "cpl.csv");
      await writeFile(cpl, "Designator,Mid X,Mid Y,Layer,Rotation\nR1,10,10,Top,0\n");
      const ctx = { project: { cfg: { assembly: { cpl, sides: ["F"] } } }, parts: () => reviewParts(parseSexpr(board)) };
      const r = await checkCoverage(ctx as never);
      expect(r.detail).toStartWith("4 assembled parts");
      // R3 must be placed; C1 (exclude_from_pos_files) and TP1 (copper only) have no CPL row; H1 / Q7 are board features
      expect(r.findings.map((f) => `${f.rule} ${f.severity} ${f.claim}`)).toEqual([
        "COVER note 1 netted part(s) not fitted (DNP / excluded): R2",
        "CPL must-fix R3 must be assembled but is missing from cpl.csv",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

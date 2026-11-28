import { describe, expect, test } from "bun:test";
import { parseGerber } from "@fabdesk/board-art";
import { classifyFilename, classifyFileFunction } from "../src/classify";
import { parseExcellon } from "../src/excellon";
import { checkCompleteness } from "../src/completeness";
import { resolveRules } from "../src/profiles";
import { completePackage, drill } from "./fixtures";
import { loadPackageFromFiles } from "../src/package";

describe("gerber + excellon fixtures", () => {
  test("complete package classifies copper, mask, silk, outline and drill", () => {
    const loaded = loadPackageFromFiles(completePackage());
    const kinds = loaded.classified.map((f) => `${f.kind}:${f.side}:${f.name.split("/").pop()}`);
    expect(kinds).toContain("copper:top:board-F_Cu.gbr");
    expect(kinds).toContain("copper:bottom:board-B_Cu.gbr");
    expect(kinds).toContain("mask:top:board-F_Mask.gbr");
    expect(kinds).toContain("silk:top:board-F_Silkscreen.gbr");
    expect(kinds).toContain("outline:none:board-Edge_Cuts.gbr");
    expect(kinds.some((k) => k.startsWith("drill:"))).toBe(true);
    const cu = loaded.classified.find((f) => f.name.endsWith("F_Cu.gbr"))!;
    expect(classifyFileFunction(cu.body)?.kind).toBe("copper");
    expect(parseGerber(cu.body).ops.length).toBeGreaterThan(0);
  });

  test("broken set is missing drill and mask layers", () => {
    const loaded = loadPackageFromFiles(completePackage({ omit: ["drill", "mask"] }));
    const section = checkCompleteness({
      files: loaded.classified,
      allNames: loaded.files.map((f) => f.name),
      rules: resolveRules("generic"),
      expectedCopperLayers: 2,
    });
    expect(section.verdict).toBe("fail");
    expect(section.findings.map((f) => f.id)).toContain("missing-drill");
    expect(section.findings.map((f) => f.id)).toContain("missing-f-mask");
    expect(section.findings.map((f) => f.id)).toContain("missing-b-mask");
  });

  test("filename heuristics cover KiCad and legacy extensions", () => {
    expect(classifyFilename("board-F_Cu.gbr")).toEqual({ kind: "copper", side: "top", copperIndex: 1 });
    expect(classifyFilename("board-In1_Cu.gbr")).toMatchObject({ kind: "copper", side: "inner" });
    expect(classifyFilename("board.drl")).toMatchObject({ kind: "drill" });
    expect(classifyFilename("board-NPTH.drl")).toMatchObject({ kind: "drill", side: "none" });
    expect(classifyFilename("board-F_Silkscreen.gbr")).toMatchObject({ kind: "silk", side: "top" });
  });

  test("Excellon parser reads metric hits and slots", () => {
    const file = drill("board.drl", [
      { x: 1.5, y: 2.25, d: 0.3 },
      { x: 4, y: 4, d: 0.8 },
    ]);
    const parsed = parseExcellon(new TextDecoder().decode(file.bytes), true);
    expect(parsed.unit).toBe("mm");
    expect(parsed.hits).toHaveLength(2);
    expect(parsed.hits[0]).toMatchObject({ x: 1.5, y: 2.25, diameterMm: 0.3 });
    const slot = parseExcellon(
      ["M48", "METRIC,TZ", "T01C0.400", "%", "T01", "X1.0Y1.0G85X3.0Y1.0", "M30"].join("\n"),
      false,
    );
    expect(slot.hits[0]?.slot).toEqual({ x2: 3, y2: 1 });
    expect(slot.plated).toBe(false);
  });
});

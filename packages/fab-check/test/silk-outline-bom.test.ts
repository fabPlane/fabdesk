import { describe, expect, test } from "bun:test";
import { checkBomPnp } from "../src/bom";
import { checkOutline } from "../src/outline";
import { checkSilk } from "../src/silk";
import { resolveRules } from "../src/profiles";
import { completePackage, drill, openOutline, outline, sampleParts } from "./fixtures";
import { loadPackageFromFiles } from "../src/package";

describe("silkscreen", () => {
  test("detects silk over a mask opening", () => {
    const files = completePackage({
      silk: [{ kind: "circle", x: 5, y: 5, d: 1.2 }],
      mask: [{ kind: "circle", x: 5, y: 5, d: 1.6 }],
    });
    const loaded = loadPackageFromFiles(files);
    const section = checkSilk({ files: loaded.classified, rules: resolveRules() });
    expect(section.verdict).toBe("fail");
    expect(section.findings.some((f) => f.message.includes("soldermask opening"))).toBe(true);
  });

  test("flags silk outside the outline", () => {
    const files = completePackage({
      silk: [{ kind: "circle", x: 40, y: 40, d: 0.8 }],
    });
    const loaded = loadPackageFromFiles(files);
    const section = checkSilk({ files: loaded.classified, rules: resolveRules() });
    expect(section.findings.some((f) => f.message.includes("outside"))).toBe(true);
  });
});

describe("outline", () => {
  test("closed outline with in-board drills passes", () => {
    const loaded = loadPackageFromFiles([outline(), drill("gerbers/board.drl", [{ x: 2, y: 2 }])]);
    const section = checkOutline({
      files: loaded.classified,
      design: { outline: { minX: 0, minY: 0, maxX: 20, maxY: 12, widthMm: 20, heightMm: 12, closed: true } },
    });
    expect(section.findings.filter((f) => f.severity === "fail")).toEqual([]);
    expect(section.verdict === "pass" || section.verdict === "warn").toBe(true);
  });

  test("open outline fails", () => {
    const loaded = loadPackageFromFiles([openOutline()]);
    const section = checkOutline({ files: loaded.classified });
    expect(section.verdict).toBe("fail");
    expect(section.findings.map((f) => f.id)).toContain("outline-open");
  });

  test("drill outside the outline fails", () => {
    const loaded = loadPackageFromFiles([outline(), drill("gerbers/board.drl", [{ x: 40, y: 40 }])]);
    const section = checkOutline({ files: loaded.classified });
    expect(section.findings.some((f) => f.message.includes("outside the board outline"))).toBe(true);
  });
});

describe("BOM / pick-and-place", () => {
  test("flags a rotated part and a missing part", () => {
    const pos = `Ref,Val,Package,PosX,PosY,Rot,Side
R1,10k,R_0805,5.000,4.000,90.000,top
`;
    const bom = "Reference,Value,Footprint\nR1,10k,R_0805\n";
    const section = checkBomPnp({
      bomCsv: bom,
      posCsv: pos,
      design: { parts: sampleParts },
      rules: resolveRules(),
    });
    expect(section.verdict).toBe("fail");
    expect(section.findings.some((f) => f.id === "rot-R1")).toBe(true);
    expect(section.findings.some((f) => f.id === "missing-pos-C1")).toBe(true);
  });

  test("matching BOM and PnP pass", () => {
    const loaded = loadPackageFromFiles(completePackage());
    const section = checkBomPnp({
      bomCsv: loaded.bomCsv,
      posCsv: loaded.posCsv,
      design: { parts: sampleParts },
      rules: resolveRules(),
    });
    expect(section.verdict).toBe("pass");
  });

  test("DNP parts left in PnP are a warning", () => {
    const section = checkBomPnp({
      posCsv: "Ref,Val,Package,PosX,PosY,Rot,Side\nDNP1,0R,R_0805,1,1,0,top\n",
      design: {
        parts: [{ ref: "DNP1", value: "0R", footprint: "R_0805", x: 1, y: 1, rotationDeg: 0, side: "top", dnp: true }],
      },
      rules: resolveRules(),
    });
    expect(section.findings.some((f) => f.id === "dnp-pos-DNP1")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { checkClearance } from "../src/clearance";
import { resolveRules } from "../src/profiles";
import { completePackage, copper } from "./fixtures";
import { loadPackageFromFiles } from "../src/package";

describe("copper clearance", () => {
  test("flags two traces closer than 0.15 mm", () => {
    const files = completePackage({
      copper: [
        { kind: "line", x1: 2, y1: 3, x2: 12, y2: 3, w: 0.2 },
        { kind: "line", x1: 2, y1: 3.3, x2: 12, y2: 3.3, w: 0.2 },
      ],
    });
    const loaded = loadPackageFromFiles(files);
    const section = checkClearance({ files: loaded.classified, rules: resolveRules("generic", { minSpacingMm: 0.15 }) });
    expect(section.verdict).toBe("fail");
    expect(section.findings.some((f) => f.check === "clearance" && f.x != null)).toBe(true);
  });

  test("passes traces that meet the spacing floor", () => {
    const files = completePackage({
      copper: [
        { kind: "line", x1: 2, y1: 3, x2: 12, y2: 3, w: 0.2 },
        { kind: "line", x1: 2, y1: 4.0, x2: 12, y2: 4.0, w: 0.2 },
      ],
    });
    const loaded = loadPackageFromFiles(files);
    const section = checkClearance({ files: loaded.classified, rules: resolveRules("generic", { minSpacingMm: 0.15 }) });
    expect(section.findings.filter((f) => f.message.includes("closer"))).toEqual([]);
    expect(section.verdict).toBe("pass");
  });

  test("flags a trace thinner than the fab floor", () => {
    const loaded = loadPackageFromFiles([
      copper("gerbers/board-F_Cu.gbr", "Copper,L1,Top", [{ kind: "line", x1: 1, y1: 1, x2: 8, y2: 1, w: 0.08 }]),
    ]);
    const section = checkClearance({ files: loaded.classified, rules: resolveRules("generic", { minTraceMm: 0.15 }) });
    expect(section.verdict).toBe("fail");
    expect(section.findings[0]?.message).toContain("Trace width");
  });
});

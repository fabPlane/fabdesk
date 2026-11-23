import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "@fabdesk/board-art";
import { checkFabPackage, summarizeReport } from "../src/check";
import { completePackage, sampleParts } from "./fixtures";

describe("fab package check", () => {
  test("complete package produces renders and a pass/warn report", async () => {
    const renderDir = await mkdtemp(join(tmpdir(), "fab-check-"));
    const report = await checkFabPackage(
      { files: completePackage(), source: "fixture" },
      {
        fab: "generic",
        renderDir,
        design: {
          parts: sampleParts,
          outline: { minX: 0, minY: 0, maxX: 20, maxY: 12, widthMm: 20, heightMm: 12, closed: true },
          copperLayers: 2,
          drc: { errors: 0, warnings: 0 },
        },
      },
    );
    expect(["pass", "warn"]).toContain(report.overall);
    expect(report.version).toBe(1);
    expect(report.checks.map((c) => c.id)).toEqual([
      "completeness",
      "clearance",
      "silk",
      "outline",
      "bom",
      "design",
    ]);
    expect(report.renders.length).toBeGreaterThan(2);
    expect(report.renders.some((r) => r.layer === "top-composite")).toBe(true);
    const png = report.renders.find((r) => r.layer.includes("F_Cu"));
    expect(png).toBeDefined();
    expect(png?.bounds).toBeDefined();
    const bytes = await readFile(join(renderDir, png!.pngPath.split("/").pop()!));
    const image = decodePng(bytes);
    expect(image.width).toBeGreaterThan(8);
    expect(image.height).toBeGreaterThan(8);
    expect(summarizeReport(report)).toContain("Fab package check:");
  });

  test("missing drill and mask fail completeness", async () => {
    const report = await checkFabPackage({
      files: completePackage({ omit: ["drill", "mask"] }),
    });
    expect(report.overall).toBe("fail");
    expect(report.checks.find((c) => c.id === "completeness")?.verdict).toBe("fail");
  });
});

import { describe, expect, test } from "bun:test";
import { svgArtifactCopy } from "./SvgTab";

describe("SVG artifact copy", () => {
  test("uses human-facing names and identifies the expected format", () => {
    expect(svgArtifactCopy("pcb")).toEqual({ label: "PCB", title: "No PCB SVG render yet", action: "Render PCB SVG" });
    expect(svgArtifactCopy("schematic")).toEqual({ label: "schematic", title: "No schematic SVG render yet", action: "Render schematic SVG" });
  });
});

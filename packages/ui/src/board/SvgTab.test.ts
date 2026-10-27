import { describe, expect, test } from "bun:test";
import { buildCommentAskPrompt } from "@fabdesk/protocol";
import { commentPinAnchor, svgArtifactCopy } from "./SvgTab";

describe("SVG artifact copy", () => {
  test("uses human-facing names and identifies the expected format", () => {
    expect(svgArtifactCopy("pcb")).toEqual({ label: "PCB", title: "No PCB SVG render yet", action: "Render PCB SVG" });
    expect(svgArtifactCopy("schematic")).toEqual({ label: "schematic", title: "No schematic SVG render yet", action: "Render schematic SVG" });
  });
});

describe("comment pin anchors", () => {
  test("copies verified native PCB coordinates into millimetre anchors", () => {
    const pcb = commentPinAnchor("pcb", { x: 12.4, y: 8 }, { ref: "U12" });
    expect(pcb).toEqual({ view: "pcb", coordinateSystem: "kicad-pcb-mm", x: 12.4, y: 8, xMm: 12.4, yMm: 8, ref: "U12" });
    expect(buildCommentAskPrompt({
      id: "cmt_u12",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      author: "maya",
      status: "open",
      question: "What is here?",
      anchor: pcb,
    })).toContain("Near (mm): 12.4, 8");
  });

  test("leaves schematic clicks in SVG units only", () => {
    const schematic = commentPinAnchor("schematic", { x: 40, y: 20 });
    expect(schematic).toEqual({ view: "schematic", x: 40, y: 20 });
    expect("xMm" in schematic).toBe(false);
  });
});


test("unverified SVG clicks do not invent native PCB millimetres", () => {
  const anchor = commentPinAnchor("pcb", { x: 7.5, y: 7.5 }, {}, false);
  expect(anchor.coordinateSystem).toBe("svg");
  expect("xMm" in anchor).toBe(false);
});

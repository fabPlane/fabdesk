import { describe, expect, test } from "bun:test";
import {
  BOARD_MATERIAL_IDS,
  BOARD_MATERIAL_SUMMARIES,
  BoardMaterialId,
  layersForConstruction,
  resolveBoardMaterial,
  specialistFabNote,
} from "./materials";

describe("board material protocol", () => {
  test("seven presets validate and FR-4 is the default", () => {
    expect(BOARD_MATERIAL_IDS).toEqual(["fr4", "flex", "aluminium", "copper_core", "rogers", "ptfe", "hdi"]);
    expect(BOARD_MATERIAL_SUMMARIES.map((m) => m.id)).toEqual([...BOARD_MATERIAL_IDS]);
    for (const summary of BOARD_MATERIAL_SUMMARIES) {
      expect(BoardMaterialId.parse(summary.id)).toBe(summary.id);
      expect(summary.constructions).toContain(summary.defaultConstruction);
      expect(summary.blurb.length).toBeGreaterThan(10);
      expect(summary.whenToUse.length).toBeGreaterThan(10);
    }
    expect(resolveBoardMaterial(undefined)).toBe("fr4");
    expect(specialistFabNote("fr4")).toBeUndefined();
    expect(specialistFabNote("flex")).toMatch(/specialist|flex|not a standard FR-4/i);
    expect(layersForConstruction("hybrid")).toBe(4);
    expect(layersForConstruction("1l")).toBe(1);
  });
});

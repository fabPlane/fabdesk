import { expect, test } from "bun:test";
import { enclosureWorkflow, enclosureSelectionKey } from "./enclosure-workflow";

const paths = ["board.kicad_pcb", "usb.kicad_pcb"];
const input = { paths, readyPaths: paths, confirmedSelection: null, hasPreview: false };

test("new workflow locks later steps even when boards are loaded", () => {
  const state = enclosureWorkflow(input);
  expect(state.canContinue).toBe(true);
  expect(state.caseUnlocked).toBe(false);
  expect(state.previewUnlocked).toBe(false);
  expect(state.caseHint).toContain("Confirm your boards");
});

test("empty and unreadable selections cannot continue", () => {
  expect(enclosureWorkflow({ ...input, paths: [] }).canContinue).toBe(false);
  expect(enclosureWorkflow({ ...input, readyPaths: [paths[0]!] }).canContinue).toBe(false);
  expect(enclosureWorkflow({ ...input, recovering: true }).canContinue).toBe(false);
});

test("confirmation unlocks Case, and only a current preview unlocks Preview", () => {
  const confirmed = { ...input, confirmedSelection: enclosureSelectionKey(paths) };
  expect(enclosureWorkflow(confirmed).caseUnlocked).toBe(true);
  expect(enclosureWorkflow(confirmed).previewUnlocked).toBe(false);
  expect(enclosureWorkflow({ ...confirmed, hasPreview: true }).previewUnlocked).toBe(true);
  expect(
    enclosureWorkflow({ ...confirmed, hasPreview: true, recovering: true }).previewUnlocked,
  ).toBe(false);
});

test("changing boards relocks downstream steps; cosmetic ordering does not", () => {
  const confirmed = {
    ...input,
    confirmedSelection: enclosureSelectionKey(paths),
    hasPreview: true,
  };
  expect(enclosureWorkflow({ ...confirmed, paths: [...paths].reverse() }).caseUnlocked).toBe(true);
  expect(enclosureWorkflow({ ...confirmed, paths: [paths[0]!] }).caseUnlocked).toBe(false);
  expect(
    enclosureWorkflow({ ...confirmed, paths: [...paths, "new.kicad_pcb"] }).previewUnlocked,
  ).toBe(false);
  expect(enclosureWorkflow({ ...confirmed, hasPreview: false }).previewUnlocked).toBe(false);
});

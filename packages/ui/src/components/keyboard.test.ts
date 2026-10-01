import { expect, test } from "bun:test";
import { tabDestination, tabStopIndices } from "./keyboard";

test("tab stops skip hidden, disabled, inert and negative-tabindex controls", () => {
  const button = { disabled: false, tabIndex: 0, visible: true, radioGroup: "", checked: false };
  expect(tabStopIndices([button, { ...button, disabled: true }, { ...button, tabIndex: -2 }, { ...button, visible: false }, button])).toEqual([0, 4]);
  expect(tabStopIndices([])).toEqual([]);
});

test("radio groups use the checked eligible radio or their first eligible radio", () => {
  const radio = { disabled: false, tabIndex: 0, visible: true, radioGroup: "theme", checked: false };
  expect(tabStopIndices([radio, { ...radio, checked: true }, radio])).toEqual([1]);
  expect(tabStopIndices([{ ...radio, disabled: true, checked: true }, radio, radio, { ...radio, radioGroup: "agent" }])).toEqual([1, 3]);
});

test("tab arrows wrap and Home/End jump without handling unrelated keys", () => {
  expect(tabDestination("ArrowLeft", 0, 8)).toBe(7);
  expect(tabDestination("ArrowRight", 7, 8)).toBe(0);
  expect(tabDestination("ArrowRight", 0, 8)).toBe(1);
  expect(tabDestination("Home", 4, 8)).toBe(0);
  expect(tabDestination("End", 4, 8)).toBe(7);
  expect(tabDestination("ArrowLeft", 0, 1)).toBe(0);
  expect(tabDestination("ArrowRight", 0, 0)).toBeNull();
  expect(tabDestination("Tab", 0, 8)).toBeNull();
});

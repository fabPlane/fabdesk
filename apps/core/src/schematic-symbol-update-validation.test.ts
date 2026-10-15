import { expect, test } from "bun:test";
import {
  assertConsistentSymbolMetadata,
  assertEditableSymbolField,
} from "./schematic-symbol-update-validation";

test("shared multi-unit metadata accepts complete consistent edits and single-unit edits", () => {
  const units = [1, 2, 3].map(() => ({
    reference: "U7",
    value: "updated",
    footprint: "Package:New",
  }));
  expect(() =>
    assertConsistentSymbolMetadata(
      [...units, { reference: "R1", value: "10k", footprint: "Package:R" }],
      ["U7", "R1"],
    ),
  ).not.toThrow();
});

test("partial metadata edits cannot leave differing values or footprints, including other sheets", () => {
  for (const mismatch of [
    { value: "old", footprint: "Package:New" },
    { value: "updated", footprint: "Package:Old" },
  ])
    expect(() =>
      assertConsistentSymbolMetadata(
        [
          { reference: "U7", value: "updated", footprint: "Package:New" },
          { reference: "U7", ...mismatch },
        ],
        ["U7"],
      ),
    ).toThrow("include every affected unit");
});

test("custom fields are editable; shared metadata cannot bypass its validation via fields", () => {
  expect(() => assertEditableSymbolField("MPN")).not.toThrow();
  for (const name of ["Reference", "Value", "Footprint"])
    expect(() => assertEditableSymbolField(name)).toThrow("use newReference, value or footprint");
});

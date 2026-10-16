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

test("cross-sheet metadata mismatch explains the limit and offers a possible recovery", () => {
  const units = [
    { reference: "U7", value: "new", footprint: "Package:New" },
    { reference: "U7", value: "old", footprint: "Package:New" },
  ];
  try {
    assertConsistentSymbolMetadata(units, ["U7"], new Set(["U7"]));
    throw Error("expected rejection");
  } catch (error) {
    expect((error as Error).message).toContain("different sheets");
    expect((error as Error).message).toContain("only one sheet per batch");
    expect((error as Error).message).toContain("Keep shared metadata unchanged");
    expect((error as Error).message).toContain("import the saved project into a fresh project");
    expect((error as Error).message).not.toContain("include every affected unit in the batch");
  }
});

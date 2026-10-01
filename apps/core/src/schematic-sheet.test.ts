import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { SheetInstanceSchema, SheetPathSchema } from "@fp-pcb/proto";
import { resolveSchematicSheet } from "./schematic-sheet";
const instance = (id: string) =>
  create(SheetInstanceSchema, {
    name: "child",
    filename: "child.kicad_sch",
    path: create(SheetPathSchema, { path: [{ value: id }], pathHumanReadable: "/child" }),
  });
test("sheet resolution differentiates missing and ambiguous selectors, UUID selects repeated instances", () => {
  const sheets = [instance("a"), instance("b")];
  expect(() => resolveSchematicSheet(sheets, "missing")).toThrow("sheet not found: missing");
  expect(() => resolveSchematicSheet(sheets, "child")).toThrow("ambiguous schematic sheet child");
  expect(resolveSchematicSheet(sheets, "uuid:b").selected.path.path[0]?.value).toBe("b");
  try {
    resolveSchematicSheet(sheets, "missing");
  } catch (e) {
    expect((e as any).code).toBe("not_found");
  }
});

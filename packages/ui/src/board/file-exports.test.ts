import { expect, test } from "bun:test";
import { fileExportChoices } from "./file-exports";

test("main's existing exporters work without a stencil backend", () => {
  expect(fileExportChoices(undefined)).toEqual(["export_gerbers", "export_bom"]);
  expect(fileExportChoices([{ name: "export_gerbers" }, { name: "export_bom" }])).toEqual(["export_gerbers", "export_bom"]);
});

test("the stencil choice is enabled only for the actual registered tool", () => {
  expect(fileExportChoices([{ name: "export_stencil" }])).toEqual(["export_stencil", "export_gerbers", "export_bom"]);
  expect(fileExportChoices([{ name: "stencil_preview" }])).not.toContain("export_stencil");
});

test("the laser stencil choice is enabled only for export_laser_stencil", () => {
  expect(fileExportChoices([{ name: "export_laser_stencil" }])).toEqual([
    "export_laser_stencil",
    "export_gerbers",
    "export_bom",
  ]);
  expect(
    fileExportChoices([{ name: "export_stencil" }, { name: "export_laser_stencil" }]),
  ).toEqual(["export_stencil", "export_laser_stencil", "export_gerbers", "export_bom"]);
});

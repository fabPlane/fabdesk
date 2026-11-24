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

test("Studio copper export requires the copper removal capability", () => {
  expect(fileExportChoices([{ name: "export_commarker_copper" }])).toContain("export_commarker_copper");
  expect(fileExportChoices([{ name: "export_laser_stencil" }])).not.toContain("export_commarker_copper");
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

test("additional formats require their exact existing registered exporters", () => {
  const tools = ["export_drill", "export_pos", "export_dxf", "export_zip"] as const;
  expect(fileExportChoices(tools.map(name => ({ name })))).toEqual(["export_gerbers", "export_bom", ...tools]);
  expect(fileExportChoices([{ name: "export_drill" }])).toContain("export_drill");
  expect(fileExportChoices([{ name: "export_drill" }])).not.toContain("export_pos");
  expect(fileExportChoices([{ name: "fabrication_zip" }])).not.toContain("export_zip");
});

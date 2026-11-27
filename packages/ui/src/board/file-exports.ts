export const FILE_EXPORTS = {
  export_commarker_copper: { title: "Copper PCB", detail: "ComMarker Studio · Omni X 6W", action: "Open in ComMarker Studio", kind: "board" as const },
  export_stencil: { title: "3D stencil", detail: "Printable STL + SVG preview", action: "Export stencil", kind: "model" as const },
  export_laser_stencil: {
    title: "Laser stencil",
    detail: "LightBurn .lbrn2 + layered SVG/DXF",
    action: "Export laser stencil",
    kind: "drawing" as const,
  },
  export_gerbers: { title: "Gerbers", detail: "PCB manufacturing files", action: "Export Gerbers", kind: "board" as const },
  export_bom: { title: "Bill of materials", detail: "Component list", action: "Export BOM", kind: "data" as const },
  export_drill: { title: "Drill files", detail: "Excellon hole files", action: "Export drill files", kind: "drawing" as const },
  export_pos: { title: "Pick and place", detail: "Component placement CSV", action: "Export placements", kind: "data" as const },
  export_dxf: { title: "Layer DXF", detail: "F.Cu, B.Cu and Edge.Cuts · mm", action: "Export DXF", kind: "drawing" as const },
  export_zip: { title: "Fabrication ZIP", detail: "Package saved manufacturing files", action: "Create ZIP", kind: "archive" as const },
};
export type FileExportKind = keyof typeof FILE_EXPORTS;
export const SECONDARY_FILE_EXPORTS: readonly FileExportKind[] = ["export_drill", "export_pos", "export_dxf", "export_zip"];

/** The explorer can ship separately from the optional stencil exporters. */
export function fileExportChoices(manifest: readonly { name: string }[] | undefined): FileExportKind[] {
  const kinds: FileExportKind[] = ["export_gerbers", "export_bom"];
  if (manifest?.some(tool => tool.name === "export_commarker_copper")) kinds.unshift("export_commarker_copper");
  if (manifest?.some((tool) => tool.name === "export_laser_stencil")) kinds.unshift("export_laser_stencil");
  if (manifest?.some((tool) => tool.name === "export_stencil")) kinds.unshift("export_stencil");
  for (const kind of SECONDARY_FILE_EXPORTS) if (manifest?.some(tool => tool.name === kind)) kinds.push(kind);
  return kinds;
}

export const FILE_EXPORTS = {
  export_stencil: { title: "3D stencil", detail: "Printable STL + SVG preview", action: "Export stencil", kind: "model" as const },
  export_gerbers: { title: "Gerbers", detail: "PCB manufacturing files", action: "Export Gerbers", kind: "board" as const },
  export_bom: { title: "Bill of materials", detail: "Component list", action: "Export BOM", kind: "data" as const },
};
export type FileExportKind = keyof typeof FILE_EXPORTS;

/** The explorer can ship separately from the optional stencil exporter. */
export function fileExportChoices(manifest: readonly { name: string }[] | undefined): FileExportKind[] {
  const kinds: FileExportKind[] = ["export_gerbers", "export_bom"];
  if (manifest?.some((tool) => tool.name === "export_stencil")) kinds.unshift("export_stencil");
  return kinds;
}

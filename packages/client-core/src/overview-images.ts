import type { FileEntry, ProjectBoardSources } from "@fabdesk/protocol";

export type OverviewImage = Pick<FileEntry, "path" | "mtime"> & { kind: "top" | "render" | "pcb" | "schematic" };

/** Saved, board-specific images only. A render is not evidence of source freshness. */
export function overviewBoardImages(files: FileEntry[], options: {
  sources?: ProjectBoardSources["sources"];
  sourceId?: string;
  schematicOnly?: boolean;
} = {}): OverviewImage[] {
  const sources = options.sources ?? [];
  const selected = options.sourceId ? sources.find(row => row.source.id === options.sourceId) : undefined;
  if (options.sourceId && (!selected || selected.source.location !== "project" || !["available", "missing"].includes(selected.status))) return [];
  const prefix = selected?.source.location === "project" && selected.source.directory !== "." ? `${selected.source.directory}/` : "";
  const members = sources.flatMap(row => row.source.location === "project" ? [{ id: row.source.id, prefix: row.source.directory === "." ? "" : `${row.source.directory}/` }] : []).sort((a, b) => b.prefix.length - a.prefix.length);
  const ranked = files.flatMap(file => {
    if (/^\/|\\|(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(file.path) || !file.path.startsWith(prefix)) return [];
    const owner = members.find(row => file.path.startsWith(row.prefix));
    if (owner && owner.id !== options.sourceId) return [];
    const path = file.path.slice(prefix.length).toLowerCase();
    let kind: OverviewImage["kind"], rank: number;
    if (path === "renders/schematic.svg") { kind = "schematic"; rank = 30; }
    else if (options.schematicOnly) return [];
    else if (/^renders\/(?:top|(?:pcb|board|populated|release)[-_]top)\.(?:png|jpe?g|webp|svg)$/.test(path)) { kind = "top"; rank = 0; }
    else if (/^renders\/(?:bottom|perspective|side|front|isometric|board|pcb|(?:populated|release)[-_](?:bottom|perspective))\.(?:png|jpe?g|webp)$/.test(path)) { kind = "render"; rank = 10; }
    else if (path === "renders/pcb.svg" || selected?.previewPath === file.path) { kind = "pcb"; rank = 20; }
    else return [];
    return [{ path: file.path, mtime: file.mtime, kind, rank }];
  });
  return ranked.sort((a, b) => a.rank - b.rank || b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path)).map(({ rank: _, ...image }) => image);
}

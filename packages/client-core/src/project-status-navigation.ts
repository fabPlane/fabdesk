import type { ProjectBoardSources, SharedBoard } from "@fabdesk/protocol";
import { captureAssemblySourceSelection, type AssemblySceneSelection } from "./assembly-scene";

/** Resolve a saved-status row against current sources before opening its detail. */
export function projectStatusTarget(projectId: string, board: SharedBoard, sources: ProjectBoardSources,
  tab: "design" | "drc" | "3d", previous?: AssemblySceneSelection) {
  if (sources.projectId !== projectId) return null;
  const source = sources.sources.find(row => row.source.id === board.id);
  if (!source || source.source.location !== "project" || source.status === "blocked" || source.status === "unresolved") return null;
  if (tab === "design" && board.sourceState === "schematic-only" && sources.mode === "single") {
    return { tab: "schematic" as const, selection: null };
  }
  if (!board.sourceAvailable || source.status !== "available") return null;
  const selection = sources.mode === "assembly" ? captureAssemblySourceSelection(sources, board.id, previous) : null;
  if (sources.mode === "assembly" && !selection) return null;
  return { tab: tab === "design" ? "pcb" as const : tab, selection };
}

/** A missing source with saved board evidence is not a fresh, empty project. */
export function projectStatusIsEmpty(files: readonly { path: string }[], mode: ProjectBoardSources["mode"]): boolean {
  return mode === "single" && !files.some(({ path }) => {
    const normalized = path.replace(/\\/g, "/");
    return /\.kicad_(pcb|sch)$/i.test(normalized)
      || /(?:^|\/)renders\/(?:board|pcb|schematic)(?:[.\/-]|$)/i.test(normalized)
      || /(?:^|\/)reports\/(?:drc|erc)(?:[.\/-]|$)/i.test(normalized);
  });
}

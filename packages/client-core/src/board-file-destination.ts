import type { ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySelection } from "./assembly-scene";

/** Only open a native file through the design viewer when its exact source is declared. */
export function boardFileDestination(data: ProjectBoardSources, path: string) {
  const tab = path.endsWith(".kicad_pcb") ? "pcb" as const : path.endsWith(".kicad_sch") ? "schematic" as const : null;
  if (!tab) return null;
  if (data.mode === "single") return path === `board.kicad_${tab === "pcb" ? "pcb" : "sch"}` ? { tab, selection: null } : null;
  const source = data.sources.find(row => row.status === "available" && row.source.location === "project" && path === (tab === "pcb" ? row.pcbPath : row.schematicPath));
  const instance = source && data.assembly?.instances.find(row => row.sourceId === source.source.id);
  const selection = instance && captureAssemblySelection(data, instance.id);
  return selection ? { tab, selection } : null;
}

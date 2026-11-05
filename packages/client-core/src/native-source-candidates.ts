import type { ProjectBoardSources } from "@fabdesk/protocol";

/** Candidate files only: filenames cannot prove which schematic belongs to a PCB. */
export function nativeSourceCandidates(files: readonly { path: string }[], kind: "pcb" | "schematic", directory = ".", membership?: ProjectBoardSources): string[] {
  const prefix = directory === "." ? "" : `${directory}/`, extension = kind === "pcb" ? /\.kicad_pcb$/i : /\.kicad_sch$/i;
  const otherDirectories = membership?.sources.flatMap(record => record.source.location === "project" && record.source.directory !== directory && record.source.directory !== "." ? [`${record.source.directory}/`] : []) ?? [];
  return files.map(file => file.path).filter(path => path.startsWith(prefix) && extension.test(path) && !path.split("/").some(part => [".git", ".fabdesk", "reports", "renders", "exports", "placement", "backups"].includes(part)) && !otherDirectories.some(other => path.startsWith(other))).sort((a, b) => a.localeCompare(b)).slice(0, 30);
}

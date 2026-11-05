import type { FileEntry, ProjectBoardSources } from "@fabdesk/protocol";
import { savedOutputs } from "./output-library";

export type ReviewPackageOptions = { outputs: boolean; sources: boolean; notes: boolean; checks: boolean };
/** Explicit review files only: never auth/config, agent logs, caches, Git internals or undeclared boards. */
export function reviewPackageFiles(files: FileEntry[], scope: ProjectBoardSources, options: ReviewPackageOptions): FileEntry[] {
  const outputs = new Set(options.outputs ? savedOutputs(files, scope.mode === "assembly" ? scope.sources : []).map(file => file.path) : []);
  const directories = scope.mode === "single" ? [{ prefix: "", available: true }] : scope.sources.flatMap(row => row.source.location === "project" ? [{ prefix: row.source.directory === "." ? "" : `${row.source.directory}/`, available: row.status === "available" || row.status === "missing" }] : []).sort((a, b) => b.prefix.length - a.prefix.length);
  return files.filter(file => {
    if (file.path.includes("\\") || file.path.includes("\0") || file.path.includes(":") || file.path.split("/").some(part => !part || part === "." || part === "..")) return false;
    if (outputs.has(file.path)) return true;
    if (["fabdesk.json", "fabplane.assembly.json"].includes(file.path)) return true;
    if (options.notes && ["NOTES.md", "comments.json"].includes(file.path)) return true;
    const owner = directories.find(row => file.path.startsWith(row.prefix));
    if (!owner?.available) return false;
    const path = file.path.slice(owner.prefix.length);
    if (options.notes && ["NOTES.md", "comments.json"].includes(path)) return true;
    if (options.sources && (!path.split("/").some(part => part.startsWith(".")) && /\.(kicad_pcb|kicad_sch|kicad_pro|kicad_sym|kicad_mod)$/i.test(path) || ["circuit.netlist.json", "project.parts.json", "fp-lib-table", "sym-lib-table"].includes(path))) return true;
    return options.checks && (/^reports\/(drc|erc|board-diff|schematic-sync|checks)\.(json|md)$/.test(path) || /^renders\/diff\/.+\.svg$/.test(path));
  }).sort((a, b) => a.path.localeCompare(b.path));
}

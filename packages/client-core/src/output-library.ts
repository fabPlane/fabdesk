import type { FileEntry, ProjectBoardSources } from "@fabdesk/protocol";
export type OutputKind = "images" | "videos" | "models" | "manufacturing";

/** A library of saved deliverables, not intermediate receipts/reports or project source files. */
export function outputKind(path: string): OutputKind | null {
  if (!/^(renders|exports)\//.test(path)) return null;
  const extension = path.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension ?? "")) return "images";
  if (["mp4", "webm", "gif"].includes(extension ?? "")) return "videos";
  if (["glb", "stl", "obj", "step", "stp"].includes(extension ?? "")) return "models";
  if (["zip", "csv", "gbr", "gbl", "gtl", "gbo", "gto", "gbs", "gts", "gbp", "gtp", "gm1", "gko", "drl", "pdf", "dxf", "lbrn2", "net", "pos"].includes(extension ?? "")) return "manufacturing";
  return null;
}
export function savedOutputs(files: FileEntry[], sources: ProjectBoardSources["sources"] = []) {
  const members = sources.flatMap(row => row.status === "available" && row.source.location === "project" ? [{ sourceId: row.source.id, sourceName: row.source.name, prefix: row.source.directory === "." ? "" : `${row.source.directory}/` }] : []).sort((a, b) => b.prefix.length - a.prefix.length);
  return files.flatMap(file => {
    const member = members.find(row => file.path.startsWith(row.prefix) && outputKind(file.path.slice(row.prefix.length)));
    const kind = member ? outputKind(file.path.slice(member.prefix.length)) : outputKind(file.path);
    return kind ? [{ ...file, kind, ...(member ? { sourceId: member.sourceId, sourceName: member.sourceName } : {}) }] : [];
  }).sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
}

/** Keep large native layer-file sets from overwhelming All; every row remains in Manufacturing. */
export function outputLibrarySections<T extends { path: string; kind: OutputKind }>(files: T[], groupDetails: boolean) {
  const individual = groupDetails ? files.filter(file => file.kind === "manufacturing" && /(?:^|\/)exports\/(?:gerbers|dxf)\//.test(file.path)) : [];
  if (individual.length <= 6) return { cards: files, manufacturingFiles: [] as T[] };
  const paths = new Set(individual.map(file => file.path));
  return { cards: files.filter(file => !paths.has(file.path)), manufacturingFiles: individual };
}

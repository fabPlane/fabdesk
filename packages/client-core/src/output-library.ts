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
  // A missing PCB does not delete saved deliverables from a declared directory.
  // Blocked/undeclared directories still cannot establish an output source.
  const members = sources.flatMap(row => row.source.location === "project" ? [{ sourceId: row.source.id, sourceName: row.source.name, prefix: row.source.directory === "." ? "" : `${row.source.directory}/`, browsable: row.status === "available" || row.status === "missing" }] : []).sort((a, b) => b.prefix.length - a.prefix.length);
  return files.flatMap(file => {
    // A nested declaration owns its directory even when blocked; do not relabel it as its parent.
    const member = members.find(row => file.path.startsWith(row.prefix));
    if (member && !member.browsable) return [];
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

/** Filter already-qualified outputs; never infer source membership from a search or file name. */
export function filterSavedOutputs<T extends { path: string; kind: OutputKind; sourceId?: string; sourceName?: string }>(files: T[], options: { query?: string; kind?: OutputKind | "all"; sourceId?: string | null } = {}): T[] {
  const terms = (options.query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return files.filter(file => {
    if (options.kind && options.kind !== "all" && file.kind !== options.kind) return false;
    if (options.sourceId === null ? !!file.sourceId : options.sourceId !== undefined && file.sourceId !== options.sourceId) return false;
    const text = [file.path, file.sourceId ?? "", file.sourceName ?? "", file.kind].join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

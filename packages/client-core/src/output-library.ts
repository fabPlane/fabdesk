import { savedOutputKind as outputKind } from "@fabdesk/protocol";
import type { FileEntry, ProjectBoardSources } from "@fabdesk/protocol";
export type OutputKind = "images" | "videos" | "models" | "manufacturing";
/** Effective chronology keeps a labelled file-time fallback for untracked/legacy artifacts. */
export function outputTime(file: Pick<FileEntry, "mtime" | "generatedAt">) {
  const generated = file.generatedAt && Number.isFinite(Date.parse(file.generatedAt));
  const value = generated ? file.generatedAt! : file.mtime;
  return { value, ms: Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0, basis: generated ? "exported" as const : "file-saved" as const };
}

/** A library of saved deliverables, not intermediate receipts/reports or project source files. */
export { savedOutputKind as outputKind } from "@fabdesk/protocol";
export function savedOutputs(files: FileEntry[], sources: ProjectBoardSources["sources"] = []) {
  // A missing PCB does not delete saved deliverables from a declared directory.
  // Blocked/undeclared directories still cannot establish an output source.
  const members = sources.flatMap(row => row.source.location === "project" ? [{ sourceId: row.source.id, sourceName: row.source.name, prefix: row.source.directory === "." ? "" : `${row.source.directory}/`, browsable: row.status === "available" || row.status === "missing" }] : []).sort((a, b) => b.prefix.length - a.prefix.length);
  const outputs = files.flatMap(file => {
    // A nested declaration owns its directory even when blocked; do not relabel it as its parent.
    const member = members.find(row => file.path.startsWith(row.prefix));
    if (member && !member.browsable) return [];
    const kind = member ? outputKind(file.path.slice(member.prefix.length)) : outputKind(file.path);
    return kind && !(kind === "videos" && file.size === 0) ? [{ ...file, kind, ...(member ? { sourceId: member.sourceId, sourceName: member.sourceName } : {}) }] : [];
  });
  const completedVideos = new Set(outputs.filter(file => file.kind === "videos" && /(?:^|\/)exports\/product-video\.(mp4|webm|gif)$/i.test(file.path)).map(file => file.path.replace(/\.[^.]+$/, "")));
  return outputs.filter(file => !/(?:^|\/)exports\/product-video-poster\.png$/i.test(file.path) || !completedVideos.has(file.path.replace(/-poster\.png$/i, "")))
    .sort((a, b) => outputTime(b).ms - outputTime(a).ms || a.path.localeCompare(b.path));
}

export type SavedOutput = ReturnType<typeof savedOutputs>[number];
/** Present format variants together, keeping exact paths and all downloads accessible. */
export function outputCards(files: SavedOutput[], groupManufacturing = true) {
  const grouped = new Map<string, SavedOutput[]>();
  for (const file of files) {
    let key = file.path;
    if (file.kind === "videos" && /(?:^|\/)exports\/product-video\.(mp4|webm|gif)$/i.test(key)) key = key.replace(/\.[^.]+$/, "");
    else if (file.kind === "images" && /(?:^|\/)renders\/schematic(?:\.(png|svg)|\/)/.test(key)) key = key.replace(/renders\/schematic(?:\..*|\/.*)$/, "renders/schematic");
    else if (groupManufacturing && file.kind === "manufacturing" && /(?:^|\/)exports\/(gerbers|dxf)\//.test(key)) key = key.replace(/\/(?:gerbers|dxf)\/.*$/, "/manufacturing-layers");
    else if (file.kind === "images") key = key.replace(/\.(png|svg|jpe?g|webp)$/i, "");
    const list = grouped.get(key) ?? []; list.push(file); grouped.set(key, list);
  }
  // Posters are supporting assets of a completed product video. They remain in
  // Files, and remain ordinary cards when there is no completed video to open.
  for (const [key] of grouped) {
    if (/\/product-video-poster$/.test(key) && grouped.has(key.replace(/-poster$/, ""))) grouped.delete(key);
  }
  return [...grouped.entries()].map(([key, variants]) => {
    const files = [...variants].sort((a, b) => {
      const rank = (f: SavedOutput) => f.path.endsWith(".mp4") ? 0 : /renders\/schematic\.svg$/.test(f.path) ? 0 : f.path.endsWith(".svg") ? 1 : f.path.endsWith(".webm") ? 1 : 2;
      return rank(a) - rank(b) || a.path.localeCompare(b.path);
    });
    const label = /\/product-video$/.test(key) ? "Product video"
      : /(?:^|\/)renders\/schematic$/.test(key) ? "Schematic"
      : /\/manufacturing-layers$/.test(key) ? "Manufacturing layers"
      : /(?:^|\/)renders\/pcb$/.test(key) ? "PCB drawing"
      : /(?:^|\/)renders\/board\.glb$/.test(key) ? "Board model"
      : /(?:^|\/)renders\/top$/.test(key) ? "Top view image"
      : /(?:^|\/)renders\/bottom$/.test(key) ? "Bottom view image"
      : files[0]!.path.split("/").pop()!;
    const time = variants.map(outputTime).sort((a, b) => b.ms - a.ms || (a.basis === b.basis ? 0 : a.basis === "exported" ? -1 : 1))[0]!;
    return { key, files, primary: files[0]!, mtime: variants.reduce((date, file) => file.mtime > date ? file.mtime : date, ""), time, label };
  }).sort((a, b) => b.time.ms - a.time.ms || a.key.localeCompare(b.key));
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

import type { FileEntry } from "@fabdesk/protocol";
export type OutputKind = "images" | "videos" | "models" | "manufacturing";

/** A library of saved deliverables, not intermediate receipts/reports or project source files. */
export function outputKind(path: string): OutputKind | null {
  if (!/^(renders|exports)\//.test(path)) return null;
  const extension = path.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension ?? "")) return "images";
  if (["mp4", "webm", "gif"].includes(extension ?? "")) return "videos";
  if (["glb", "stl", "obj", "step", "stp"].includes(extension ?? "")) return "models";
  if (["zip", "csv", "gbr", "gbl", "gtl", "gbo", "gto", "gbs", "gts", "gko", "drl", "pdf", "dxf", "lbrn2", "net", "pos"].includes(extension ?? "")) return "manufacturing";
  return null;
}
export function savedOutputs(files: FileEntry[]) {
  return files.flatMap(file => { const kind = outputKind(file.path); return kind ? [{ ...file, kind }] : []; }).sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
}

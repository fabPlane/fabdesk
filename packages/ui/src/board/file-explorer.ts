export type FileKind = "board" | "schematic" | "code" | "text" | "data" | "image" | "video" | "drawing" | "model" | "archive" | "file";
export type PreviewKind = "text" | "image" | "video" | "none";

/** Unknown and potentially binary formats must not be fetched as UTF-8 text. */
export function fileAppearance(path: string): { kind: FileKind; label: string; preview: PreviewKind } {
  const name = path.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (ext === "kicad_pcb") return { kind: "board", label: "PCB", preview: "text" };
  if (ext === "kicad_sch") return { kind: "schematic", label: "SCH", preview: "text" };
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "ico", "avif"].includes(ext)) return { kind: "image", label: ext.toUpperCase(), preview: "image" };
  if (["mp4", "webm"].includes(ext)) return { kind: "video", label: ext.toUpperCase(), preview: "video" };
  if (["stl", "step", "stp", "3mf", "glb", "gltf", "obj", "fcstd"].includes(ext)) return { kind: "model", label: ext.toUpperCase(), preview: "none" };
  if (["dxf", "dwg", "pdf"].includes(ext)) return { kind: "drawing", label: ext.toUpperCase(), preview: "none" };
  if (["zip", "gz", "7z", "rar", "tar"].includes(ext)) return { kind: "archive", label: ext.toUpperCase(), preview: "none" };
  if (["ts", "tsx", "js", "jsx", "py", "c", "h", "cpp", "rs", "go", "sh", "ps1", "html", "css", "scad"].includes(ext)) return { kind: "code", label: "CODE", preview: "text" };
  if (["json", "yaml", "yml", "toml", "xml", "csv", "tsv", "lbrn", "lbrn2", "kicad_pro", "kicad_prl", "kicad_sym", "kicad_mod", "gbr", "gbrjob", "gbl", "gtl", "gtp", "gbp", "gts", "gbs", "gto", "gbo", "gm1", "drl", "net", "d356", "ipc2581"].includes(ext)) return { kind: "data", label: ext.toUpperCase(), preview: "text" };
  if (["txt", "md", "log", "ini", "cfg", "gitignore"].includes(ext) || ["readme", "license", "dockerfile", "makefile", "fp-lib-table", "sym-lib-table"].includes(name)) return { kind: "text", label: ext.toUpperCase() || "TXT", preview: "text" };
  return { kind: "file", label: ext.toUpperCase() || "FILE", preview: "none" };
}

export interface ExplorerFile { path: string; size: number }
export type ExplorerNode = { name: string; path: string; children: ExplorerNode[]; file?: ExplorerFile };

/** Keep the original file path for reads, while grouping both path separator styles. */
export function buildFileTree(files: readonly ExplorerFile[], query = ""): ExplorerNode[] {
  const root: ExplorerNode = { name: "", path: "", children: [] };
  const folders = new Map<string, ExplorerNode>([["", root]]);
  const needle = query.trim().toLowerCase();
  for (const file of files) {
    const normalized = file.path.replaceAll("\\", "/");
    if (needle && !normalized.toLowerCase().includes(needle)) continue;
    const parts = normalized.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let parent = root;
    for (const part of parts) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      let folder = folders.get(path);
      if (!folder) {
        folder = { name: part, path, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ name, path: normalized, children: [], file });
  }
  function sort(nodes: ExplorerNode[]): ExplorerNode[] {
    nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const node of nodes) sort(node.children);
    return nodes;
  }
  return sort(root.children);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

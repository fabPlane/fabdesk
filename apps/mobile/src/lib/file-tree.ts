/**
 * A project's flat file list as a tree, and what to do with each file when tapped.
 *
 * The daemon lists files as `{ path, size, mtime }` with no directory entries; directories are
 * implied by the paths. Rows for the screen come from `flattenTree`, which walks only expanded
 * directories, so the FlatList never holds more than what is visible.
 */
import type { FileEntry } from "@fabdesk/protocol";

export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  /** Files anywhere beneath this directory. */
  fileCount: number;
  /** Bytes anywhere beneath this directory. */
  size: number;
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  entry: FileEntry;
}

export type TreeNode = DirNode | FileNode;

export function buildFileTree(files: FileEntry[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [], fileCount: 0, size: 0 };
  const dirs = new Map<string, DirNode>([["", root]]);

  const dirFor = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = dirFor(slash === -1 ? "" : path.slice(0, slash));
    const node: DirNode = {
      kind: "dir",
      name: path.slice(slash + 1),
      path,
      children: [],
      fileCount: 0,
      size: 0,
    };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const entry of files) {
    const clean = entry.path.replace(/^\/+/, "");
    if (!clean) continue;
    const slash = clean.lastIndexOf("/");
    const dir = dirFor(slash === -1 ? "" : clean.slice(0, slash));
    dir.children.push({ kind: "file", name: clean.slice(slash + 1), path: clean, entry });
    // Roll the file up into every ancestor, root included.
    for (let d: DirNode | undefined = dir; d; d = parentOf(d)) {
      d.fileCount += 1;
      d.size += entry.size;
    }
  }

  function parentOf(d: DirNode): DirNode | undefined {
    if (d.path === "") return undefined;
    const slash = d.path.lastIndexOf("/");
    return dirs.get(slash === -1 ? "" : d.path.slice(0, slash));
  }

  const sortNode = (n: DirNode) => {
    n.children.sort(
      (a, b) =>
        (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    for (const c of n.children) if (c.kind === "dir") sortNode(c);
  };
  sortNode(root);
  return root;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Depth-first rows for the visible part of the tree: children of a directory only when it is expanded. */
export function flattenTree(root: DirNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: DirNode, depth: number) => {
    for (const node of dir.children) {
      const open = node.kind === "dir" && expanded.has(node.path);
      rows.push({ node, depth, expanded: open });
      if (node.kind === "dir" && open) walk(node, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Directories worth opening on first visit: the top level, so the screen is not one row of folders. */
export function initialExpanded(root: DirNode): Set<string> {
  return new Set(root.children.filter((c): c is DirNode => c.kind === "dir").map((c) => c.path));
}

/** Everything that would need to be expanded for `path` to be visible. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export type FileKind = "image" | "markdown" | "text" | "binary";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const BINARY = /\.(glb|gltf|zip|gz|tgz|pdf|step|stp|wrl|bin|exe|dylib|so|woff2?|ttf|otf)$/i;

export function fileKind(path: string): FileKind {
  if (IMAGE.test(path)) return "image";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (BINARY.test(path)) return "binary";
  return "text";
}

/** Same ceiling as the desktop's FilesTab: beyond this a file is described, not shown. */
export const MAX_TEXT_BYTES = 1_000_000;

export type Language = "ts" | "json" | "sexpr" | "markdown" | "plain";

/** What the highlighter should treat the file as. KiCad's formats are s-expressions. */
export function languageFor(path: string): Language {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "ts";
    case "json":
    case "kicad_pro":
    case "kicad_prl":
      return "json";
    case "kicad_pcb":
    case "kicad_sch":
    case "kicad_sym":
    case "kicad_mod":
    case "kicad_wks":
    case "net":
    case "lisp":
    case "scm":
      return "sexpr";
    case "md":
    case "markdown":
      return "markdown";
    default:
      return "plain";
  }
}

/** Whether the phone may write it back: text the agents also edit, nothing the daemon owns. */
export function isEditable(path: string, size: number): boolean {
  if (path === "fabdesk.json") return false; // the manifest goes through PATCH /projects/:id
  if (size > MAX_TEXT_BYTES) return false;
  return fileKind(path) === "text" || fileKind(path) === "markdown";
}

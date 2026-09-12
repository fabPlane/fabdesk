/** Picking a board image out of a project's file list. */
import type { FileEntry, ProjectDetail } from "@fabdesk/protocol";

const IMAGE = /\.(png|jpe?g)$/i;

/** Renders the daemon has produced, newest first. `renders/` is where every render tool writes. */
export function renderImages(project: ProjectDetail | undefined): FileEntry[] {
  if (!project) return [];
  return project.files
    .filter((f) => f.path.startsWith("renders/") && IMAGE.test(f.path))
    .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
}

/** The one to show as the board preview: the top view if there is one, else the newest render. */
export function preferredRender(project: ProjectDetail | undefined): FileEntry | null {
  const images = renderImages(project);
  return images.find((f) => /\btop\b/i.test(f.path)) ?? images[0] ?? null;
}

export function hasBoard(project: ProjectDetail | undefined): boolean {
  return !!project?.files.some((f) => f.path.endsWith(".kicad_pcb"));
}

/** The views `render_board` knows, in the order a gallery should page through them. */
export const VIEW_ORDER = ["top", "bottom", "perspective", "side"] as const;
export type BoardView = (typeof VIEW_ORDER)[number];

/** `renders/top.png` → `top`; anything else is named after its file. */
export function renderView(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return base || path;
}

export function isBoardView(view: string): view is BoardView {
  return (VIEW_ORDER as readonly string[]).includes(view);
}

/**
 * Gallery order: the known views first, in `VIEW_ORDER`, then everything else by name — a stable
 * order, unlike the newest-first list, so a page keeps its index when a re-render lands.
 */
export function galleryRenders(project: ProjectDetail | undefined): FileEntry[] {
  const rank = (f: FileEntry) => {
    const i = (VIEW_ORDER as readonly string[]).indexOf(renderView(f.path));
    return i === -1 ? VIEW_ORDER.length : i;
  };
  return [...renderImages(project)].sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path),
  );
}

/** What the daemon kept of a render before it was overwritten, as this app cached it. */
export interface PreviousRender {
  /** Local file URI of the cached image. */
  uri: string;
  /** `mtime` of the render at the time it was cached. */
  mtime: string;
}

/**
 * Whether a cached copy is genuinely the "before" of the current file: the daemon keeps one file
 * per view, so the only signal that a re-render happened is a newer mtime. Same mtime means the
 * cache was taken and nothing has been rendered since — no comparison to show.
 */
export function isPreviousRender(
  current: FileEntry,
  cached: PreviousRender | null | undefined,
): cached is PreviousRender {
  if (!cached) return false;
  const before = Date.parse(cached.mtime);
  const now = Date.parse(current.mtime);
  return Number.isFinite(before) && Number.isFinite(now) && before < now;
}

/** One cache file per project + render path; the path's separators would otherwise nest. */
export function previousRenderKey(projectId: string, path: string): string {
  return `${projectId}__${path.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
}

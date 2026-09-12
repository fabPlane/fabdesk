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

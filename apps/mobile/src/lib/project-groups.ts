/**
 * Projects grouped by the folder they live in on the computer.
 *
 * The daemon's `/folders` are thread folders (`Thread.folderId`); a project carries no folder id,
 * so the only grouping the data supports is the directory of its `path` — which is also what a
 * person means by "the boards in ~/fabdesk" versus "the ones I imported into ~/work". One group
 * means no headers.
 */
import type { ProjectSummary } from "@fabdesk/protocol";

export interface ProjectGroup {
  /** Parent directory, as the daemon reports it. */
  dir: string;
  /** `dir` with the home directory shortened to `~`. */
  title: string;
  projects: ProjectSummary[];
}

export function parentDir(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return cut <= 0 ? "/" : clean.slice(0, cut);
}

/** `/Users/maya/fabdesk` → `~/fabdesk`; `/home/maya` → `~`; other paths unchanged. */
export function shortenHome(dir: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/.exec(dir);
  if (!m) return dir;
  const rest = dir.slice(m[0].length);
  return rest ? `~${rest}` : "~";
}

/** Groups sorted by title; projects newest-changed first inside each. */
export function groupProjectsByFolder(projects: ProjectSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectSummary[]>();
  for (const p of projects) {
    const dir = parentDir(p.path);
    const list = groups.get(dir) ?? [];
    list.push(p);
    groups.set(dir, list);
  }
  return [...groups.entries()]
    .map(([dir, list]) => ({
      dir,
      title: shortenHome(dir),
      projects: [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

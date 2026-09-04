import type { ProjectSummary, Thread } from "@fabdesk/protocol";

export type ProjectThreadGroupKind = "pinned" | "unassigned" | "project";

export type ProjectThreadGroup = {
  key: string;
  title: string;
  kind: ProjectThreadGroupKind;
  projectId: string | null;
  threads: Thread[];
};

/**
 * Sidebar list order: pinned first, then threads with no project, then
 * project groups (A–Z). Pinned threads are not repeated under a project.
 */
export function groupThreadsByProject(threads: readonly Thread[], projects: readonly ProjectSummary[]): ProjectThreadGroup[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byProject = new Map<string, Thread[]>();
  const pinned: Thread[] = [];
  const unassigned: Thread[] = [];
  for (const thread of threads) {
    if (thread.archived) continue;
    if (thread.pinned) {
      pinned.push(thread);
      continue;
    }
    if (!thread.projectId) {
      unassigned.push(thread);
      continue;
    }
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  const groups: ProjectThreadGroup[] = [];
  if (pinned.length) groups.push({ key: "pinned", title: "Pinned", kind: "pinned", projectId: null, threads: pinned });
  if (unassigned.length) groups.push({ key: "unassigned", title: "No project", kind: "unassigned", projectId: null, threads: unassigned });
  groups.push(
    ...[...byProject.entries()]
      .map(([projectId, items]) => ({
        key: projectId,
        title: names.get(projectId) ?? "Unknown project",
        kind: "project" as const,
        projectId,
        threads: items,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  return groups;
}

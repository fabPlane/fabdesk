import type { ProjectSummary, Thread } from "@fabdesk/protocol";

export type ProjectThreadGroup = {
  key: string;
  title: string;
  projectId: string | null;
  threads: Thread[];
};

/** Conversations grouped by project, unassigned last. */
export function groupThreadsByProject(threads: readonly Thread[], projects: readonly ProjectSummary[]): ProjectThreadGroup[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byProject = new Map<string, Thread[]>();
  const unassigned: Thread[] = [];
  for (const thread of threads) {
    if (thread.archived) continue;
    if (!thread.projectId) {
      unassigned.push(thread);
      continue;
    }
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  // Remixed (and newly created) projects have zero threads until the first chat.
  // Still list them so Remix can select the clone immediately.
  const projectIds = new Set([...byProject.keys(), ...projects.map((p) => p.id)]);
  const groups: ProjectThreadGroup[] = [...projectIds]
    .map((projectId) => ({
      key: projectId,
      title: names.get(projectId) ?? "Unknown project",
      projectId,
      threads: byProject.get(projectId) ?? [],
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (unassigned.length) groups.push({ key: "unassigned", title: "No project", projectId: null, threads: unassigned });
  return groups;
}

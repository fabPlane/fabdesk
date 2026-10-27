import type { CoreClient } from "./CoreClient";

export const DRAFT_KEY_NEW = "__new__";

/** Unsent conversations belong to their project, even before a thread exists. */
export function newChatDraftKey(projectId: string | null): string {
  return projectId ? `${DRAFT_KEY_NEW}:${projectId}` : DRAFT_KEY_NEW;
}

/** A save session owns its destination: retries never create a second project. */
export function createSketchDraftSession({ client, projectId: initialProjectId, onProjectCreated }: {
  client: Pick<CoreClient, "createProject" | "uploadSketch">;
  projectId: string | null;
  onProjectCreated: (projectId: string) => void;
}) {
  let projectId = initialProjectId;
  let creating: Promise<string> | null = null;
  const ensureProject = (): Promise<string> => {
    if (projectId) return Promise.resolve(projectId);
    if (!creating) {
      creating = client.createProject("Untitled project").then((project) => {
        projectId = project.id;
        onProjectCreated(project.id);
        return project.id;
      }).finally(() => { creating = null; });
    }
    return creating;
  };
  return {
    get projectId() { return projectId; },
    async save(file: Blob, name: string) {
      const id = await ensureProject();
      const result = await client.uploadSketch(id, file, name);
      return { ...result, projectId: id };
    },
  };
}

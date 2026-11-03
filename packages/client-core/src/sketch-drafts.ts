import type { CoreClient } from "./CoreClient";

export const DRAFT_KEY_NEW = "__new__";

/** Unsent conversations belong to their project, even before a thread exists. */
export function newChatDraftKey(projectId: string | null): string {
  return projectId ? `${DRAFT_KEY_NEW}:${projectId}` : DRAFT_KEY_NEW;
}

/** A save session owns its destination: retries never create a second project. */
export function createSketchDraftSession({ client, projectId: initialProjectId, onProjectCreated }: {
  client: Pick<CoreClient, "uploadSketch"> & { createIdeaDraft: CoreClient["createIdeaDraft"] };
  projectId: string | null;
  onProjectCreated: (projectId: string) => void;
}) {
  let projectId = initialProjectId;
  let creating: Promise<string> | null = null;
  const originals = new WeakMap<Blob, Promise<{ path: string }>>();
  const ensureProject = (): Promise<string> => {
    if (projectId) return Promise.resolve(projectId);
    if (!creating) {
      creating = client.createIdeaDraft().then((project) => {
        projectId = project.id;
        onProjectCreated(project.id);
        return project.id;
      }).finally(() => { creating = null; });
    }
    return creating;
  };
  return {
    get projectId() { return projectId; },
    async save(file: Blob, name: string, source?: { file: Blob; name: string }) {
      const id = await ensureProject();
      let sourcePath: string | undefined;
      if (source) {
        let saving = originals.get(source.file);
        if (!saving) {
          saving = client.uploadSketch(id, source.file, source.name).catch(error => { originals.delete(source.file); throw error; });
          originals.set(source.file, saving);
        }
        sourcePath = (await saving).path;
      }
      const result = await client.uploadSketch(id, file, name);
      return { ...result, projectId: id, ...(sourcePath ? { sourcePath } : {}) };
    },
  };
}

/** Offer reserved scene-export names, not ordinary references; opening still validates their contents. */
export function editableSketchPaths(files: ReadonlyArray<{ path: string }>): string[] {
  return files.map(file => file.path).filter(path => /^sketches\/[^/\\]+(?:\.excalidraw(?:-\d+)?\.png|\.excalidraw)$/i.test(path)).sort().reverse();
}

/** Saved visual references, including rendered editable sketches; never treat these as native boards. */
export function projectSketchImagePaths(files: ReadonlyArray<{ path: string }>): string[] {
  return files.map(file => file.path).filter(path => /^sketches\/[^/\\]+\.(?:png|jpe?g)$/i.test(path)).sort().reverse();
}

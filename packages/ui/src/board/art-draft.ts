import { resolveArtOptions, type ArtOptions } from "@fabdesk/board-art";
import { CoreHttpError, PersistentDraft, localDraft, type CoreClient } from "@fabdesk/client-core";

export type ArtDraft = {
  version: 1;
  source: string | null;
  sourceName: string | null;
  options: ArtOptions;
};
export const ART_DRAFT_PATH = "board-art/draft.json";
const stores = new WeakMap<CoreClient, Map<string, PersistentDraft<ArtDraft>>>();

export function parseArtDraft(text: string): ArtDraft {
  const draft = JSON.parse(text) as ArtDraft;
  if (
    draft.version !== 1 ||
    (draft.source !== null && typeof draft.source !== "string") ||
    (draft.sourceName !== null && typeof draft.sourceName !== "string")
  )
    throw new Error("Unsupported Board Art draft.");
  resolveArtOptions(draft.options);
  return draft;
}

export function artDraftStore(
  client: CoreClient,
  projectId: string | null,
): PersistentDraft<ArtDraft> {
  let map = stores.get(client);
  if (!map) {
    map = new Map();
    stores.set(client, map);
  }
  const key = projectId ?? "unassigned";
  let store = map.get(key);
  if (!store) {
    store = new PersistentDraft<ArtDraft>({
      read: async () => {
        if (!projectId) return localDraft<ArtDraft>(`${client.baseUrl}:unassigned`);
        try {
          return parseArtDraft(await client.readFile(projectId, ART_DRAFT_PATH));
        } catch (error) {
          if (error instanceof CoreHttpError && error.status === 404) return null;
          throw error;
        }
      },
      write: async (draft) => {
        if (!projectId) {
          await localDraft(`${client.baseUrl}:unassigned`, draft);
          return;
        }
        await client.writeFile(projectId, ART_DRAFT_PATH, JSON.stringify(draft));
      },
    });
    map.set(key, store);
  }
  return store;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}
export function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

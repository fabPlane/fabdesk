import { BOARD_ARTWORK_PATH, SavedBoardArtwork, BoardArtworkSettings, BoardArtworkView } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";

type ArtworkFiles = Pick<CoreClient, "readFileBlob" | "writeFile">;
async function readOptional(client: ArtworkFiles, projectId: string): Promise<string | null> {
  try { return await (await client.readFileBlob(projectId, BOARD_ARTWORK_PATH)).text(); }
  catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; }
}
async function sha256(image: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await image.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadBoardArtwork(client: ArtworkFiles, projectId: string) {
  const text = await readOptional(client, projectId);
  if (text === null) return null;
  const record = SavedBoardArtwork.parse(JSON.parse(text));
  if (record.owner.projectId !== projectId) throw new Error("Saved artwork belongs to another project. It was not opened.");
  const image = await client.readFileBlob(projectId, record.source.path);
  if (image.size !== record.source.bytes || await sha256(image) !== record.source.sha256) throw new Error("Saved artwork image changed or is incomplete. Your draft was not replaced.");
  return { record, text, image };
}

/** Writes art data only. It never creates, replaces or applies a native PCB. Not an atomic filesystem transaction. */
export async function saveBoardArtwork({ client, projectId, image, name, settings, view, expectedText }: {
  client: ArtworkFiles; projectId: string; image: Blob; name: string;
  settings: BoardArtworkSettings; view: BoardArtworkView; expectedText: string | null;
}) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (!extension || !["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) throw new Error("Choose a PNG, JPG, WebP or GIF artwork source.");
  const savedSettings = BoardArtworkSettings.parse(settings), savedView = BoardArtworkView.parse(view);
  if (image.size < 1 || image.size > 12 * 1024 * 1024) throw new Error("Choose artwork between 1 byte and 12 MB.");
  const hash = await sha256(image);
  // Parsing copies the options before awaiting any writes; caller edits cannot change this save.
  const record = SavedBoardArtwork.parse({ contract: "fabplane.board-artwork.v1", owner: { projectId, board: "root" }, source: { path: `artwork/sources/${hash}.${extension}`, name: name.split(/[\\/]/).pop(), sha256: hash, bytes: image.size }, settings: savedSettings, view: savedView, savedAt: new Date().toISOString() });
  const text = JSON.stringify(record, null, 2) + "\n";
  const assertUnchanged = async () => { if (await readOptional(client, projectId) !== expectedText) throw new Error("Saved artwork changed elsewhere. Keep this draft and review the saved version before replacing it."); };
  await assertUnchanged();
  await client.writeFile(projectId, record.source.path, image);
  const written = await client.readFileBlob(projectId, record.source.path);
  if (written.size !== image.size || await sha256(written) !== hash) throw new Error("Artwork image could not be verified after saving. Your draft is still available.");
  await assertUnchanged();
  await client.writeFile(projectId, BOARD_ARTWORK_PATH, text);
  if (await readOptional(client, projectId) !== text) throw new Error("Artwork settings could not be verified after saving. Your draft is still available.");
  return { record, text, image };
}

export interface ArtworkSessionDraft {
  image: Blob; name: string; settings: BoardArtworkSettings; view: BoardArtworkView;
  pendingProjectId?: string;
  boardPreview?: boolean;
  baseText: string | null; savedImage: Blob | null; savedSettings: string | null;
}
/** In-memory image drafts; chat ids never participate in project ownership. */
export function createArtworkSessionStore() {
  const drafts = new Map<string, ArtworkSessionDraft>();
  const key = (endpoint: string, projectId: string | null) => JSON.stringify([endpoint, projectId]);
  const copy = (draft: ArtworkSessionDraft): ArtworkSessionDraft => ({ ...draft, settings: structuredClone(draft.settings), view: { ...draft.view } });
  return {
    get(endpoint: string, projectId: string | null) { const draft = drafts.get(key(endpoint, projectId)); return draft ? copy(draft) : null; },
    set(endpoint: string, projectId: string | null, draft: ArtworkSessionDraft) { drafts.set(key(endpoint, projectId), copy(draft)); },
    remove(endpoint: string, projectId: string | null) { drafts.delete(key(endpoint, projectId)); },
  };
}
export const artworkSessions = createArtworkSessionStore();

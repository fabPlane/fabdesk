import { ProductVideoInputRevision, PRODUCT_VIDEO_MANIFEST_PATH } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { inspectBoardModelRevision } from "./board-model-revision";
import { sha256Blob } from "./pcb-preview-revision";

export type VideoInputRevisionState = "inputs-unchanged" | "inputs-changed" | "artifact-changed" | "missing-input" | "missing-artifact" | "untracked" | "board-source-changed" | "board-source-unverified";

export const videoInputsNeedReview = (state: VideoInputRevisionState | undefined) => ["inputs-changed", "artifact-changed", "missing-input", "missing-artifact", "board-source-changed", "board-source-unverified"].includes(state ?? "");

/** Follow recorded mesh/video bytes and the canonical board model’s explicit PCB receipt. Other dependencies, captions and new scene content remain unverified. */
export async function inspectVideoInputRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string, path: string): Promise<VideoInputRevisionState> {
  let raw: unknown;
  try {
    const text = await client.readFile(projectId, PRODUCT_VIDEO_MANIFEST_PATH);
    try { raw = JSON.parse(text); } catch { return "untracked"; }
  } catch (error) {
    if (error instanceof CoreHttpError && error.status === 404) return "untracked";
    throw error;
  }
  const parsed = ProductVideoInputRevision.safeParse(raw && typeof raw === "object" && "revision" in raw ? raw.revision : null);
  if (!parsed.success) return "untracked";
  const artifact = parsed.data.outputs.find(row => row.path === path);
  if (!artifact) return "untracked";
  const identity = async (file: string): Promise<string | null> => {
    try { return await sha256Blob(await client.readFileBlob(projectId, file)); }
    catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; }
  };
  const actual = await identity(artifact.path);
  if (actual === null) return "missing-artifact";
  if (actual !== artifact.sha256) return "artifact-changed";
  // Sequential reads avoid loading every large model concurrently.
  let changed = false;
  for (const input of parsed.data.inputs) {
    const hash = await identity(input.path);
    if (hash === null) return "missing-input";
    if (hash !== input.sha256) changed = true;
  }
  if (changed) return "inputs-changed";
  if (parsed.data.inputs.some(input => input.path === "renders/board.glb")) {
    // Reuse the saved model's byte checks; a retained GLB can still precede a changed PCB.
    const board = await inspectBoardModelRevision(client, projectId);
    if (board === "source-changed") return "board-source-changed";
    if (board !== "source-unchanged") return "board-source-unverified";
  }
  return "inputs-unchanged";
}

import { BoardModelRevision, BOARD_MODEL_REVISION_PATH } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

export type BoardModelRevisionState = "source-unchanged" | "source-changed" | "artifact-changed" | "untracked" | "missing-source" | "missing-artifact";

/** Saved PCB/artifact identity only; component model files and physical compatibility remain unverified. */
export async function inspectBoardModelRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string): Promise<BoardModelRevisionState> {
  let raw: unknown;
  try {
    const text = await client.readFile(projectId, BOARD_MODEL_REVISION_PATH);
    try { raw = JSON.parse(text); } catch { return "untracked"; }
  } catch (error) {
    if (error instanceof CoreHttpError && error.status === 404) return "untracked";
    throw error;
  }
  const receipt = BoardModelRevision.safeParse(raw);
  if (!receipt.success) return "untracked";
  const read = async (path: string) => {
    try { return await client.readFileBlob(projectId, path); }
    catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; }
  };
  const [source, artifact] = await Promise.all([read(receipt.data.source), read(receipt.data.artifact)]);
  if (!source) return "missing-source";
  if (!artifact) return "missing-artifact";
  const [sourceHash, artifactHash] = await Promise.all([sha256Blob(source), sha256Blob(artifact)]);
  if (artifactHash !== receipt.data.artifactSha256) return "artifact-changed";
  return sourceHash === receipt.data.sourceSha256 ? "source-unchanged" : "source-changed";
}

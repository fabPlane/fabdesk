import { PcbPreviewRevision, PCB_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";

export type PcbPreviewState = "matches-source" | "source-changed" | "artifact-changed" | "untracked" | "missing-source" | "missing-artifact";

export async function sha256Blob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare bytes, never timestamps. Older previews remain unverified until explicitly regenerated. */
export async function inspectPcbPreviewRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string): Promise<PcbPreviewState> {
  let raw: unknown;
  try {
    const text = await client.readFile(projectId, PCB_PREVIEW_REVISION_PATH);
    try { raw = JSON.parse(text); } catch { return "untracked"; }
  } catch (error) {
    if (error instanceof CoreHttpError && error.status === 404) return "untracked";
    throw error;
  }
  const parsed = PcbPreviewRevision.safeParse(raw);
  if (!parsed.success) return "untracked";
  const receipt = parsed.data;
  const read = async (path: string) => {
    try { return await client.readFileBlob(projectId, path); }
    catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; }
  };
  const [source, artifact] = await Promise.all([read(receipt.source), read(receipt.artifact)]);
  if (!source) return "missing-source";
  if (!artifact) return "missing-artifact";
  const [sourceHash, artifactHash] = await Promise.all([sha256Blob(source), sha256Blob(artifact)]);
  if (artifactHash !== receipt.artifactSha256) return "artifact-changed";
  return sourceHash === receipt.sourceSha256 ? "matches-source" : "source-changed";
}

import { AssemblyBoardModelRevision, ProjectBoardSources, ProductVideoInputRevision, PRODUCT_VIDEO_MANIFEST_PATH, BOARD_MODEL_REVISION_PATH } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { inspectBoardModelRevision } from "./board-model-revision";
import { sha256Blob } from "./pcb-preview-revision";

export type VideoInputRevisionState = "inputs-unchanged" | "inputs-changed" | "artifact-changed" | "missing-input" | "missing-artifact" | "untracked" | "board-source-changed" | "board-source-unverified";

export const videoInputsNeedReview = (state: VideoInputRevisionState | undefined) => ["inputs-changed", "artifact-changed", "missing-input", "missing-artifact", "board-source-changed", "board-source-unverified"].includes(state ?? "");

/** Follow recorded mesh/video bytes and the canonical board model’s explicit PCB receipt. Other dependencies, captions and new scene content remain unverified. */
export async function inspectVideoInputRevision(client: Pick<CoreClient, "readFile" | "readFileBlob"> & Partial<Pick<CoreClient, "inspectBoardSources">>, projectId: string, path: string): Promise<VideoInputRevisionState> {
  const member = path.match(/^(.*\/)exports\/product-video\.(mp4|webm|gif)$/);
  if (member || client.inspectBoardSources) {
    if (!client.inspectBoardSources) return "board-source-unverified";
    const before = ProjectBoardSources.parse(await client.inspectBoardSources(projectId)), prefix = member?.[1] ?? "";
    if (!member && before.mode === "single") return inspectVideoInputRevision({ readFile: (id, file) => client.readFile(id, file), readFileBlob: (id, file) => client.readFileBlob(id, file) }, projectId, path);
    const directoryPrefix = (directory: string) => directory === "." ? "" : `${directory}/`;
    const source = before.sources.find(row => row.source.location === "project" && directoryPrefix(row.source.directory) === prefix && row.status === "available");
    if (before.projectId !== projectId || before.mode !== "assembly" || !before.manifestSha256 || !source?.pcbSha256) return "board-source-unverified";
    let receipt: unknown, modelReceipt: unknown;
    try { receipt = JSON.parse(await client.readFile(projectId, prefix + PRODUCT_VIDEO_MANIFEST_PATH)); modelReceipt = JSON.parse(await client.readFile(projectId, prefix + BOARD_MODEL_REVISION_PATH)); }
    catch (error) { if (error instanceof SyntaxError || error instanceof CoreHttpError && error.status === 404) return "board-source-unverified"; throw error; }
    const owned = (value: unknown) => !!value && typeof value === "object" && "projectId" in value && value.projectId === projectId && "sourceId" in value && value.sourceId === source.source.id && "manifestSha256" in value && value.manifestSha256 === before.manifestSha256;
    const model = AssemblyBoardModelRevision.safeParse(modelReceipt), video = ProductVideoInputRevision.safeParse(receipt && typeof receipt === "object" && "revision" in receipt ? receipt.revision : null);
    if (!receipt || typeof receipt !== "object" || !("boardSource" in receipt) || !owned(receipt.boardSource) || !model.success || !owned(model.data.boardSource) || !video.success || video.data.inputs.some(input => input.path !== "renders/board.glb")) return "board-source-unverified";
    const local = { readFile: (id: string, file: string) => client.readFile(id, prefix + file), readFileBlob: (id: string, file: string) => client.readFileBlob(id, prefix + file) };
    const state = await inspectVideoInputRevision(local, projectId, path.slice(prefix.length));
    const after = ProjectBoardSources.parse(await client.inspectBoardSources(projectId)), current = after.sources.find(row => row.source.id === source.source.id);
    if (after.manifestSha256 !== before.manifestSha256 || current?.status !== "available" || current.pcbSha256 !== source.pcbSha256 || current.source.location !== "project" || directoryPrefix(current.source.directory) !== prefix) return "board-source-unverified";
    return state;
  }
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

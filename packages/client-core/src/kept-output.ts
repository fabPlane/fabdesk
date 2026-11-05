import { BoardModelRevision, BOARD_MODEL_REVISION_PATH, PcbPreviewRevision, PCB_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

export type KeptOutputKind = "pcb-preview" | "board-model";
export type KeptOutputIdentity = { sourceSha256: string; artifactSha256: string; receiptSha256: string };
export type KeptOutputChoice = KeptOutputIdentity & { keptAt: string };
type Reader = Pick<CoreClient, "readFile" | "readFileBlob" | "inspectBoardSources">;
const paths = {
  "pcb-preview": { receipt: PCB_PREVIEW_REVISION_PATH, artifact: "renders/pcb.svg" },
  "board-model": { receipt: BOARD_MODEL_REVISION_PATH, artifact: "renders/board.glb" },
} as const;

/** A device preference belongs to one endpoint/project/output, never a release-check result. */
export function keptOutputKey(baseUrl: string, projectId: string, kind: KeptOutputKind): string {
  return JSON.stringify([baseUrl.replace(/\/$/, ""), projectId, kind]);
}
export function keptOutputMatches(choice: KeptOutputIdentity, current: KeptOutputIdentity): boolean {
  return choice.sourceSha256 === current.sourceSha256 && choice.artifactSha256 === current.artifactSha256 && choice.receiptSha256 === current.receiptSha256;
}

/** Lightweight identity; the caller must separately require a verified unchanged artifact. */
export async function inspectKeptOutputIdentity(client: Reader, projectId: string, kind: KeptOutputKind): Promise<KeptOutputIdentity> {
  if ((await client.inspectBoardSources(projectId)).mode !== "single") throw new Error("Choose a single-board project before keeping this output.");
  const [text, source] = await Promise.all([client.readFile(projectId, paths[kind].receipt), client.readFileBlob(projectId, "board.kicad_pcb")]);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("This output has no valid source record. Review it before keeping a version."); }
  const parsed = kind === "pcb-preview" ? PcbPreviewRevision.safeParse(raw) : BoardModelRevision.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== "object" || "boardSource" in raw) throw new Error("This output has no verified project-root source record.");
  const sourceSha256 = await sha256Blob(source);
  if (sourceSha256 === parsed.data.sourceSha256) throw new Error("This output already matches its saved PCB source.");
  return { sourceSha256, artifactSha256: parsed.data.artifactSha256, receiptSha256: await sha256Blob(new Blob([text])) };
}

/** Verify the actual saved bytes and reject a source/record/scope change during the user's choice. */
export async function captureKeptOutput(client: Reader, projectId: string, kind: KeptOutputKind): Promise<KeptOutputChoice> {
  const before = await inspectKeptOutputIdentity(client, projectId, kind);
  const artifactSha256 = await sha256Blob(await client.readFileBlob(projectId, paths[kind].artifact));
  if (artifactSha256 !== before.artifactSha256) throw new Error("The saved output changed. Review its current file before keeping it.");
  const after = await inspectKeptOutputIdentity(client, projectId, kind);
  if (!keptOutputMatches(before, after)) throw new Error("The PCB or output record changed while you were choosing. Review it again.");
  if (await sha256Blob(await client.readFileBlob(projectId, paths[kind].artifact)) !== after.artifactSha256) throw new Error("The saved output changed while you were choosing. Review its current file again.");
  return { ...after, keptAt: new Date().toISOString() };
}

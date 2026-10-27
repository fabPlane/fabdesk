import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

export type EnclosureSourceState = "unchanged" | "changed" | "untracked" | "missing-pcb";

/** Negative freshness signal only: a matching root source hash does not certify model fit. */
export async function inspectEnclosureSourceRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string): Promise<EnclosureSourceState> {
  let raw: unknown;
  try {
    const text = await client.readFile(projectId, "enclosure.json");
    try { raw = JSON.parse(text); } catch { return "untracked"; }
  } catch (error) { if (error instanceof CoreHttpError && error.status === 404) return "untracked"; throw error; }
  if (!raw || typeof raw !== "object") return "untracked";
  const spec = raw as { contract?: { name?: unknown; version?: unknown }; pcbRevision?: unknown };
  if (spec.contract?.name !== "fabdesk.enclosure" || !["1.0.0", "2.0.0"].includes(String(spec.contract?.version)) || typeof spec.pcbRevision !== "string" || !/^[a-f0-9]{64}$/.test(spec.pcbRevision)) return "untracked";
  let board: Blob;
  try { board = await client.readFileBlob(projectId, "board.kicad_pcb"); }
  catch (error) { if (error instanceof CoreHttpError && error.status === 404) return "missing-pcb"; throw error; }
  return await sha256Blob(board) === spec.pcbRevision ? "unchanged" : "changed";
}

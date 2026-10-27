import { PcbCheckSourceReceipt } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
export type PcbCheckRevisionState = "source-unchanged" | "source-changed" | "untracked" | "missing-source" | "missing-report";

/** Source identity only: a matching hash is not a DRC pass, ERC result or parity check. */
export async function inspectPcbCheckRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string): Promise<PcbCheckRevisionState> {
  let text: string;
  try { text = await client.readFile(projectId, "reports/drc.json"); }
  catch (error) { if (error instanceof CoreHttpError && error.status === 404) return "missing-report"; throw error; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return "untracked"; }
  const receipt = PcbCheckSourceReceipt.safeParse(raw);
  if (!receipt.success) return "untracked";
  let board: Blob;
  try { board = await client.readFileBlob(projectId, "board.kicad_pcb"); }
  catch (error) { if (error instanceof CoreHttpError && error.status === 404) return "missing-source"; throw error; }
  return await sha256Blob(board) === receipt.data.pcbRevision.sha256 ? "source-unchanged" : "source-changed";
}

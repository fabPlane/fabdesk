import { PcbCheckSourceReceipt } from "@fabdesk/protocol";
import { normalizeReport } from "./check-findings";

export type RootCheckFinding = {
  endpoint: string;
  projectId: string;
  sourceSha256: string;
  reportFingerprint: string;
  point: { x: number; y: number };
  description: string;
  itemDescription: string;
};
/** Only saved root DRC items with explicit finite native positions can become drawing markers. */
export function captureRootCheckFinding(endpoint: string, projectId: string, report: unknown, rowIndex: number, itemIndex: number): RootCheckFinding | null {
  const receipt = PcbCheckSourceReceipt.safeParse(report);
  if (!endpoint || !projectId || !receipt.success || !report || typeof report !== "object" || "boardSource" in report) return null;
  const row = normalizeReport(report, "drc")[rowIndex], item = row?.items[itemIndex], point = item?.pos;
  if (!row || !item || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { endpoint, projectId, sourceSha256: receipt.data.pcbRevision.sha256, reportFingerprint: JSON.stringify(report), point: { ...point }, description: row.description, itemDescription: item.description };
}

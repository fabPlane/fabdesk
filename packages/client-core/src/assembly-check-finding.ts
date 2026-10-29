import { AssemblyPcbCheckReceipt, PcbPreviewRevision, type ProjectBoardSources } from "@fabdesk/protocol";
import { assemblySelectionState, captureAssemblySelection, restoreAssemblySelection, type AssemblySceneSelection } from "./assembly-scene";
import type { inspectAssemblyPcbCheck } from "./assembly-checks";
import { normalizeReport } from "./check-findings";
import { pcbSvgHasNativeCoordinates } from "./pcb-parts";
import { sha256Blob } from "./pcb-preview-revision";

export type AssemblyCheckFinding = {
  selection: AssemblySceneSelection;
  sourceSha256: string;
  reportFingerprint?: string;
  reportRowIndex?: number;
  reportItemIndex?: number;
  point: { x: number; y: number };
  description: string;
  itemDescription: string;
};
/** Capture an actual item from an owned, current report, never a coordinate inferred from its text. */
export function captureAssemblyCheckFinding(data: ProjectBoardSources, snapshot: Awaited<ReturnType<typeof inspectAssemblyPcbCheck>>, rowIndex: number, itemIndex: number, preferred?: AssemblySceneSelection): AssemblyCheckFinding | null {
  if (snapshot.state !== "source-unchanged" || snapshot.projectId !== data.projectId || snapshot.board.manifestSha256 !== data.manifestSha256) return null;
  const receipt = AssemblyPcbCheckReceipt.safeParse(snapshot.report);
  if (!receipt.success || receipt.data.pcbRevision.sha256 !== snapshot.sourceSha256 || receipt.data.boardSource.projectId !== snapshot.projectId || receipt.data.boardSource.sourceId !== snapshot.board.sourceId || receipt.data.boardSource.manifestSha256 !== snapshot.board.manifestSha256) return null;
  const previous = restoreAssemblySelection(data, preferred);
  const instanceId = previous?.sourceId === snapshot.board.sourceId ? previous.instanceId : data.assembly?.instances.find(row => row.sourceId === snapshot.board.sourceId)?.id;
  const selection = instanceId ? captureAssemblySelection(data, instanceId) : null;
  if (!selection || selection.sourceId !== snapshot.board.sourceId || assemblySelectionState(data, selection) !== "owned" || data.sources.find(row => row.source.id === selection.sourceId)?.pcbSha256 !== snapshot.sourceSha256) return null;
  const row = normalizeReport(snapshot.report, "drc")[rowIndex], item = row?.items[itemIndex], point = item?.pos;
  if (!row || !item || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { selection: { ...selection }, reportFingerprint: JSON.stringify(snapshot.report), reportRowIndex: rowIndex, reportItemIndex: itemIndex, sourceSha256: snapshot.sourceSha256, point: { ...point }, description: row.description, itemDescription: item.description };
}
export function assemblyCheckFindingOwned(data: ProjectBoardSources, finding: AssemblyCheckFinding) {
  return assemblySelectionState(data, finding.selection) === "owned" && data.sources.find(row => row.source.id === finding.selection.sourceId)?.pcbSha256 === finding.sourceSha256;
}
/** Validate the bytes actually displayed, not a separately fetched preview that may have changed. */
export async function assemblyFindingPreviewMatches(svg: string, rawReceipt: string | undefined, sourceSha256: string) {
  let raw: unknown; try { raw = JSON.parse(rawReceipt ?? ""); } catch { return false; }
  const receipt = PcbPreviewRevision.safeParse(raw);
  return receipt.success && receipt.data.sourceSha256 === sourceSha256 && pcbSvgHasNativeCoordinates(svg) && await sha256Blob(new Blob([svg])) === receipt.data.artifactSha256;
}

/** Return only to one exact saved report row within its still-owned source. */
export function assemblyCheckFindingRow(data: ProjectBoardSources, snapshot: Awaited<ReturnType<typeof inspectAssemblyPcbCheck>>, finding: AssemblyCheckFinding | null): number | null {
  if (!finding || !finding.reportFingerprint || JSON.stringify(snapshot.report) !== finding.reportFingerprint || !assemblyCheckFindingOwned(data, finding) || snapshot.sourceSha256 !== finding.sourceSha256 || snapshot.board.sourceId !== finding.selection.sourceId) return null;
  if (finding.reportRowIndex !== undefined || finding.reportItemIndex !== undefined) {
    const row = finding.reportRowIndex, item = finding.reportItemIndex;
    if (row === undefined || item === undefined || !Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(item) || item < 0) return null;
    const captured = captureAssemblyCheckFinding(data, snapshot, row, item, finding.selection);
    return captured && captured.description === finding.description && captured.itemDescription === finding.itemDescription && captured.point.x === finding.point.x && captured.point.y === finding.point.y ? row : null;
  }
  const matches = normalizeReport(snapshot.report, "drc").flatMap((row, index) => row.items.some((_item, itemIndex) => {
    const captured = captureAssemblyCheckFinding(data, snapshot, index, itemIndex, finding.selection);
    return captured && captured.description === finding.description && captured.itemDescription === finding.itemDescription && captured.point.x === finding.point.x && captured.point.y === finding.point.y;
  }) ? [index] : []);
  return matches.length === 1 ? matches[0]! : null;
}

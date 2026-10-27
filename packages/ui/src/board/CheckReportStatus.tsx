import { usePcbCheckRevision } from "@fabdesk/client-core";
import { Button } from "../components/ui";

/** Explains the scope and source of saved checks without presenting matching source as a pass. */
export function CheckReportStatus({ projectId, drc, erc }: { projectId: string; drc: unknown; erc: unknown }) {
  const revision = usePcbCheckRevision(projectId, !!drc);
  const state = revision.data;
  const label = !drc ? "No saved DRC report" : revision.isPending ? "Checking DRC source…" : revision.isError ? "DRC source could not be verified" : state === "source-changed" ? "PCB changed since DRC — run DRC again" : state === "source-unchanged" ? "PCB unchanged since DRC report" : state === "missing-source" ? "Checked PCB source is missing" : "Saved DRC report · source unverified";
  const report = drc && typeof drc === "object" ? drc as Record<string, unknown> : null;
  const electrical = erc && typeof erc === "object" ? erc as Record<string, unknown> : null;
  const measurement = electrical?.measurement && typeof electrical.measurement === "object" ? electrical.measurement as Record<string, unknown> : null;
  return <div className="fd-check-report-status" aria-live="polite">
    <span data-stale={state === "source-changed"}>{label}</span>
    {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry source check</Button>}
    {report && report.schematicParityChecked !== true && <span>PCB–schematic parity not verified</span>}
    <span>{!erc ? "No saved ERC report" : measurement?.applicability === false || measurement?.evidenceLevel === "missing" ? "ERC report is incomplete or not applicable" : "Saved ERC report · freshness not verified"}</span>
  </div>;
}

import type { ReactNode } from "react";
import { normalizeReport, usePcbCheckRevision, useProjectOrder } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** A saved result and matching PCB source are not an electrical or manufacturing pass. */
export function CheckReportStatus({ projectId, drc, erc, hasPcb, hasSchematic, sourceReady, loading, drcError, ercError, runningCheck, pcbAction, schematicAction, onOpenPcb, onOpenSchematic }: {
  projectId: string; drc: unknown; erc: unknown; hasPcb: boolean; hasSchematic: boolean; sourceReady: boolean;
  loading: boolean; drcError: boolean; ercError: boolean; runningCheck: "drc" | "erc" | null;
  pcbAction: ReactNode; schematicAction: ReactNode; onOpenPcb: () => void; onOpenSchematic: () => void;
}) {
  const revision = usePcbCheckRevision(projectId, !!drc);
  const state = revision.data;
  const order = useProjectOrder(projectId);
  const ercStale = !!erc && !order.isError && !order.isFetching && order.data?.checks.erc === "stale";
  const report = drc && typeof drc === "object" ? drc as Record<string, unknown> : null;
  const electrical = erc && typeof erc === "object" ? erc as Record<string, unknown> : null;
  const measurement = electrical?.measurement && typeof electrical.measurement === "object" ? electrical.measurement as Record<string, unknown> : null;
  const incompleteErc = measurement?.applicability === false || measurement?.evidenceLevel === "missing";
  const pcbStatus = !sourceReady ? "Checking project sources…" : !hasPcb ? "PCB needed" : runningCheck === "drc" ? "Checking PCB…" : loading ? "Loading saved report…" : drcError ? "Report unavailable" : !drc ? "Not checked yet" : revision.isFetching || revision.isPending ? "Checking report source…" : revision.isError ? "Source not verified" : state === "source-changed" ? "Out of date · run again" : state === "source-unchanged" ? "PCB unchanged since report" : state === "missing-source" ? "Checked PCB is missing" : "Source not verified";
  const schematicStatus = !sourceReady ? "Checking project sources…" : !hasSchematic ? "Schematic needed" : runningCheck === "erc" ? "Checking schematic…" : loading ? "Loading saved report…" : ercError ? "Report unavailable" : !erc ? "Not checked yet" : incompleteErc ? "Incomplete report" : order.isFetching ? "Checking report source…" : order.isError ? "Source check unavailable" : ercStale ? "Out of date · run again" : "Saved report · source unverified";
  const pcbWarning = sourceReady && hasPcb && !loading && !runningCheck && (!drc || drcError || revision.isError || ["source-changed", "missing-source", "unverified"].includes(state ?? "unverified"));
  const schematicWarning = sourceReady && hasSchematic && !loading && !runningCheck;
  const savedCount = (data: unknown, source: "drc" | "erc", failed: boolean) => {
    if (!data || failed || loading) return null;
    const findings = normalizeReport(data, source);
    return <p className="fd-design-check-count">Saved report: <strong>{findings.filter(row => row.severity === "error").length} errors</strong><span>·</span><strong>{findings.filter(row => row.severity === "warning").length} warnings</strong></p>;
  };
  return <div className="fd-design-check-cards" aria-label="Design check status">
    <section className="fd-design-check-card" aria-label="PCB checks">
      <header><Icon name="pcb" width={24} height={24} /><div><h3>PCB checks</h3><p>Clearances, copper and unconnected pads · DRC</p></div></header>
      <p className="fd-design-check-status" data-warning={pcbWarning} role="status"><Icon name={pcbWarning ? "warning" : "info"} width={16} height={16} />{pcbStatus}</p>
      {savedCount(drc, "drc", drcError)}
      <p className="fd-design-check-help">{!hasPcb ? "Add a saved PCB before checking the board layout." : state === "source-changed" ? "The PCB changed after this report. Run PCB checks again for the current board." : report && report.schematicParityChecked !== true ? "This saved report does not verify PCB–schematic agreement." : report?.schematicParityChecked === true ? "PCB–schematic comparison was included. Review the saved findings; a matching source alone is not a pass." : "Run checks on the saved PCB. Schematic comparison is included when its source is available."}</p>
      <footer>{pcbAction}<Button size="sm" variant="ghost" disabled={!sourceReady || runningCheck !== null} onClick={onOpenPcb}>{hasPcb ? "Open PCB" : "Add PCB"}</Button></footer>
      {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry source check</Button>}
    </section>
    <section className="fd-design-check-card" aria-label="Schematic checks">
      <header><Icon name="schematic" width={24} height={24} /><div><h3>Schematic checks</h3><p>Electrical connections and pin rules · ERC</p></div></header>
      <p className="fd-design-check-status" data-warning={schematicWarning} role="status"><Icon name={schematicWarning ? "warning" : "info"} width={16} height={16} />{schematicStatus}</p>
      {savedCount(erc, "erc", ercError)}
      <p className="fd-design-check-help">{!hasSchematic ? "Find, import or create the native schematic to check the circuit." : ercStale ? "The schematic needs a new check. Run schematic checks again before relying on the saved result." : incompleteErc ? "The saved report is incomplete or not applicable. Review the schematic and run a complete check." : erc ? "Schematic freshness is not verified here. Run again after edits; review the results before relying on them." : "Check the complete saved schematic, including referenced sheets. This is separate from PCB layout checks."}</p>
      <footer>{schematicAction}<Button size="sm" variant="ghost" disabled={!sourceReady || runningCheck !== null} onClick={onOpenSchematic}>{hasSchematic ? "Open schematic" : "Add schematic"}</Button></footer>
      {!!erc && order.isError && <Button size="sm" variant="ghost" onClick={() => void order.refetch()}>Retry ERC source check</Button>}
    </section>
  </div>;
}

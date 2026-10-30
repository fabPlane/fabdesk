import { useState } from "react";
import type { AssemblySchematicInspection, BoardSourceSelection, ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySchematicInspection, captureAssemblySourceSelection, useRunTool } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { SchematicAvailability } from "./SchematicAvailability";
import { useUiStore } from "../stores/ui";

/** Availability and a clear next step first; optional file inventory never implies electrical validation. */
export function AssemblySchematicSources({ projectId, board, data, disabled, onNavigate }: { projectId: string; board: BoardSourceSelection; data: ProjectBoardSources; disabled: boolean; onNavigate?: () => void }) {
  const tool = useRunTool(), busy = tool.state.status === "running";
  const [snapshot, setSnapshot] = useState<{ value: AssemblySchematicInspection; observedAt: string } | null>(null), [error, setError] = useState<string | null>(null);
  const source = data.sources.find(row => row.source.id === board.sourceId), available = !!source?.schematicPath;
  const changed = !!snapshot && snapshot.observedAt !== data.observedAt;
  const current = () => !disabled && !busy && board.manifestSha256 === data.manifestSha256 && source?.status === "available" && useUiStore.getState().activeProjectId === projectId;
  const openSchematic = () => {
    if (!current()) return;
    const ui = useUiStore.getState(), selection = captureAssemblySourceSelection(data, board.sourceId, ui.assemblyBoardByProject[projectId]);
    if (!selection) return;
    ui.setAssemblyBoard(selection); onNavigate?.(); ui.setBoardTab("schematic");
  };
  const inspect = async () => {
    if (!current() || !available) return;
    const captured = { ...board }, observedAt = data.observedAt; setError(null);
    const result = await tool.run("schematic_inspect", { projectId, board: captured, detail: "summary" });
    if (result.status === "done") {
      try { setSnapshot({ value: captureAssemblySchematicInspection(result.result, projectId, captured), observedAt }); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }
  };
  return <SchematicAvailability available={available} disabled={disabled || busy} onOpen={openSchematic}>
    {available && <details><DisclosureSummary icon="folderOpen" label="Schematic files" variant="compact" />
      <p className="fd-schematic-source-path">{source.schematicPath}</p>
      <p>Check referenced files to find missing sheets and count the saved components. This does not run electrical checks.</p>
      <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void inspect()}>{busy ? "Checking files…" : snapshot ? "Check files again" : "Check referenced files"}</Button>
      {snapshot && <div role="status" data-warning={changed || !snapshot.value.hierarchy.complete}>
        <strong>{changed ? "Files may have changed · check again" : snapshot.value.hierarchy.complete ? "All referenced sheets found" : "Some schematic files need attention"}</strong>
        <p>{snapshot.value.hierarchy.complete ? `${snapshot.value.hierarchy.counts.components} components · ${snapshot.value.hierarchy.counts.nets} nets · ${snapshot.value.hierarchy.counts.sheets} saved ${snapshot.value.hierarchy.counts.sheets === 1 ? "sheet" : "sheets"}.` : "Review the file issues below before relying on component or connection totals."}</p>
        <ul>{snapshot.value.hierarchy.sheets.map((sheet, index) => <li key={index}>{sheet.nativePath}{sheet.hierarchyPath !== "/" ? ` · ${sheet.hierarchyPath}` : ""}</li>)}{snapshot.value.hierarchy.issues.map((issue, index) => <li key={`issue-${index}`}>{issue.path} · {issue.kind === "missing" ? "Missing sheet. Import or restore it, then check files again." : issue.detail}</li>)}</ul>
        {snapshot.value.hierarchy.pagination.truncated && <p>Showing {snapshot.value.hierarchy.pagination.returned} of {snapshot.value.hierarchy.pagination.total} sheet records. Ask fabPlane to inspect the remaining files.</p>}
      </div>}
      {(error || tool.state.error) && <p role="alert">{error ?? tool.state.error}</p>}
    </details>}
  </SchematicAvailability>;
}

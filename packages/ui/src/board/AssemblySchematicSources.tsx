import { DisclosureSummary } from "../components/DisclosureSummary";
import { useState } from "react";
import type { AssemblySchematicInspection, BoardSourceSelection, ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySchematicInspection, useRunTool } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";

/** Requested source inventory only. It does not silently open another editor or run ERC. */
export function AssemblySchematicSources({ projectId, board, data, disabled }: { projectId: string; board: BoardSourceSelection; data: ProjectBoardSources; disabled: boolean }) {
  const tool = useRunTool(), busy = tool.state.status === "running";
  const [snapshot, setSnapshot] = useState<{ value: AssemblySchematicInspection; observedAt: string } | null>(null), [error, setError] = useState<string | null>(null);
  const source = data.sources.find(row => row.source.id === board.sourceId), available = !!source?.schematicPath;
  const changed = !!snapshot && snapshot.observedAt !== data.observedAt;
  const inspect = async () => {
    if (disabled || busy || !available || useUiStore.getState().activeProjectId !== projectId) return;
    const captured = { ...board }, observedAt = data.observedAt; setError(null);
    const result = await tool.run("schematic_inspect", { projectId, board: captured, detail: "summary" });
    if (result.status === "done") {
      try { setSnapshot({ value: captureAssemblySchematicInspection(result.result, projectId, captured), observedAt }); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
  };
  return <section className="fd-member-checks-scope fd-member-schematic-sources" aria-label="Schematic source inspection">
    <details><DisclosureSummary icon="schematic" label="Schematic sources" badge={available ? null : "Not imported"} warning={!available} />
    <div><p>{available ? "Inspect this source’s saved sheets before reviewing electrical checks or synchronization." : "No saved schematic for this source. Import its native schematic and referenced sheets to review them here."}</p></div>
    {available && <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void inspect()}>{busy ? "Inspecting sheets…" : snapshot ? "Reinspect schematic sources" : "Inspect schematic sources"}</Button>}
    {snapshot && <div role="status" data-warning={changed || !snapshot.value.hierarchy.complete}>
      <strong>{changed ? "Project changed since inspection · reinspect before using these facts" : snapshot.value.hierarchy.complete ? "Saved hierarchy inspected" : "Saved hierarchy incomplete"}</strong>
      <p>{snapshot.value.hierarchy.complete ? `${snapshot.value.hierarchy.counts.components} components · ${snapshot.value.hierarchy.counts.nets} nets · ${snapshot.value.hierarchy.counts.sheets} referenced ${snapshot.value.hierarchy.counts.sheets === 1 ? "sheet" : "sheets"}.` : "Electrical totals are unavailable until every referenced sheet can be inspected."} This is a saved netlist snapshot; ERC, PCB parity, external libraries and assembly compatibility are not checked.</p>
      <details><DisclosureSummary icon="folderOpen" label="Inspected files and issues" variant="compact" /><ul>{snapshot.value.hierarchy.sheets.map((sheet, index) => <li key={index}>{sheet.nativePath} · {sheet.hierarchyPath}</li>)}{snapshot.value.hierarchy.issues.map((issue, index) => <li key={`issue-${index}`}>{issue.path} · {issue.kind === "missing" ? "Referenced sheet is missing. Import or restore it, then reinspect." : issue.detail}</li>)}</ul>{snapshot.value.hierarchy.pagination.truncated && <p>Showing {snapshot.value.hierarchy.pagination.returned} of {snapshot.value.hierarchy.pagination.total} sheet records. The agent can inspect later pages.</p>}</details>
    </div>}
    {(error || tool.state.error) && <p role="alert">{error ?? tool.state.error}</p>}
    </details>
  </section>;
}

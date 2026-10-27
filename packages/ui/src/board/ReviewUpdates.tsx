import { useProject, usePcbPreviewRevision, useBoardModelRevision, useEnclosureSourceRevision, usePcbCheckRevision, useRunTool } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { newChatDraftKey, useUiStore } from "../stores/ui";

type Row = { item: string; status: string; note: string; warning: boolean; action: string; disabled?: boolean; onClick: () => void };

/** A review of known dependencies, not a claim that every project artifact is synchronized. */
export function ReviewUpdates() {
  const projectId = useUiStore(state => state.activeProjectId), project = useProject(projectId), update = useRunTool();
  const files = project.data?.files ?? [], has = (path: string) => files.some(file => file.path === path);
  const pcb = has("board.kicad_pcb"), schematic = has("board.kicad_sch");
  const preview = usePcbPreviewRevision(projectId, has("renders/pcb.svg"));
  const model = useBoardModelRevision(projectId, has("renders/board.glb"));
  const enclosure = useEnclosureSourceRevision(projectId, has("enclosure.json"));
  const checks = usePcbCheckRevision(projectId, has("reports/drc.json"));
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load project updates" onRetry={() => void project.refetch()} />;
  if (project.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const open = (tab: "pcb" | "cad" | "drc" | "renders") => useUiStore.getState().setBoardTab(tab);
  const retry = (queries: Array<{ refetch: () => unknown }>) => { for (const query of queries) void query.refetch(); };
  const busy = update.state.status === "running";
  const rows: Row[] = [
    { item: "PCB preview", status: !has("renders/pcb.svg") ? "Not generated" : preview.isFetching ? "Checking source…" : preview.isError ? "Could not check source" : preview.data === "source-changed" ? "PCB source changed" : preview.data === "artifact-changed" ? "Preview file changed" : preview.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified", warning: ["source-changed", "artifact-changed"].includes(preview.data ?? ""), note: "Updates the drawing from the saved PCB. Electrical checks stay separate.", action: has("renders/pcb.svg") ? "Update preview" : "Create preview", disabled: !pcb || busy, onClick: () => void update.run("render_pcb_svg", { projectId }) },
    { item: "Board 3D model", status: !has("renders/board.glb") ? "Not generated" : model.isFetching ? "Checking source…" : model.isError ? "Could not check source" : model.data === "source-changed" ? "PCB source changed" : model.data === "artifact-changed" ? "Model file changed" : model.data === "source-unchanged" ? "PCB unchanged since export" : "Source unverified", warning: ["source-changed", "artifact-changed"].includes(model.data ?? ""), note: "External component models and physical fit are not verified.", action: has("renders/board.glb") ? "Update model" : "Create model", disabled: !pcb || busy, onClick: () => void update.run("glb", { projectId }) },
    { item: "Generated enclosure", status: !has("enclosure.json") ? "Not generated" : enclosure.isFetching ? "Checking source…" : enclosure.isError ? "Could not check source" : enclosure.data === "changed" ? "PCB source changed" : enclosure.data === "unchanged" ? "Case source unchanged" : "Source unverified", warning: enclosure.data === "changed", note: "Review dimensions and fit before deliberately regenerating the case.", action: "Review enclosure", onClick: () => open("cad") },
    { item: "PCB checks", status: !has("reports/drc.json") ? "No saved DRC report" : checks.isFetching ? "Checking report source…" : checks.isError ? "Could not check source" : checks.data === "source-changed" ? "PCB changed since DRC" : checks.data === "source-unchanged" ? "PCB unchanged since DRC" : "Source unverified", warning: checks.data === "source-changed", note: "Matching source is not a pass. Review findings, ERC and schematic parity separately.", action: "Open checks", onClick: () => open("drc") },
    { item: "Other saved outputs", status: "Freshness not yet tracked", warning: false, note: "Images, videos and manufacturing files retain their saved versions. Review before sharing or fabrication.", action: "Browse outputs", onClick: () => open("renders") },
  ];
  return <div className="fd-review-updates" data-testid="review-updates">
    <header><h2>Review updates</h2><p>See what changed and choose what to refresh. Opening this view does not regenerate files or synchronize your designs.</p><Button size="sm" variant="ghost" onClick={() => retry([preview, model, enclosure, checks])}>Recheck sources</Button></header>
    <div className="fd-update-table" role="table" aria-label="Saved artifact source review">
      <div className="fd-update-row fd-update-table-heading" role="row"><span role="columnheader">Item</span><span role="columnheader">Source status</span><span role="columnheader">Next step</span></div>
      {rows.map(row => <div key={row.item} className="fd-update-row" role="row"><div role="cell"><strong>{row.item}</strong><p>{row.note}</p></div><span role="cell" data-warning={row.warning}>{row.status}</span><div role="cell"><Button size="sm" disabled={row.disabled} onClick={row.onClick}>{row.action}</Button></div></div>)}
    </div>
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating the selected output…</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}
    <section className="fd-update-sync"><div><h3>Schematic and PCB</h3><p>{pcb && schematic ? "A newer timestamp does not tell us which design should change. Review differences and choose a direction before applying an update." : "This project needs both a schematic and PCB before their relationship can be reviewed."}</p><small>Schematic/PCB equivalence is not verified by the source checks above.</small></div><Button size="sm" disabled={!pcb || !schematic} onClick={() => {
      const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
      const key = ui.activeThreadId ?? newChatDraftKey(projectId), previous = ui.drafts[key] ?? "";
      const prompt = "Review the saved schematic and PCB in this project. Explain their differences and which synchronization direction is appropriate. Do not apply changes or save an open native document until we choose a direction.";
      ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt); ui.focusComposer();
    }}>Ask about sync direction</Button></section>
  </div>;
}

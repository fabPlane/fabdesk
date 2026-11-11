import { captureAssemblySelection, useBoardSources, useProjectStatus } from "@fabdesk/client-core";
import { sharedCheckLabel, sharedModelLabel, sharedSourceLabel, type SharedBoard } from "@fabdesk/protocol";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import "./project-status.css";

export function ProjectStatus() {
  const projectId = useUiStore(s => s.activeProjectId);
  const status = useProjectStatus(projectId), sources = useBoardSources(projectId);
  const ui = () => useUiStore.getState();
  useAssistantSurface(projectId ? { projectId, label: "Project Status", priority: 10, details: JSON.stringify({ boards: status.data?.boards, savedInformationOnly: true, checking: status.isFetching, instruction: "Saved checks and model inputs do not establish completion, compatibility or manufacturing approval." }) } : null);
  const unavailable = status.isFetching || sources.isFetching || sources.isError;
  const open = (board: SharedBoard, tab: "pcb" | "drc" | "3d") => {
    if (!projectId || unavailable || ui().activeProjectId !== projectId || !sources.data) return;
    if (sources.data.mode === "assembly") {
      const instance = sources.data.assembly?.instances.find(i => i.sourceId === board.id);
      const selection = instance ? captureAssemblySelection(sources.data, instance.id) : null;
      if (!selection) return;
      ui().setAssemblyBoard(selection);
    }
    ui().setBoardTab(tab);
  };
  if (!projectId) return <EmptyState title="Choose a project to see its status" />;
  if (status.isError || sources.isError) return <LoadError title="Could not check saved board status" onRetry={() => { void status.refetch(); void sources.refetch(); }} />;
  return <div className="fd-project-status">
    <nav className="fd-project-status-nav" aria-label="Project views">
      <Button size="sm" aria-current="page">Status</Button>
      <Button size="sm" variant="ghost" onClick={() => ui().setWorkspaceArea("overview")}>{sources.data?.mode === "assembly" ? "Connections" : "Overview"}</Button>
      <Button size="sm" variant="ghost" onClick={() => sources.data?.mode === "assembly" ? ui().setWorkspaceArea("mechanical") : ui().setBoardTab("3d")}><Icon name="cube" width={15} height={15} />{sources.data?.mode === "assembly" ? "3D assembly" : "3D"}</Button>
    </nav>
    <header className="fd-project-status-heading"><div><h1>Project Status</h1><p>{status.data?.name ?? "Saved board information"}{status.data && <> · {status.data.boards.length} {status.data.boards.length === 1 ? "board" : "boards"}</>}</p></div>
      <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => { void status.refetch(); void sources.refetch(); }}>Refresh</Button>
    </header>
    {!status.data ? <p role="status"><Spinner />Checking saved boards…</p> : <>
      <div className="fd-project-status-table" role="table" aria-label="Board status" aria-busy={unavailable}>
        <div className="fd-project-status-row fd-project-status-labels" role="row"><span role="columnheader">Board</span><span role="columnheader">Saved PCB checks</span><span role="columnheader">Saved 3D</span></div>
        {status.data.boards.map(board => <div key={board.id} className="fd-project-status-row" role="row">
          <div role="cell"><button className="fd-project-status-name" disabled={unavailable || !board.sourceAvailable} onClick={() => open(board, "pcb")}>{board.name}</button><small>{sharedSourceLabel(board)}</small></div>
          <div role="cell" data-label="Saved PCB checks"><button className="fd-project-status-value" disabled={unavailable || !board.sourceAvailable} data-warning={board.checks.state === "source-changed" || (board.checks.findingCount ?? 0) > 0} onClick={() => open(board, "drc")}>{sharedCheckLabel(board.checks)}</button></div>
          <div role="cell" data-label="Saved 3D"><button className="fd-project-status-value" disabled={unavailable || !board.sourceAvailable} data-warning={board.modelState === "source-changed" || board.modelState === "artifact-changed"} onClick={() => open(board, "3d")}>{sharedModelLabel(board)}</button></div>
        </div>)}
      </div>
      <footer className="fd-project-status-footer"><div><Button size="sm" variant="ghost" onClick={() => ui().setBoardTab("bom")}>Parts &amp; BOM</Button>{sources.data?.mode === "assembly" && <Button size="sm" variant="ghost" onClick={() => ui().setWorkspaceArea("overview")}>Connection map</Button>}</div>
        <p>{unavailable ? "Checking saved information…" : `Checked ${new Date(status.data.capturedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`} Local changes appear online after publishing. Saved checks and models do not establish manufacturing approval or connection compatibility.</p>
      </footer>
    </>}
  </div>;
}

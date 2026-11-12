import { captureAssemblySelection, useBoardSources, useProjectStatus, useBoardChecks } from "@fabdesk/client-core";
import { boardChecksLabel, boardReviewLabel, sharedCheckLabel, sharedModelLabel, sharedSourceLabel, type SharedBoard } from "@fabdesk/protocol";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import "./project-status.css";

export function ProjectStatus() {
  const projectId = useUiStore(s => s.activeProjectId);
  const status = useProjectStatus(projectId), sources = useBoardSources(projectId), boardChecks = useBoardChecks(projectId);
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
      <Button size="sm" variant="ghost" onClick={() => ui().setWorkspaceArea("overview")}>Overview</Button>
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
      {boardChecks.data?.used && <section className="fd-project-status-board" aria-label="Board acceptance checks">
        <h2>Board checks</h2>
        <p data-warning={boardChecks.data.state !== "current" || boardChecks.data.regressions.length > 0 || (boardChecks.data.failing.length > 0 && boardChecks.data.mode === "strict")}>{boardChecksLabel(boardChecks.data)}</p>
        {boardChecks.data.review && <p data-warning={boardChecks.data.review.state !== "pass"}>{boardReviewLabel(boardChecks.data.review)}</p>}
        {boardChecks.data.onboarding && !boardChecks.data.onboarding.confirmed && boardChecks.data.onboarding.toConfirm > 0 && <p data-warning="true">{boardChecks.data.onboarding.toConfirm} derived requirement{boardChecks.data.onboarding.toConfirm === 1 ? "" : "s"} not yet confirmed against the circuit</p>}
        <small>Measured by the board workflow on the saved board{boardChecks.data.at ? ` · ${new Date(boardChecks.data.at).toLocaleString()}` : ""}. Not a manufacturing approval.</small>
        {!!boardChecks.data.candidates?.length && <><h3>Edit candidates</h3><ul className="fd-project-status-board-list">{boardChecks.data.candidates.map(c => <li key={`${c.id}-${c.startedAt}`}><span>{c.id}</span><span data-warning={!c.verdict.startsWith("PASS")}>{c.verdict}</span><small>{c.seconds} s{c.collateralNets ? ` · ${c.collateralNets} other nets changed` : ""}</small></li>)}</ul></>}
        {!!boardChecks.data.history?.length && <><h3>Recent checks</h3><ul className="fd-project-status-board-list">{boardChecks.data.history.map(h => <li key={h.at}><span>{new Date(h.at).toLocaleString()}</span><span data-warning={!h.pass}>{h.pass ? "A1-A9 pass" : `failing ${h.failing.join(", ")}`}</span><small>{h.current ? "saved board" : "earlier board"}</small></li>)}</ul></>}
      </section>}
      <footer className="fd-project-status-footer"><div><Button size="sm" variant="ghost" onClick={() => ui().setBoardTab("bom")}>Parts &amp; BOM</Button>{sources.data?.mode === "assembly" && <Button size="sm" variant="ghost" onClick={() => ui().setWorkspaceArea("overview")}>Connection map</Button>}</div>
        <p>{unavailable ? "Checking saved information…" : `Checked ${new Date(status.data.capturedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`} Local changes appear online after publishing. Saved checks and models do not establish manufacturing approval or connection compatibility.</p>
      </footer>
    </>}
  </div>;
}

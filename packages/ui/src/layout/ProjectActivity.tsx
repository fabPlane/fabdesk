import { useEffect, useMemo, useRef, useState } from "react";
import { captureAssemblySourceSelection, jobIsActive, projectJobs, projectJobBoard, useBoardSources, useCancelJob, useCoreClient, useJobs, useRunsStore, useToolManifest, type ProjectJob } from "@fabdesk/client-core";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { Button, Dialog, EmptyState, LoadError, Spinner, Tabs } from "../components/ui";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { ErrorNotice } from "../components/ErrorNotice";
import { useUiStore } from "../stores/ui";

const STATUS = { queued: "Queued", running: "Working", done: "Completed", failed: "Failed", cancelled: "Cancelled" } as const;

/** One requested home for the existing core jobs, including work started on another page. */
export function ProjectActivity({ projectId }: { projectId: string }) {
  const client = useCoreClient(), jobs = useJobs(true, projectId), manifest = useToolManifest(), sources = useBoardSources(projectId), cancel = useCancelJob();
  const live = useRunsStore(state => state.jobs);
  const [open, setOpen] = useState(false), [filter, setFilter] = useState<"active" | "recent">("active");
  const filterChosen = useRef(false);
  const [error, setError] = useState<unknown>(null), [requested, setRequested] = useState<string | null>(null);
  const rows = useMemo(() => projectJobs(projectId, jobs.data ?? [], live, client.baseUrl), [projectId, jobs.data, live, client.baseUrl]);
  const active = rows.filter(jobIsActive), recent = rows.filter(row => !jobIsActive(row));
  const visible = filter === "active" ? active : recent.slice(0, 20);
  useEffect(() => { if (open && !filterChosen.current && active.length) setFilter("active"); }, [open, active.length]);
  const title = (job: ProjectJob) => {
    const name = job.kind.replace(/^tool:/, "");
    return manifest.data?.find(tool => tool.name === name)?.title ?? name.replaceAll("_", " ");
  };
  const surface = { projectId, label: "Project activity", priority: 50, details: JSON.stringify({ endpoint: client.baseUrl, filter, jobs: visible.slice(0, 20).map(job => ({ id: job.id, tool: job.kind, status: job.status, progress: job.progress, note: job.note?.slice(0, 1000), error: job.error?.slice(0, 2000), board: projectJobBoard(job) })) }) };
  useAssistantSurface(open ? surface : null);
  const current = () => useUiStore.getState().activeProjectId === projectId;
  const requestCancel = async (job: ProjectJob) => {
    if (!current() || cancel.isPending || !jobIsActive(job)) return;
    setError(null);
    try {
      const response = await cancel.mutateAsync(job.id);
      if (!current()) return;
      if (response.ok) setRequested(job.id);
      else setError("This task could not be cancelled. It may have already finished; refresh its status before trying again.");
      void jobs.refetch();
    } catch (failure) { if (current()) setError(failure); }
  };
  const openResult = (job: ProjectJob) => {
    if (!current()) return;
    const ui = useUiStore.getState();
    if (/route|verify|drc|erc/.test(job.kind)) {
      if (!sources.data || sources.isFetching || sources.isError) { setError("Recheck board sources before opening this task’s result."); return; }
      if (sources.data.mode === "assembly") {
        const board = projectJobBoard(job);
        const selection = board?.manifestSha256 === sources.data.manifestSha256 ? captureAssemblySourceSelection(sources.data, board.sourceId, ui.assemblyBoardByProject[projectId]) : null;
        if (!selection) { setError("This saved task does not establish current board ownership. Open its board from the project overview to review the current results."); return; }
        ui.setAssemblyBoard(selection);
      }
      setOpen(false); ui.setBoardTab(/route/.test(job.kind) ? "cinema" : "drc");
    }
    else { setOpen(false); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }
  };
  return <>
    <CanvasToolButton icon="history" label={active.length ? `Project activity · ${active.length} active` : "Project activity"} active={active.length > 0} onClick={() => { filterChosen.current = false; setError(null); setFilter(active.length ? "active" : "recent"); setOpen(true); void jobs.refetch(); }} />
    {active.length > 0 && <span className="fd-project-activity-count" aria-live="polite">{active.length}</span>}
    <Dialog open={open} onClose={() => setOpen(false)} title="Project activity" className="fd-project-activity">
      <p>Renders, exports and checks keep running when you change pages. Review their progress or cancel work you no longer need.</p>
      <div className="fd-project-activity-toolbar"><Tabs value={filter} onChange={next => { filterChosen.current = true; setFilter(next); }} tabs={[{ id: "active", label: `Active · ${active.length}` }, { id: "recent", label: `Recent · ${recent.length}` }]} /><Button size="sm" variant="ghost" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}>{jobs.isFetching ? "Refreshing…" : "Refresh"}</Button></div>
      {jobs.isError && <LoadError title="Could not refresh task history" onRetry={() => void jobs.refetch()} />}
      {jobs.isPending && !rows.length ? <p role="status"><Spinner />Loading this project’s tasks…</p> : !visible.length ? <EmptyState title={filter === "active" ? "No tasks running" : "No recent tasks"}>{filter === "active" ? "You can continue working. New renders and exports appear here." : "Completed, cancelled and failed tasks will appear here."}</EmptyState> : <ul className="fd-project-activity-list">{visible.map(job => {
        const running = jobIsActive(job), board = projectJobBoard(job), source = sources.data?.sources.find(row => row.source.id === board?.sourceId)?.source.name;
        return <li key={job.id} data-status={job.status}>
          <div className="fd-project-activity-heading"><strong>{title(job)}</strong><span>{requested === job.id && running ? "Cancellation requested…" : STATUS[job.status]}</span></div>
          {source && <p>{source}</p>}
          {running && job.progress !== null && <progress aria-label={`${title(job)} progress`} max={1} value={job.progress} />}
          {job.note && <p>{job.note}</p>}
          {job.error && job.status !== "cancelled" && <ErrorNotice error={job.error} />}
          <div className="fd-project-activity-actions">
            {running ? <Button size="sm" disabled={cancel.isPending || requested === job.id} onClick={() => void requestCancel(job)}>{cancel.isPending && cancel.variables === job.id ? "Requesting cancellation…" : "Cancel task"}</Button> : job.status === "done" && /render|export|route|verify|drc|erc|glb|video/.test(job.kind) ? <Button size="sm" onClick={() => openResult(job)}>{/route/.test(job.kind) ? "Review routing" : /verify|drc|erc/.test(job.kind) ? "Open checks" : "Open outputs"}</Button> : null}
            <CanvasToolButton icon="sparkles" label="Ask about this task" onClick={() => { askAboutSurface({ ...surface, label: `Activity · ${title(job)}`, details: JSON.stringify({ id: job.id, tool: job.kind, status: job.status, board, note: job.note, error: job.error }) }, `Help me review this ${title(job).toLowerCase()} task. Explain ${job.status === "failed" ? "what failed and the safest next step" : "its current result and what I should do next"} before starting or changing anything.`); setOpen(false); }} />
          </div>
          <details><DisclosureSummary icon="history" label="Task details" variant="compact" /><p className="fd-project-activity-id">{job.id}</p>{job.startedAt && <p>Started {new Date(job.startedAt).toLocaleString()}</p>}</details>
        </li>;
      })}</ul>}
      {filter === "recent" && recent.length > 20 && <p>Showing the 20 most recent tasks for this project.</p>}
      {error != null && <ErrorNotice error={error} />}
    </Dialog>
  </>;
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { activityArtifacts, activityGroups, activityNeedsAttention, activityOutcome, useProject, captureAssemblySourceSelection, jobIsActive, projectJobs, projectJobBoard, useBoardSources, useCancelJob, useCoreClient, useJobs, useProjectAssistantRuns, useRunsStore, useToolManifest, type ProjectJob } from "@fabdesk/client-core";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { Button, EmptyState, IconButton, LoadError, Spinner, Tabs } from "../components/ui";
import { Icon } from "../components/Icon";
import "./project-activity.css";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { ErrorNotice } from "../components/ErrorNotice";
import { useUiStore } from "../stores/ui";

const STATUS = { queued: "Queued", running: "Working", done: "Finished", failed: "Failed", cancelled: "Cancelled" } as const;

/** One requested home for the existing core jobs, including work started on another page. */
export function ProjectActivity({ projectId }: { projectId: string }) {
  const client = useCoreClient(), jobs = useJobs(true, projectId), manifest = useToolManifest(), sources = useBoardSources(projectId), cancel = useCancelJob();
  const live = useRunsStore(state => state.jobs);
  const assistants = useProjectAssistantRuns(projectId), project = useProject(projectId);
  const panelId = useId(), headingId = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState(false), [filter, setFilter] = useState<"active" | "attention" | "recent">("active");
  const filterChosen = useRef(false);
  const [error, setError] = useState<unknown>(null), [requested, setRequested] = useState<string | null>(null);
  const rows = useMemo(() => projectJobs(projectId, jobs.data ?? [], live, client.baseUrl), [projectId, jobs.data, live, client.baseUrl]);
  const active = rows.filter(jobIsActive), recent = rows.filter(row => !jobIsActive(row));
  const activityCount = active.length + assistants.runs.length;
  const attention = recent.filter(activityNeedsAttention);
  const groups = activityGroups(filter === "active" ? active : filter === "attention" ? attention : recent, manifest.data ?? []);
  const visibleGroups = groups.slice(0, limit), visible = visibleGroups.flat();
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();

  }, [open]);
  useEffect(() => { setOpen(false); setLimit(20); }, [projectId]);
  useEffect(() => {
    if (open && !filterChosen.current) setFilter(activityCount ? "active" : attention.length ? "attention" : "recent");
  }, [open, activityCount, attention.length]);
  const title = (job: ProjectJob) => {
    const name = job.kind.replace(/^tool:/, "");
    return manifest.data?.find(tool => tool.name === name)?.title ?? name.replaceAll("_", " ");
  };
  const surface = { projectId, label: "Project activity", priority: 50, details: JSON.stringify({ endpoint: client.baseUrl, filter, assistants: assistants.runs.map(({ thread, run }) => ({ threadId: thread.id, title: thread.title, agentId: run.agentId, startedAt: run.startedAt })), jobs: visible.slice(0, 20).map(job => ({ id: job.id, tool: job.kind, status: job.status, progress: job.progress, note: job.note?.slice(0, 1000), error: job.error?.slice(0, 2000), board: projectJobBoard(job) })) }) };
  useAssistantSurface(open ? surface : null);
  const closePanel = () => { if (panel.current?.contains(document.activeElement)) trigger.current?.focus(); setOpen(false); };
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
      const board = projectJobBoard(job);
      if (sources.data.mode !== "assembly" && board) {
        setError("This task belongs to a member-board source that is no longer declared here. Review its saved files before opening a current board result."); return;
      }
      if (sources.data.mode === "assembly") {
        const selection = board?.manifestSha256 === sources.data.manifestSha256 ? captureAssemblySourceSelection(sources.data, board.sourceId, ui.assemblyBoardByProject[projectId]) : null;
        if (!selection) { setError("This saved task does not establish current board ownership. Open its board from the project overview to review the current results."); return; }
        ui.setAssemblyBoard(selection);
      }
      setOpen(false); ui.setBoardTab(/route/.test(job.kind) ? "cinema" : "drc");
    }
    else {
      const files = project.data && !project.isFetching && !project.isError ? activityArtifacts(job, projectId, project.data.path, project.data.files) : [];
      setOpen(false);
      if (files[0]) ui.openProjectFile(files[0]);
      else if (job.kind.replace(/^tool:/, "") === "bom_read") ui.setBoardTab("bom");
      else { ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }
    }
  };
  const renderJob = (job: ProjectJob) => {
    const running = jobIsActive(job), board = projectJobBoard(job), source = sources.data?.sources.find(row => row.source.id === board?.sourceId)?.source.name;
    const recordedAt = job.endedAt ?? job.startedAt;
    const artifacts = project.data && !project.isFetching && !project.isError ? activityArtifacts(job, projectId, project.data.path, project.data.files) : [];
    const canOpen = job.status === "done" && (/render|export|route|verify|drc|erc|glb|video|bom_read/.test(job.kind) || artifacts.length > 0);
    return <article className="fd-activity-task" data-status={job.status} key={job.id}>
      <div className="fd-activity-task-heading"><strong>{title(job)}</strong><span>{requested === job.id && running ? "Stopping…" : STATUS[job.status]}</span></div>
      <p className="fd-activity-outcome">{activityOutcome(job)}</p>
      <p className="fd-activity-meta">{source && <span>{source} · </span>}{recordedAt && Number.isFinite(Date.parse(recordedAt)) ? <time dateTime={recordedAt} title={recordedAt}>{new Date(recordedAt).toLocaleString()}</time> : "Time not recorded"}</p>
      {running && job.progress !== null && <progress aria-label={`${title(job)} progress`} max={1} value={job.progress} />}
      <div className="fd-activity-task-actions">
        {running ? <Button size="sm" disabled={cancel.isPending || requested === job.id} onClick={() => void requestCancel(job)}>{cancel.isPending && cancel.variables === job.id ? "Requesting…" : "Cancel task"}</Button> : canOpen && <Button size="sm" onClick={() => openResult(job)}>{/route/.test(job.kind) ? "Review routing" : /verify|drc|erc/.test(job.kind) ? "Review checks" : artifacts.length ? "Open saved file" : job.kind.replace(/^tool:/, "") === "bom_read" ? "Open parts" : "Browse outputs"}</Button>}
        <Button size="sm" variant="ghost" onClick={() => { askAboutSurface({ ...surface, label: `Activity · ${title(job)}`, details: JSON.stringify({ id: job.id, tool: job.kind, status: job.status, board, note: job.note, error: job.error, result: job.result }) }, `Help me review this ${title(job).toLowerCase()} task. Explain ${job.status === "failed" ? "what failed and the safest next step" : "its recorded result and what I should do next"}. Check current sources before proposing changes; a finished task alone does not establish design readiness.`); setOpen(false); }}><Icon name="sparkles" width={14} height={14} />Ask</Button>
        <details className="fd-activity-run-details"><DisclosureSummary icon="terminal" label="Run details" variant="compact" /><div><p>Task {job.id}</p>{job.startedAt && <p>Started {job.startedAt}</p>}{job.endedAt && <p>Finished {job.endedAt}</p>}{job.note && <p>{job.note}</p>}{job.error && <pre>{job.error}</pre>}{job.result != null && <pre>{JSON.stringify(job.result, null, 2)}</pre>}</div></details>
      </div>
    </article>;
  };
  return <>
    <Button ref={trigger} size="sm" className="fd-activity-trigger" title={`Project activity: ${activityCount} active, ${attention.length} need attention`} aria-label={`Project activity: ${activityCount} active, ${attention.length} need attention`} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" onClick={() => { if (open) { setOpen(false); return; } filterChosen.current = false; setError(null); setLimit(20); setFilter(activityCount ? "active" : attention.length ? "attention" : "recent"); setOpen(true); void jobs.refetch(); void project.refetch(); }}><Icon name="activity" /><span className="fd-activity-label">Activity</span>{activityCount > 0 && <span className="fd-activity-count" aria-live="polite">{activityCount}</span>}{attention.length > 0 && <Icon name="warning" className="fd-activity-attention-icon" aria-hidden="true" />}</Button>
    {open && <aside ref={panel} id={panelId} role="dialog" aria-modal={false} aria-labelledby={headingId} tabIndex={-1} className="fd-activity-panel" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closePanel(); } }}>
      <header><div><h2 id={headingId}><Icon name="activity" />Project activity</h2><p>Follow work while using the canvas.</p></div><IconButton title="Close Project activity" onClick={closePanel}><Icon name="close" /></IconButton></header>
      <div className="fd-activity-scroll">
        {assistants.runs.length > 0 && <section aria-label="Working conversations" className="fd-activity-assistants"><h3>Working conversations</h3>{assistants.runs.map(({ thread }) => <div key={thread.id}><span><Spinner />{thread.title || "Conversation"}</span><Button size="sm" onClick={() => { if (!current()) return; const ui = useUiStore.getState(); ui.setActiveThread(thread.id); ui.focusComposer(); setOpen(false); }}>Open chat</Button></div>)}</section>}
        <div className="fd-activity-toolbar"><Tabs value={filter} onChange={next => { filterChosen.current = true; setLimit(20); setFilter(next); }} tabs={[{ id: "active", label: `Active · ${active.length}` }, { id: "attention", label: `Needs attention · ${attention.length}` }, { id: "recent", label: `Recent · ${recent.length}` }]} /><IconButton title="Refresh activity" disabled={jobs.isFetching} onClick={() => { void jobs.refetch(); void project.refetch(); }}><Icon name="refresh" /></IconButton></div>
        {jobs.isError && <LoadError title="Could not refresh task history" onRetry={() => void jobs.refetch()} />}
        {jobs.isPending && !rows.length ? <p role="status"><Spinner />Loading tasks…</p> : !visible.length ? <EmptyState title={filter === "active" ? "No background tasks running" : filter === "attention" ? "No recorded concerns" : "No recent tasks"}>{filter === "active" ? "Renders, exports and checks will appear here. You can keep working on another page." : filter === "attention" ? "Failed tasks, incomplete parts lists and reported check findings appear here. This is not a design-readiness check." : "Finished, cancelled and failed tasks appear here."}</EmptyState> : <ul className="fd-activity-tasks">{visibleGroups.map(group => {
          const first = group[0]!;
          return <li key={first.id}>{group.length === 1 ? renderJob(first) : <details className="fd-activity-read-group"><summary><Icon name="fileLayers" /><span><strong>{title(first)}</strong><small>{group.length} consecutive reads · expand to inspect each result</small></span><Icon name="chevronDown" /></summary>{group.map(renderJob)}</details>}</li>;
        })}</ul>}
        {groups.length > limit && <Button size="sm" className="fd-activity-more" onClick={() => setLimit(value => value + 20)}>Show more tasks</Button>}
        {error != null && <ErrorNotice error={error} />}
      </div>
    </aside>}
  </>;
}

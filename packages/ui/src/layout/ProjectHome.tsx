import { useState } from "react";
import { jobIsActive, projectJobs, useCoreClient, useJobs, useProjects, useRunsStore, useThreads } from "@fabdesk/client-core";
import { Button, EmptyState, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";

/** Choose one project before entering its workspace. Recency belongs to this core. */
export function ProjectHome({ onCreate, onImport, onBrowse }: { onCreate: () => void; onImport: () => void; onBrowse: () => void }) {
  const client = useCoreClient(), projects = useProjects(), jobs = useJobs(), threads = useThreads();
  const recent = useUiStore(s => s.recentProjectsByEndpoint[client.baseUrl]);
  const live = useRunsStore(s => s.jobs), runs = useRunsStore(s => s.runsByThread);
  const [query, setQuery] = useState("");
  const all = [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const visited = (recent ?? []).flatMap(id => { const project = all.find(project => project.id === id); return project ? [project] : []; });
  const ordered = [...visited, ...all.filter(project => !visited.some(item => item.id === project.id))];
  const shown = ordered.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="fd-project-home">
    <header><div><h1>Your projects</h1><p>Open a project, start with a sketch, or bring in a design from GitHub.</p></div><div className="fd-home-actions"><Button onClick={onImport}><Icon name="folderOpen" />Import from GitHub</Button><Button variant="primary" onClick={onCreate}><Icon name="plus" />New project</Button></div></header>
    <label className="fd-home-search"><Icon name="search" width={18} height={18} /><Input aria-label="Find a project" placeholder="Find a project…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="fd-home-list-heading"><h2>{query ? "Matching projects" : "Recent projects"}</h2><span>{shown.length} {shown.length === 1 ? "project" : "projects"}{!query && " · Opened recently first"}</span></div>
    {projects.isPending ? <p role="status"><Spinner />Loading projects…</p> : projects.isError ? <LoadError title="Could not load projects" onRetry={() => void projects.refetch()} /> : !shown.length ? <EmptyState title={query ? "No matching projects" : "Start your first project"}>{query ? "Try another name or path." : "Create a project for your idea, sketch or circuit files, or import an existing repository."}</EmptyState> : <ul className="fd-home-projects">{shown.map(project => {
      const active = projectJobs(project.id, jobs.data ?? [], live, client.baseUrl).filter(jobIsActive).length + (threads.data ?? []).filter(thread => thread.projectId === project.id && runs[thread.id]).length;
      return <li key={project.id}><button onClick={() => { const ui = useUiStore.getState(); if (ui.setActiveProject(project.id)) ui.setBoardOpen(true); }}><Icon name="folder" width={25} height={25} /><span><strong>{project.name}</strong><small title={project.path}>{project.path}</small></span>{active > 0 && <span className="fd-home-task-badge">{active} running</span>}<span className="fd-home-open">Open<Icon name="chevronRight" width={16} height={16} /></span></button></li>;
    })}</ul>}
    {jobs.isError && <p className="text-xs text-muted">Task status unavailable. Open a project to retry its activity.</p>}
    <footer><Button variant="ghost" onClick={onBrowse}><Icon name="library" />Browse open-source designs & conversations</Button><p>Closing a project keeps its saved files and conversations. Running tasks continue on the connected core.</p></footer>
  </div>;
}

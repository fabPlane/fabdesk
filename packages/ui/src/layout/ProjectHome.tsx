import { useState } from "react";
import { jobIsActive, projectJobs, useCoreClient, useJobs, useProjects, useRunsStore, useThreads } from "@fabdesk/client-core";
import { Button, EmptyState, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { ThreadView } from "../chat/ThreadView";

/** Choose one project before entering its workspace. Recency belongs to this core. */
export function ProjectHome({ onCreate, onImport, onBrowse, listing = false, onViewProjects }: { onCreate: () => void; onImport: () => void; onBrowse: () => void; listing?: boolean; onViewProjects: () => void }) {
  const client = useCoreClient(), projects = useProjects(), jobs = useJobs(), threads = useThreads();
  const recent = useUiStore(s => s.recentProjectsByEndpoint[client.baseUrl]);
  const live = useRunsStore(s => s.jobs), runs = useRunsStore(s => s.runsByThread);
  const [query, setQuery] = useState("");
  const all = [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const visited = (recent ?? []).flatMap(id => { const project = all.find(project => project.id === id); return project ? [project] : []; });
  const ordered = [...visited, ...all.filter(project => !visited.some(item => item.id === project.id))];
  const matches = ordered.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const shown = listing ? matches : ordered.slice(0, 3);
  return <div className={`fd-project-home ${listing ? "" : "fd-idea-home"}`}>
    {listing ? <><header><div><h1>Your projects & ideas</h1><p>Resume a project or keep exploring a saved draft.</p></div><div className="fd-home-actions"><Button onClick={onImport}><Icon name="folderOpen" />Import from GitHub</Button><Button variant="primary" onClick={onCreate}><Icon name="plus" />New project</Button></div></header>
    <label className="fd-home-search"><Icon name="search" width={18} height={18} /><Input aria-label="Find a project or idea" placeholder="Find a project or idea…" value={query} onChange={event => setQuery(event.target.value)} /></label></> : <section className="fd-home-idea" aria-label="Start with an idea"><ThreadView presentation="start" /><p className="fd-home-draft-note">Your ideas are saved as drafts. Create a project when you’re ready to build.</p></section>}
    <div className="fd-home-list-heading"><h2>{query && listing ? "Matching projects & ideas" : listing ? "Recent projects & ideas" : "Continue working"}</h2>{listing ? <span>{matches.length} saved workspaces · Opened recently first</span> : <Button variant="ghost" size="sm" onClick={onViewProjects}>View all projects<Icon name="chevronRight" width={16} height={16} /></Button>}</div>
    {projects.isPending ? <p role="status"><Spinner />Loading projects…</p> : projects.isError ? <LoadError title="Could not load projects" onRetry={() => void projects.refetch()} /> : !shown.length ? <EmptyState title={query && listing ? "No matching projects" : listing ? "No saved projects or ideas yet" : "Your work will appear here"}>{query && listing ? "Try another name or path." : listing ? "Start an idea from Home, create a project, or import a repository." : "Start with the composer or a sketch above. Your saved ideas and projects will be kept here."}</EmptyState> : <ul className="fd-home-projects">{shown.map(project => {
      const title = project.isDraft && project.name === "Untitled idea" ? (threads.data ?? []).find(thread => thread.projectId === project.id && thread.title && thread.title !== "New chat")?.title ?? project.name : project.name;
      const active = projectJobs(project.id, jobs.data ?? [], live, client.baseUrl).filter(jobIsActive).length + (threads.data ?? []).filter(thread => thread.projectId === project.id && runs[thread.id]).length;
      return <li key={project.id}><button onClick={() => { const ui = useUiStore.getState(); if (ui.setActiveProject(project.id)) ui.setBoardOpen(true); }}><Icon name={project.isDraft ? "compose" : "folder"} width={25} height={25} /><span><strong>{title}{project.isDraft && <em className="fd-idea-badge">Draft</em>}</strong><small title={project.path}>{listing ? project.path : `${project.isDraft ? "Idea draft" : "Project"} · Saved ${new Date(project.updatedAt).toLocaleDateString()}`}</small></span>{active > 0 && <span className="fd-home-task-badge">{active} running</span>}<span className="fd-home-open">Open<Icon name="chevronRight" width={16} height={16} /></span></button></li>;
    })}</ul>}
    {jobs.isError && <p className="text-xs text-muted">Task status unavailable. Open a project to retry its activity.</p>}
    {listing && <footer><Button variant="ghost" onClick={onBrowse}><Icon name="library" />Browse open-source designs & conversations</Button><p>Closing a project keeps its saved files and conversations. Running tasks continue on the connected core.</p></footer>}
  </div>;
}

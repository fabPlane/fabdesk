import { useState } from "react";
import { draftConversation, draftWorkspaceTitle, projectSketchImagePaths, useCoreIdentity, useProject, jobIsActive, projectJobs, useCoreClient, useJobs, useProjects, useRunsStore, useThreads } from "@fabdesk/client-core";
import { Button, EmptyState, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import type { ProjectSummary, Thread } from "@fabdesk/protocol";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectActionDialog, type ProjectAction } from "../sidebar/ProjectActionDialog";
import { ThreadView } from "../chat/ThreadView";

/** Choose one project before entering its workspace. Recency belongs to this core. */
export function ProjectHome({ onCreate, onImport, onBrowse, listing = false, onViewProjects }: { onCreate: () => void; onImport: () => void; onBrowse: () => void; listing?: boolean; onViewProjects: () => void }) {
  const client = useCoreClient(), projects = useProjects(), jobs = useJobs(), threads = useThreads();
  const coreIdentity = useCoreIdentity();
  const recent = useUiStore(s => s.recentProjectsByEndpoint[coreIdentity.data ? `core:${coreIdentity.data}` : client.baseUrl]);
  const live = useRunsStore(s => s.jobs), runs = useRunsStore(s => s.runsByThread);
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<ProjectAction | null>(null);
  const all = [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const visited = (recent ?? []).flatMap(id => { const project = all.find(project => project.id === id); return project ? [project] : []; });
  const ordered = [...visited, ...all.filter(project => !visited.some(item => item.id === project.id))];
  const matches = ordered.filter(project => `${draftWorkspaceTitle(project, threads.data ?? [])} ${project.name} ${project.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const shown = listing ? matches : ordered.slice(0, 3);
  return <div className={`fd-project-home ${listing ? "" : "fd-idea-home"}`}>
    {listing ? <><header><div><h1>Your projects & ideas</h1><p>Resume a project or keep exploring a saved draft.</p></div><div className="fd-home-actions"><Button onClick={onImport}><Icon name="folderOpen" />Import from GitHub</Button><Button variant="primary" onClick={onCreate}><Icon name="plus" />New project</Button></div></header>
    <label className="fd-home-search"><Icon name="search" width={18} height={18} /><Input aria-label="Find a project or idea" placeholder="Find a project or idea…" value={query} onChange={event => setQuery(event.target.value)} /></label></> : <section className="fd-home-idea" aria-label="Start with an idea"><ThreadView presentation="start" /><p className="fd-home-draft-note">Your ideas are saved as drafts. Create a project when you’re ready to build.</p></section>}
    <section className={listing ? undefined : "fd-home-resume"} aria-label="Saved projects and ideas">
    <div className="fd-home-list-heading"><div><h2>{query && listing ? "Matching projects & ideas" : listing ? "Recent projects & ideas" : "Open a project or draft"}</h2>{!listing && <p className="fd-home-resume-description">Pick up where you left off.</p>}</div>{listing ? <span>{matches.length} saved workspaces · Opened recently first</span> : <Button variant="ghost" size="sm" onClick={onViewProjects}>View all projects<Icon name="chevronRight" width={16} height={16} /></Button>}</div>
    {projects.isPending ? <p role="status"><Spinner />Loading projects…</p> : projects.isError ? <LoadError title="Could not load projects" onRetry={() => void projects.refetch()} /> : !shown.length ? <EmptyState title={query && listing ? "No matching projects" : listing ? "No saved projects or ideas yet" : "Your work will appear here"}>{query && listing ? "Try another name or path." : listing ? "Start an idea from Home, create a project, or import a repository." : "Start with the composer or a sketch above. Your saved ideas and projects will be kept here."}</EmptyState> : <ul className="fd-home-projects">{shown.map(project => {
      const title = draftWorkspaceTitle(project, threads.data ?? []);
      const active = projectJobs(project.id, jobs.data ?? [], live, client.baseUrl).filter(jobIsActive).length + (threads.data ?? []).filter(thread => thread.projectId === project.id && runs[thread.id]).length;
      return <SavedWorkspaceCard key={project.id} project={project} title={title} threads={threads.data ?? []} active={active} listing={listing} onRename={() => setAction({ id: project.id, name: title, action: "rename", isDraft: !!project.isDraft })} />;
    })}</ul>}
    {jobs.isError && <p className="text-xs text-muted">Task status unavailable. Open a project to retry its activity.</p>}
    </section>
    {action && <ProjectActionDialog key={action.id} project={action} onClose={() => setAction(null)} />}
    {listing && <footer><Button variant="ghost" onClick={onBrowse}><Icon name="library" />Browse open-source designs & conversations</Button><p>Closing a project keeps its saved files and conversations. Running tasks continue on the connected core.</p></footer>}
  </div>;
}

function SavedWorkspaceCard({ project, title, threads, active, listing, onRename }: { project: ProjectSummary; title: string; threads: Thread[]; active: number; listing: boolean; onRename: () => void }) {
  const detail = useProject(project.isDraft ? project.id : null);
  const preview = projectSketchImagePaths(detail.data?.files ?? [])[0];
  const icon = <Icon name={project.isDraft ? "compose" : "folder"} width={25} height={25} />;
  return <li className="fd-home-workspace-card">
    <button className="fd-home-workspace-open" onClick={() => {
      const ui = useUiStore.getState();
      if (!ui.setActiveProject(project.id)) return;
      ui.setBoardOpen(true);
      if (project.isDraft) ui.setActiveThread(draftConversation(project.id, threads)?.id ?? null);
    }}>
      <span className="fd-home-workspace-preview" aria-hidden="true">{preview ? <ProjectImage projectId={project.id} path={preview} alt="" fallback={icon} /> : icon}</span>
      <span className="fd-home-workspace-copy"><strong><span className="fd-home-workspace-title" title={title}>{title}</span>{project.isDraft && <em className="fd-idea-badge">Draft</em>}</strong><small title={project.path}>{listing ? project.path : `${project.isDraft ? "Idea draft" : "Project"} · Saved ${new Date(project.updatedAt).toLocaleDateString()}`}</small></span>
      {active > 0 && <span className="fd-home-task-badge">{active} running</span>}
      <span className="fd-home-open">Open<Icon name="chevronRight" width={16} height={16} /></span>
    </button>
    <button type="button" className="fd-home-workspace-rename" data-testid={`project-menu-${project.id}`} aria-label={`Rename ${project.isDraft ? "idea" : "project"}: ${title}`} title={project.isDraft ? "Rename idea" : "Rename project"} onClick={onRename}><Icon name="compose" width={16} height={16} /></button>
  </li>;
}

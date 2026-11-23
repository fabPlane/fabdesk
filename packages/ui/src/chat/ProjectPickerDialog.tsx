import { useState } from "react";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { Button, Dialog, LoadError, Spinner } from "../components/ui";

import { useProjects } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

/** Project picker shown whenever a new conversation starts. */
export function ProjectPickerDialog() {
  const open = useUiStore((s) => s.projectPickerOpen);
  const setOpen = useUiStore((s) => s.setProjectPickerOpen);
  const startNewChatInProject = useUiStore((s) => s.startNewChatInProject);
  const projects = useProjects();
  const activeProjectId = useUiStore(s => s.activeProjectId);

  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fromPhoto, setFromPhoto] = useState(false);

  const choose = (projectId: string) => {
    startNewChatInProject(projectId);
    setCreating(false);
    setImporting(false);
    setFromPhoto(false);

  };

  if (open && activeProjectId) return <Dialog open onClose={() => setOpen(false)} title="New conversation"><p>Start in {projects.data?.find(project => project.id === activeProjectId)?.name ?? "this project"}, or return to Home to choose another. Cancel keeps your current conversation.</p><div className="mt-4 flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => choose(activeProjectId)}>Start conversation here</Button><Button onClick={() => { setOpen(false); useUiStore.getState().requestProjectClose(true); }}>Close project · Home</Button></div></Dialog>;

  if (open && (creating || importing || fromPhoto)) return <CreateProjectDialog initialMode={importing ? "github" : fromPhoto ? "photo" : "create"} onClose={() => { setCreating(false); setImporting(false); setFromPhoto(false); }} onCreated={choose} />;

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Which project?" className="w-[420px]">
      <p className="mb-4 text-[13px] leading-5 text-muted">
        Choose an existing project, or create or import one to start chatting.
      </p>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {projects.isPending && <div className="p-3"><Spinner /></div>}
        {projects.isError && <LoadError title="Could not load projects" onRetry={() => void projects.refetch()} />}
        {(projects.data ?? []).map((project) => (
          <button
            key={project.id}
            type="button"
            className="rounded-lg border border-transparent px-3 py-2.5 text-left text-[13px] hover:border-border hover:bg-panel-2/70"
            onClick={() => choose(project.id)}
            data-testid={`picker-project-${project.id}`}
          >
            <div className="truncate font-semibold" title={project.name}>{project.name}</div>
            <div className="truncate text-[11px] text-muted">{project.path}</div>
          </button>
        ))}
        {projects.data?.length === 0 && <div className="px-1 py-3 text-xs text-muted">No local projects yet.</div>}
      </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setCreating(true)}>
            New project
          </Button>
          <Button onClick={() => setFromPhoto(true)} data-testid="picker-start-from-photo">Start from a photo</Button>
          <Button onClick={() => setImporting(true)}>Import from GitHub</Button>
        </div>

    </Dialog>
  );
}

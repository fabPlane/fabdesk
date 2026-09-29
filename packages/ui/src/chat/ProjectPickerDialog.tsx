import { useState } from "react";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { Button, Dialog } from "../components/ui";

import { useProjects } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

/** Project picker shown whenever a new conversation starts. */
export function ProjectPickerDialog() {
  const open = useUiStore((s) => s.projectPickerOpen);
  const setOpen = useUiStore((s) => s.setProjectPickerOpen);
  const startNewChatInProject = useUiStore((s) => s.startNewChatInProject);
  const projects = useProjects();

  const [creating, setCreating] = useState(false);

  const choose = (projectId: string | null) => {
    startNewChatInProject(projectId);
    setCreating(false);

  };

  if (open && creating) return <CreateProjectDialog onClose={() => setCreating(false)} onCreated={choose} />;

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Which project?" className="w-[420px]">
      <p className="mb-4 text-[13px] leading-5 text-muted">
        Choose a project for this conversation, or continue without one.
      </p>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
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
          <Button onClick={() => choose(null)}>Continue without a project</Button>
        </div>

    </Dialog>
  );
}

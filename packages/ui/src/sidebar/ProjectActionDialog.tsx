import { useState } from "react";
import { useDeleteProject, useRenameProject } from "@fabdesk/client-core";
import { Button, Dialog, Input } from "../components/ui";
import { useUiStore } from "../stores/ui";

export interface ProjectAction {
  id: string;
  name: string;
  action: "rename" | "delete";
}

export function ProjectActionDialog({ project, onClose }: { project: ProjectAction; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const rename = useRenameProject();
  const remove = useDeleteProject();
  const deleting = project.action === "delete";
  const pending = rename.isPending || remove.isPending;
  const error = rename.error ?? remove.error;
  const close = () => { if (!pending) onClose(); };
  const submit = async () => {
    if (pending || (!deleting && !name.trim())) return;
    try {
      if (deleting) {
        await remove.mutateAsync({ projectId: project.id });
        const ui = useUiStore.getState();
        ui.setProjectPinned(project.id, false);
        if (ui.activeProjectId === project.id) ui.setActiveProject(null);
      } else {
        await rename.mutateAsync({ projectId: project.id, name: name.trim() });
      }
      onClose();
    } catch { /* The mutation error stays visible; keep the dialog open for retry. */ }
  };
  return <Dialog open onClose={close} closeDisabled={pending} title={deleting ? "Delete project?" : "Rename project"} className="!w-[420px]"
    fallbackFocus={() => document.querySelector<HTMLElement>(`[data-testid="project-menu-${CSS.escape(project.id)}"]`) ?? document.querySelector<HTMLElement>('[data-testid="sidebar-new-chat"]') ?? document.querySelector<HTMLElement>(".fd-project-switcher summary")}>
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {deleting ? <p className="break-words text-sm leading-6 text-muted">Remove <strong className="text-fg">{project.name}</strong> from your projects? Files on your computer will be kept. Chats will move to No project.</p> :
        <label className="flex flex-col gap-2 text-sm">Project name
          <Input autoFocus required maxLength={80} value={name} disabled={pending} onChange={(e) => setName(e.target.value)} data-testid="rename-project-name" />
        </label>}
      {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" disabled={pending} onClick={close}>Cancel</Button>
        <Button type="submit" variant={deleting ? "danger" : "primary"} disabled={pending || (!deleting && !name.trim())}>
          {pending ? deleting ? "Deleting…" : "Saving…" : deleting ? "Delete" : "Save"}
        </Button>
      </div>
    </form>
  </Dialog>;
}

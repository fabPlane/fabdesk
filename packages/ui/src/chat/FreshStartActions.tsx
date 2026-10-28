import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCoreClient } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";

export function FreshStartActions() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ui = () => useUiStore.getState();
  const createArt = async () => {
    if (creating) return;
    const originProjectId = ui().activeProjectId;
    const originThreadId = ui().activeThreadId;
    setCreating(true); setError(null);
    try {
      const project = await client.createProject("Untitled art board");
      await qc.invalidateQueries({ queryKey: ["projects"] });
      // Never replace the board of a project selected while creation was in flight.
      if (ui().activeProjectId === originProjectId && ui().activeThreadId === originThreadId) {
        if (!originProjectId) ui().adoptSketchProject(project.id);
        else ui().setActiveProject(project.id);
        ui().setBoardTab("art");
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setCreating(false); }
  };
  return <>
    <div className="fd-fresh-actions" aria-label="Start your project">
      <Button onClick={() => ui().focusComposer()}><Icon name="sparkles" width={18} height={18} />Describe an idea</Button>
      <WorkspaceMenu className="fd-start-sketch-menu" label={<><Icon name="image" width={18} height={18} /><span>Sketch or image</span><Icon name="chevronDown" width={14} height={14} /></>}>
        <button onClick={() => ui().setSketchOpen(true, "draw")}><Icon name="compose" width={18} height={18} /><span>Draw or open a sketch<small>New drawing or .excalidraw file</small></span></button>
        <button onClick={() => ui().setSketchOpen(true, "upload")}><Icon name="paperclip" width={18} height={18} /><span>Upload a reference image<small>PNG or JPEG</small></span></button>
        <p>Your sketch stays with the project</p>
      </WorkspaceMenu>
      <Button onClick={() => setImporting(true)}><Icon name="folderOpen" width={18} height={18} />Import design</Button>
      <Button disabled={creating} onClick={() => void createArt()}><Icon name="pcb" width={18} height={18} />{creating ? "Creating…" : "Create art board"}</Button>
    </div>
    {error && <p role="alert" className="text-center text-sm text-danger">{error}</p>}
    {importing && <CreateProjectDialog initialMode="github" onClose={() => setImporting(false)} onCreated={(id) => { ui().setActiveProject(id); ui().setBoardOpen(true); setImporting(false); }} />}
  </>;
}

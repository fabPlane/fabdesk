import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCoreClient, useProject } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { useUiStore } from "../stores/ui";

export function FreshStartActions() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ui = () => useUiStore.getState();
  const home = useUiStore(s => !s.activeProjectId);
  const projectId = useUiStore(s => s.activeProjectId);
  const project = useProject(projectId);
  const createArt = async () => {
    if (creating) return;
    if (ui().activeProjectId) { ui().setBoardTab("art"); return; }
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
      <Button onClick={() => ui().setSketchOpen(true, "draw")}><Icon name="compose" width={18} height={18} />Draw a sketch</Button>
      <Button onClick={() => ui().setSketchOpen(true, "upload")}><Icon name="image" width={18} height={18} />Upload an image</Button>
      {!ui().activeProjectId && <Button onClick={() => setImporting(true)}><Icon name="folderOpen" width={18} height={18} />Import from GitHub</Button>}
    </div>
    {!home && !project.data?.manifest.ideaDraft && <button className="fd-fresh-art-link" disabled={creating} onClick={() => void createArt()}>{creating ? "Creating art board…" : "Create an art board"}</button>}
    {error && <p role="alert" className="text-center text-sm text-danger">{error}</p>}
    {importing && <CreateProjectDialog initialMode="github" onClose={() => setImporting(false)} onCreated={(id) => { ui().setActiveProject(id); ui().setBoardOpen(true); setImporting(false); }} />}
  </>;
}

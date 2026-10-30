import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useEffect, useRef, useState } from "react";
import { Button, LoadError, Spinner } from "../components/ui";
import { useCoreClient } from "@fabdesk/client-core";
import { useOpenSourceProject, useRemixOpenSource } from "@fabdesk/client-core";
import { CatalogThumb } from "./CatalogThumb";
import { useUiStore } from "../stores/ui";

export function OpenSourceView() {
  const id = useUiStore((s) => s.activeOpenSourceId);
  const client = useCoreClient();
  const mounted = useRef(true), currentClient = useRef(client); currentClient.current = client;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const setActiveOpenSourceId = useUiStore((s) => s.setActiveOpenSourceId);
  const setSidebarListTab = useUiStore((s) => s.setSidebarListTab);
  const setBoardOpen = useUiStore((s) => s.setBoardOpen);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const project = useOpenSourceProject(id);
  const remix = useRemixOpenSource();
  const entry = project.data;
  const projectId = useUiStore(s => s.activeProjectId);
  useAssistantSurface(projectId && id ? { projectId, scope: "catalog", label: `Catalog / ${entry?.name ?? id}`, priority: 10, details: JSON.stringify({ catalogId: id, name: entry?.name, loading: project.isLoading, loadFailed: project.isError, creatingRemix: remix.isPending, instruction: "This is a catalog preview. It is not a board in the active project; remix creates a separate local project." }) } : null);
  const hero = id ? client.openSourcePreviewUrl(id, "hero") : "";
  const [heroFailed, setHeroFailed] = useState(false);
  useEffect(() => {
    setHeroFailed(false);
  }, [id]);

  const onRemix = async () => {
    if (!id || remix.isPending) return;
    let result;
    try { result = await remix.mutateAsync(id); }
    catch { return; } // Keep the mutation error visible with the existing Retry/Remix action.
    // Finishing an import must not steal navigation after the user left its preview.
    const ui = useUiStore.getState();
    if (!mounted.current || currentClient.current !== client || ui.activeOpenSourceId !== id || ui.activeProjectId !== projectId) return;
    setActiveProject(result.project.id);
    setActiveThread(null);
    setActiveOpenSourceId(null);
    setSidebarListTab("projects");
    setBoardTab(result.pcbPath ? "pcb" : "files");
    setBoardOpen(true);
    useUiStore.getState().setAssistantOpen(false);
    if (!result.pcbPath) {
      const readme = result.project.files.find(file => /^readme(?:\.[^/]+)?$/i.test(file.path));
      if (readme) useUiStore.getState().openProjectFile(readme.path);
    }
  };

  if (!id) return null;
  if (project.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading project…
      </div>
    );
  }
  if (!entry) {
    return <LoadError title="Could not load this project" onRetry={() => void project.refetch()} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-testid="opensource-view">
      <div className="fd-screen-header flex items-center justify-between gap-2 border-b border-border px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{entry.name}</div>
          <div className="truncate text-[11px] text-muted">
            {entry.source?.owner ?? entry.ownerSlug} / {entry.slug}
          </div>
        </div>
        <Button variant="primary" disabled={remix.isPending} onClick={() => void onRemix()} data-testid="remix-button">
          {remix.isPending ? "Cloning…" : "Remix"}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_50%_40%,#f6f3e8,#8d887c)] dark:bg-[radial-gradient(circle_at_50%_40%,#2a2e28,#121410)]">
        {hero && !heroFailed ? (
          <img
            src={hero}
            alt={`${entry.name} 3D preview`}
            className="h-full w-full object-contain p-8"
            onError={() => setHeroFailed(true)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
            <CatalogThumb name={entry.name} className="h-16 w-16 text-lg" />
            No 3D preview yet.
          </div>
        )}
      </div>
      {entry.description && <div className="max-h-40 shrink-0 overflow-auto break-words border-t border-border px-4 py-3 text-[13px] text-muted">{entry.description}</div>}
      {remix.isError && (
        <div className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          {(remix.error as Error).message}
        </div>
      )}
    </div>
  );
}

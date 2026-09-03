import { Button, Spinner } from "../components/ui";
import { useOpenSourceProject, useRemixOpenSource } from "../hooks/queries";
import { useUiStore } from "../stores/ui";

export function OpenSourceView() {
  const id = useUiStore((s) => s.activeOpenSourceId);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const setActiveOpenSourceId = useUiStore((s) => s.setActiveOpenSourceId);
  const setSidebarListTab = useUiStore((s) => s.setSidebarListTab);
  const setBoardOpen = useUiStore((s) => s.setBoardOpen);
  const focusComposer = useUiStore((s) => s.focusComposer);
  const project = useOpenSourceProject(id);
  const remix = useRemixOpenSource();
  const entry = project.data;
  const hero = entry?.heroUrl ?? entry?.previewUrl;

  const onRemix = async () => {
    if (!id) return;
    const result = await remix.mutateAsync(id);
    setActiveProject(result.project.id);
    setActiveThread(null);
    setActiveOpenSourceId(null);
    setSidebarListTab("projects");
    setBoardOpen(true);
    focusComposer();
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
    return <div className="flex h-full items-center justify-center text-sm text-danger">Could not load this project.</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-testid="opensource-view">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border px-4">
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
        {hero ? (
          <img src={hero} alt={`${entry.name} 3D preview`} className="h-full w-full object-contain p-8" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">No 3D preview yet.</div>
        )}
      </div>
      {entry.description && <div className="border-t border-border px-4 py-3 text-[13px] text-muted">{entry.description}</div>}
      {remix.isError && (
        <div className="border-t border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          {(remix.error as Error).message}
        </div>
      )}
    </div>
  );
}

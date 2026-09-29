import { useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { useProject } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { basename, isImagePath } from "../util";
import { useRunTool } from "@fabdesk/client-core";

export function RendersTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const [open, setOpen] = useState<string | null>(null);
  const render = useRunTool();
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load renders" onRetry={() => void project.refetch()} />;
  if (project.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const images = (project.data?.files ?? [])
    .filter((f) => f.path.startsWith("renders/") && isImagePath(f.path) && !f.path.endsWith(".svg"))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  const button = (
    <Button variant="primary" size="sm" disabled={render.state.status === "running"} onClick={() => void render.run("render", { projectId })}>
      {render.state.status === "running" ? "Rendering..." : "Render board"}
    </Button>
  );
  if (images.length === 0) {
    return (
      <EmptyState title="No renders yet" action={button}>
        KiCad renders of the board (top/bottom PNGs) appear here.
        {render.state.error && <div className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {button}
        {render.state.error && <span className="text-xs text-danger">{render.state.error}</span>}
        <span className="ml-auto text-[11px] text-muted">{images.length} image{images.length === 1 ? "" : "s"}</span>
      </div>
      <div className="fd-render-grid grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
        {images.map((f) => (
          <button key={f.path} className="group text-left" onClick={() => setOpen(f.path)}>
            <ProjectImage projectId={projectId} path={f.path} className="max-h-none w-full object-contain" />
            <div className="mt-1 truncate text-[11px] text-muted group-hover:text-fg">{basename(f.path)}</div>
          </button>
        ))}
      </div>
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ? basename(open) : ""} className="w-[90vw] max-w-5xl">
        {open && <ProjectImage projectId={projectId} path={open} className="max-h-[75vh] w-full object-contain" />}
      </Dialog>
    </div>
  );
}

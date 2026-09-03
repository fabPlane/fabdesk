import type { OpenCatalogEntry } from "@fabdesk/protocol";
import { useState } from "react";
import { Input } from "../components/ui";
import { useOpenCatalog } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

export function OpenSourceList() {
  const [q, setQ] = useState("");
  const catalog = useOpenCatalog(q);
  const activeId = useUiStore((s) => s.activeOpenSourceId);
  const setActiveOpenSourceId = useUiStore((s) => s.setActiveOpenSourceId);
  const projects = catalog.data?.projects ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search open source..."
          className="h-7 text-xs"
          data-testid="opensource-search"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1">
        {catalog.isLoading && <div className="px-2 py-3 text-xs text-muted">Loading catalog...</div>}
        {catalog.isError && <div className="px-2 py-3 text-xs text-danger">Could not load open source projects</div>}
        {projects.map((project) => (
          <OpenSourceRow
            key={project.id}
            project={project}
            active={project.id === activeId}
            onOpen={() => setActiveOpenSourceId(project.id)}
          />
        ))}
        {catalog.data && projects.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted">No matching projects.</div>
        )}
      </div>
    </div>
  );
}

function OpenSourceRow({
  project,
  active,
  onOpen,
}: {
  project: OpenCatalogEntry;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        active ? "bg-panel-2 text-fg" : "text-fg/90 hover:bg-panel-2/70",
      )}
      data-testid={`opensource-${project.slug}`}
    >
      <img
        src={project.previewUrl}
        alt=""
        className="h-8 w-8 shrink-0 rounded-md border border-border bg-panel-2 object-cover"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{project.name}</span>
        <span className="block truncate text-[10px] text-muted">
          {project.source?.owner ?? project.ownerSlug} / {project.slug}
        </span>
      </span>
    </button>
  );
}

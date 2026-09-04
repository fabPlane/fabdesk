import type { OpenCatalogEntry } from "@fabdesk/protocol";
import { useState } from "react";
import { Input } from "../components/ui";
import { useCoreClient } from "../core/CoreProvider";
import { useOpenCatalog } from "../hooks/queries";
import { CatalogThumb } from "../opensource/CatalogThumb";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

export function OpenSourceList() {
  const [q, setQ] = useState("");
  const catalog = useOpenCatalog(q);
  const client = useCoreClient();
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
            previewSrc={client.openSourcePreviewUrl(project.id)}
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
  previewSrc,
  active,
  onOpen,
}: {
  project: OpenCatalogEntry;
  previewSrc: string;
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
      <CatalogThumb src={previewSrc} name={project.name} className="h-8 w-8 text-[10px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{project.name}</span>
        <span className="block truncate text-[10px] text-muted">
          {project.source?.owner ?? project.ownerSlug} / {project.slug}
        </span>
      </span>
    </button>
  );
}

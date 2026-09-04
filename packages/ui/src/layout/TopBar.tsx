import { Badge, IconButton } from "../components/ui";
import { UpdateBadge } from "../components/UpdateBadge";
import { useCore } from "../core/CoreProvider";
import { useProjects } from "../hooks/queries";
import { useAuthStore } from "../stores/auth";
import { useUiStore } from "../stores/ui";
import { cn, modKey } from "../util";
import type { CoreStatusInfo } from "../app/types";

export function TopBar({ coreStatus }: { coreStatus?: CoreStatusInfo | undefined }) {
  const { host, sseStatus, client } = useCore();
  const auth = useAuthStore((s) => s.state);
  const projectId = useUiStore((s) => s.activeProjectId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const boardOpen = useUiStore((s) => s.boardOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleBoard = useUiStore((s) => s.toggleBoard);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);
  const mod = modKey(host.platform);
  const mac = host.platform === "darwin";
  const port = (() => {
    try {
      return new URL(client.baseUrl).port;
    } catch {
      return "";
    }
  })();
  const connected = sseStatus === "open" && (coreStatus?.state ?? "ready") === "ready";
  return (
    <div
      className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-xs", mac && "pl-20")}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="flex items-center gap-1">
        <IconButton title={`Toggle sidebar (${mod}B)`} onClick={toggleSidebar} className={cn(sidebarOpen && "text-accent")}>
          &#9776;
        </IconButton>
      </div>
      <span className="fd-wordmark">fab<b>Plane</b></span>
      {project && <span className="text-muted">/ {project.name}</span>}
      <div className="ml-auto flex items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <UpdateBadge />
        {auth?.mode === "local" && (
          <Badge tone="warning" title="Running with --local-auth; no fabPlane account">
            Local mode
          </Badge>
        )}
        <Badge
          tone={connected ? "success" : coreStatus?.state === "crashed" ? "danger" : "warning"}
          title={coreStatus?.message ?? `SSE ${sseStatus}`}
        >
          core {connected ? `connected${port ? ` :${port}` : ""}` : (coreStatus?.state ?? sseStatus)}
        </Badge>
        <IconButton title={`Command palette (${mod}K)`} onClick={() => setPaletteOpen(true)}>
          &#8984;
        </IconButton>
        <IconButton title={`Board panel (${mod}Shift+B)`} onClick={toggleBoard} className={cn(boardOpen && "text-accent")}>
          &#9707;
        </IconButton>
        <IconButton title={`Settings (${mod},)`} onClick={() => setSettingsOpen(true)}>
          &#9881;
        </IconButton>
      </div>
    </div>
  );
}

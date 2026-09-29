import { Badge, IconButton } from "../components/ui";
import { Icon } from "../components/Icon";
import { UpdateBadge } from "../components/UpdateBadge";
import { useCore } from "@fabdesk/client-core";
import { useProjects } from "@fabdesk/client-core";
import { useAuthStore } from "@fabdesk/client-core";
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
  // macOS keeps File / Edit / View / Window in the system menu bar; elsewhere the host hides its
  // in-window menu bar and this button pops the same menu below itself.
  const showAppMenu = !mac && host.showAppMenu ? host.showAppMenu : undefined;
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
      className={cn("fd-surface-inset flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel px-2.5 text-xs", mac && "pl-20")}
      style={
        {
          WebkitAppRegion: "drag",
          // Windows controls overlay: keep the right-hand actions clear of minimize/maximize/close.
          // Without an overlay the env() fallbacks make this exactly the normal 0.5rem padding.
          paddingRight: "calc(0.5rem + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))",
        } as React.CSSProperties
      }
    >
      <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="flex items-center gap-0.5 border-r border-border pr-2">
        {showAppMenu && (
          <IconButton
            title="Menu"
            data-testid="app-menu-button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              void showAppMenu({ x: r.left, y: r.bottom + 2 });
            }}
          >
            <Icon name="menu" />
          </IconButton>
        )}
        <IconButton title={`Toggle sidebar (${mod}B)`} onClick={toggleSidebar} className={cn(sidebarOpen && "text-accent")}>
          <Icon name="sidebar" />
        </IconButton>
      </div>
      <span className="fd-wordmark ml-1 text-[15px]">fab<b>Plane</b></span>
      {host.devBuild && (
        <Badge tone="warning" title="Development build — isolated from the installed fabPlane app">
          Dev
        </Badge>
      )}
      {project && <span className="min-w-0 max-w-60 truncate border-l border-border pl-3 text-[12px] font-medium text-muted" title={project.name}>{project.name}</span>}
      <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
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
          <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
          core {connected ? `connected${port ? ` :${port}` : ""}` : (coreStatus?.state ?? sseStatus)}
        </Badge>
        <span className="mx-1 h-4 w-px bg-border" />
        <IconButton title={`Command palette (${mod}K)`} onClick={() => setPaletteOpen(true)}>
          <Icon name="search" />
        </IconButton>
        <IconButton title={`Board panel (${mod}Shift+B)`} onClick={toggleBoard} className={cn(boardOpen && "text-accent")}>
          <Icon name="panel" />
        </IconButton>
        <IconButton title={`Settings (${mod},)`} onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" />
        </IconButton>
      </div>
    </div>
  );
}

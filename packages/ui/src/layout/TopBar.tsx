import { ProfileButton } from "../auth/ProfileAccountDialog";
import { WorkspaceBackButton } from "./WorkspaceBackButton";
import { Badge, Button, IconButton } from "../components/ui";
import { Icon } from "../components/Icon";
import { UpdateBadge } from "../components/UpdateBadge";
import { WhatsNewLink } from "../whatsnew/WhatsNew";
import { useCore } from "@fabdesk/client-core";
import { useProjects } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn, modKey } from "../util";
import type { CoreStatusInfo } from "../app/types";

export function TopBar({ coreStatus }: { coreStatus?: CoreStatusInfo | undefined }) {
  const { host, sseStatus, client } = useCore();
  const projectId = useUiStore((s) => s.activeProjectId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
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
      className={cn("fd-topbar fd-surface-inset flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-2.5 text-xs", mac && "pl-20", host.platform === "win32" && "fd-topbar-windows")}
      style={
        {
          WebkitAppRegion: "drag",
          // Windows controls overlay: keep the right-hand actions clear of minimize/maximize/close.
          // Convert viewport CSS units to unzoomed chrome units. Without an overlay the
          // env() fallbacks leave exactly the normal 0.5rem padding.
          paddingRight: "calc(0.5rem + (100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)) * var(--fd-page-zoom, 1))",
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
            <Icon name="menu" width={20} height={20} />
          </IconButton>
        )}
        <IconButton title={`Toggle sidebar (${mod} + B)`} onClick={toggleSidebar} className={cn(sidebarOpen && "text-accent")}>
          <Icon name="sidebar" width={20} height={20} />
        </IconButton>
      </div>
      <span className="fd-wordmark ml-1 text-[15px]">fab<b>Plane</b></span>
      {host.devBuild && (
        <Badge tone="warning" title="Development build — isolated from the installed fabPlane app">
          Dev
        </Badge>
      )}
      {project && <span className="fd-topbar-project min-w-0 max-w-60 truncate border-l border-border pl-3 text-[12px] font-medium text-muted" title={project.name}>{project.name}</span>}
      <div data-topbar-actions className="fd-topbar-actions ml-auto flex min-w-0 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {projectId && <WorkspaceBackButton />}
        {projectId && <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().requestProjectClose(true)}>Home</Button>}
        <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().setCanvasMode(true)} title="Return to the canvas workspace"><Icon name="pcb" width={16} height={16} />Canvas</Button>
        <WhatsNewLink />
        <UpdateBadge />
        <Badge
          tone={connected ? "success" : coreStatus?.state === "crashed" ? "danger" : "warning"}
          title={coreStatus?.message ?? `Core ${coreStatus?.state ?? "ready"}; SSE ${sseStatus}${port ? `; port ${port}` : ""}`}
          className="fd-topbar-status"
        >
          <span className="fd-topbar-status-dot mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
          <span className="fd-topbar-status-text">{connected ? "Core connected" : `Core ${coreStatus?.state ?? sseStatus}`}</span>
        </Badge>
        <ProfileButton />
        <div className="fd-topbar-tools flex items-center gap-1">
          <IconButton title={`Command palette (${mod} + K)`} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" width={20} height={20} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

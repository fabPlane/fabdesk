import { Badge, IconButton } from "../components/ui";
import { UpdateBadge } from "../components/UpdateBadge";
import { useCore } from "../core/CoreProvider";
import { useProjects } from "../hooks/queries";
import { useAuthStore } from "../stores/auth";
import { useUiStore } from "../stores/ui";
import { cn, modKey } from "../util";
import type { CoreStatusInfo } from "../app/types";

function MenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
    </svg>
  );
}

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
      className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-xs", mac && "pl-20")}
      style={
        {
          WebkitAppRegion: "drag",
          // Windows controls overlay: keep the right-hand actions clear of minimize/maximize/close.
          // Without an overlay the env() fallbacks make this exactly the normal 0.5rem padding.
          paddingRight: "calc(0.5rem + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))",
        } as React.CSSProperties
      }
    >
      <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} className="flex items-center gap-0.5">
        {showAppMenu && (
          <IconButton
            title="Menu"
            data-testid="app-menu-button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              void showAppMenu({ x: r.left, y: r.bottom + 2 });
            }}
          >
            <MenuIcon />
          </IconButton>
        )}
        <IconButton title={`Toggle sidebar (${mod}B)`} onClick={toggleSidebar} className={cn(sidebarOpen && "text-accent")}>
          <SidebarIcon />
        </IconButton>
      </div>
      <span className="fd-wordmark">fab<b>Plane</b></span>
      {host.devBuild && (
        <Badge tone="warning" title="Development build — isolated from the installed fabPlane app">
          Dev
        </Badge>
      )}
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

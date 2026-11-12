import { useCallback, useEffect, useRef, useState } from "react";
import { principalInitials, principalLabel } from "../auth/principal";
import { Badge, IconButton, Kbd, MenuItem } from "../components/ui";
import { Icon } from "../components/Icon";
import { useCore } from "@fabdesk/client-core";
import { useAuthStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn, modKey } from "../util";

/**
 * Bottom-left account strip: avatar + name open a popup menu with account actions;
 * the gear opens Settings directly. Renders nothing unless the core reports a signed-in state.
 */
export function UserFooter() {
  const { host } = useCore();
  const auth = useAuthStore((s) => s.state);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setInventoryOpen = useUiStore((s) => s.setInventoryOpen);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)') ?? []);
    items().forEach((item) => item.setAttribute("role", "menuitem"));
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); triggerRef.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const options = items();
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);

  if (!auth || auth.status !== "signed_in") return null;

  const label = principalLabel(auth.principal, auth.mode);
  const email = auth.principal?.email;
  const local = auth.mode === "local";
  const mod = modKey(host.platform);

  const openSettings = (section?: Parameters<typeof setSettingsOpen>[1]) => {
    close();
    setSettingsOpen(true, section);
  };

  return (
    <div
      ref={rootRef}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
      className="relative shrink-0 border-t border-border bg-panel px-3 py-2"
      data-testid="user-footer"
    >
      {open && (
        <div
          role="menu"
          className="fd-elevated absolute bottom-full left-2 right-2 z-40 mb-2 rounded-xl border border-border bg-panel p-1.5"
        >
          <div className="px-2.5 pb-1.5 pt-1">
            <div className="truncate text-[13px] font-medium">{label}</div>
            {email && <div className="truncate text-[11px] text-muted">{email}</div>}
            {local && (
              <Badge tone="warning" className="mt-1">
                Local mode
              </Badge>
            )}
          </div>
          <div className="my-1 border-t border-border" />
          <MenuItem onClick={() => openSettings("auth")}>Account</MenuItem>
          <MenuItem onClick={() => openSettings()}>
            <span>Settings</span>
            <span className="ml-auto">
              <Kbd>{mod} + ,</Kbd>
            </span>
          </MenuItem>
          <MenuItem onClick={() => openSettings("shortcuts")}>Keyboard shortcuts</MenuItem>
          <MenuItem
            onClick={() => {
              close();
              setInventoryOpen(true);
            }}
          >
            Parts Inventory
          </MenuItem>
          {!local && auth.dashboardUrl && (
            <MenuItem
              onClick={() => {
                close();
                void host.openExternal(auth.dashboardUrl!);
              }}
            >
              fabplane dashboard <span className="ml-auto text-muted">&#8599;</span>
            </MenuItem>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-panel-2",
            open && "bg-panel-2",
          )}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`${email ? `${label} (${email})` : label}${local ? " · Local mode" : ""}`}
          data-testid="user-menu-button"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-panel-2 text-[11px] font-semibold text-fg">
            {principalInitials(label)}
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {local && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-warning"
              title="Local mode: running with --local-auth; no fabPlane account"
              data-testid="local-mode-status"
            >
              <span className="sr-only">Local mode</span>
            </span>
          )}
          <span className="flex-1" />
        </button>
        <IconButton title={`Settings (${mod} + ,)`} onClick={() => openSettings()}>
          <Icon name="settings" />
        </IconButton>
      </div>
    </div>
  );
}

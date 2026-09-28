import { useCallback, useEffect, useRef, useState } from "react";
import { principalInitials, principalLabel } from "../auth/principal";
import { Badge, IconButton, Kbd, MenuItem } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useAuthStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn, modKey } from "../util";

/**
 * Bottom-left account strip: avatar + name open a popup menu with account actions;
 * the gear opens Settings directly. Renders nothing unless the core reports a signed-in state.
 */
export function UserFooter() {
  const { client, host } = useCore();
  const auth = useAuthStore((s) => s.state);
  const localAllowed = useAuthStore((s) => s.localAllowed);
  const setAuthState = useAuthStore((s) => s.setState);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
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

  const signOut = async () => {
    close();
    setBusy(true);
    try {
      if (local) {
        await host.setLocalAuth?.(false);
      } else {
        await client.logout();
        setAuthState(await client.authState());
      }
    } catch {
      // The auth store keeps its last state; the Account settings section surfaces errors.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0 border-t border-border px-2 py-1.5"
      data-testid="user-footer"
    >
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-2 right-2 z-40 mb-1 rounded-lg border border-border bg-panel p-1 shadow-xl"
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
              <Kbd>{mod},</Kbd>
            </span>
          </MenuItem>
          <MenuItem onClick={() => openSettings("shortcuts")}>Keyboard shortcuts</MenuItem>
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
          {(!local || (localAllowed && host.setLocalAuth)) && (
            <>
              <div className="my-1 border-t border-border" />
              <MenuItem danger onClick={() => void signOut()}>
                {local ? "Leave local mode" : "Sign out"}
              </MenuItem>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-panel-2",
            open && "bg-panel-2",
          )}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          title={email ? `${label} (${email})` : label}
          data-testid="user-menu-button"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[11px] font-semibold text-muted">
            {principalInitials(label)}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
        <IconButton title={`Settings (${mod},)`} onClick={() => openSettings()}>
          &#9881;
        </IconButton>
      </div>
    </div>
  );
}

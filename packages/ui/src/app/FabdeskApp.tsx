import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ProfileAccountDialog } from "../auth/ProfileAccountDialog";
import { LoginScreen } from "../auth/LoginScreen";
import { Button, Spinner } from "../components/ui";
import { UpdateBadge } from "../components/UpdateBadge";
import { useCore, usePrivacy, useSettings, type HostAdapter } from "@fabdesk/client-core";
import { CoreProvider } from "../core/CoreProvider";
import { browserHost } from "../core/host";
import type { CoreClient } from "@fabdesk/client-core";
import { useAuthState } from "@fabdesk/client-core";
import { useShortcuts } from "../hooks/useShortcuts";
import { useTheme } from "../hooks/useTheme";
import { CloseProjectDialog } from "../layout/CloseProjectDialog";
import { AppShell } from "../layout/AppShell";
import { CommandPalette } from "../palette/CommandPalette";
import { SettingsDialog } from "../settings/SettingsDialog";
import { WhatsNewDialog } from "../whatsnew/WhatsNew";
import { SketchPad } from "../sketch/SketchPad";
import { useAuthStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import type { CoreStatusInfo } from "./types";
import { useAppActions } from "./useAppActions";
import { FirstInstallPrivacy } from "./FirstInstallPrivacy";
import { needsPrivacyScreen, privacyScreenRequired } from "./privacy-gate";

export interface FabdeskAppProps {
  client: CoreClient;
  host?: HostAdapter;
  coreStatus?: CoreStatusInfo | undefined;
  onRestartCore?: (() => void) | undefined;
  /** Extra bridges mounted inside the provider (e.g. WebMCP registration). */
  children?: ReactNode;
}

export function FabdeskApp({ client, host = browserHost, coreStatus, onRestartCore, children }: FabdeskAppProps) {
  return (
    <CoreProvider client={client} host={host}>
      <AppInner coreStatus={coreStatus} onRestartCore={onRestartCore} />
      {children}
    </CoreProvider>
  );
}

function AppInner({ coreStatus, onRestartCore }: { coreStatus?: CoreStatusInfo | undefined; onRestartCore?: (() => void) | undefined }) {
  const { client, host, sseStatus } = useCore();
  const enteredWorkspace = useRef<CoreClient | null>(null);
  useTheme();
  const auth = useAuthState();
  const settings = useSettings();
  const privacyScreen = privacyScreenRequired(usePrivacy());
  const authState = useAuthStore((s) => s.state);
  const setLocalAllowed = useAuthStore((s) => s.setLocalAllowed);
  const actions = useAppActions();
  if (authState?.status === "signed_in") enteredWorkspace.current = client;
  useEffect(() => useAuthStore.subscribe((next, previous) => {
    if (previous.state?.status === "signed_in" && next.state?.status !== "signed_in" && next.state?.mode === "fabplane" && !useUiStore.getState().profileOpen)
      useUiStore.getState().setProfileOpen(true);
  }), [client]);

  useEffect(() => {
    host
      .localAuthAllowed()
      .then(setLocalAllowed)
      .catch(() => setLocalAllowed(false));
  }, [host, setLocalAllowed]);

  const shortcutActions = useMemo(
    () => ({
      newChat: actions.newChat,
      send: actions.send,
      abort: actions.abort,
      pinThread: () => void actions.pinThread(),
      branchThread: () => void actions.branchThread(),
      openSketch: actions.openSketch,
      openSettings: actions.openSettings,
    }),
    [actions],
  );
  useShortcuts(shortcutActions, host.platform);

  // Application menu (Electron): main sends a command for the items it owns; same actions as the shortcuts.
  useEffect(() => {
    if (!host.onMenu) return;
    return host.onMenu((command) => {
      const ui = useUiStore.getState();
      if (ui.profileOpen) return;
      if (command === "new-chat") actions.newChat();
      else if (command === "palette") ui.setPaletteOpen(!ui.paletteOpen);
      else if (command === "settings") actions.openSettings();
      else if (command === "sidebar") ui.toggleSidebar();
      else if (command === "board") ui.toggleBoard();
    });
  }, [host, actions]);

  const banner =
    coreStatus && coreStatus.state !== "ready" ? (
      <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 text-xs">
        <Spinner />
        <span>
          {coreStatus.state === "restarting"
            ? `Core daemon crashed; restarting (attempt ${coreStatus.attempt ?? 1})...`
            : coreStatus.state === "crashed"
              ? `Core daemon crashed: ${coreStatus.message ?? "see logs"}`
              : "Core daemon starting..."}
        </span>
        {coreStatus.state === "crashed" && onRestartCore && (
          <Button size="sm" onClick={onRestartCore} className="ml-auto">
            Restart
          </Button>
        )}
      </div>
    ) : sseStatus === "reconnecting" ? (
      <div className="border-b border-warning/40 bg-warning/10 px-3 py-1 text-xs">Reconnecting to core events...</div>
    ) : null;

  if (!authState || !settings.data || privacyScreen === null) {
    return (
      <div className="fd-update-screen flex h-full flex-col items-center justify-center gap-3 bg-bg text-sm text-muted">
        <Spinner />
        {auth.isError || settings.isError ? (
          <div className="text-center">
            <div className="text-danger">Could not reach the core daemon.</div>
            <div className="mt-1 text-xs">{((auth.error ?? settings.error) as Error).message}</div>
            <Button className="mt-3" onClick={() => { void auth.refetch(); void settings.refetch(); }}>
              Retry
            </Button>
          </div>
        ) : (
          "Connecting to core..."
        )}
        <UpdateBadge />
      </div>
    );
  }
  if (needsPrivacyScreen(settings.data, privacyScreen)) return <div className="flex h-full flex-col">
    <div className="min-h-0 flex-1"><FirstInstallPrivacy /></div><UpdateBadge />
  </div>;
  if (authState.status !== "signed_in" && enteredWorkspace.current !== client) return <><LoginScreen /><ProfileAccountDialog /></>;
  return (
    <>
      <AppShell onNewChat={actions.newChat} coreStatus={coreStatus} banner={banner} />
      <CloseProjectDialog />
      <CommandPalette />
      <SettingsDialog />
      <WhatsNewDialog />
      <SketchPad />
      <ProfileAccountDialog />
    </>
  );
}

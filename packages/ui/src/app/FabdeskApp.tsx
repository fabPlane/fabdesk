import { useEffect, useMemo, type ReactNode } from "react";
import { LoginScreen } from "../auth/LoginScreen";
import { Button, Spinner } from "../components/ui";
import { CoreProvider, browserHost, useCore, type HostAdapter } from "../core/CoreProvider";
import type { CoreClient } from "../core/CoreClient";
import { useAuthState } from "../hooks/queries";
import { useShortcuts } from "../hooks/useShortcuts";
import { useTheme } from "../hooks/useTheme";
import { AppShell } from "../layout/AppShell";
import { CommandPalette } from "../palette/CommandPalette";
import { SettingsDialog } from "../settings/SettingsDialog";
import { SketchPad } from "../sketch/SketchPad";
import { useAuthStore } from "../stores/auth";
import { DRAFT_KEY_NEW, useUiStore } from "../stores/ui";
import type { CoreStatusInfo } from "./types";
import { useAppActions } from "./useAppActions";

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
  const { host, sseStatus } = useCore();
  useTheme();
  const auth = useAuthState();
  const authState = useAuthStore((s) => s.state);
  const setLocalAllowed = useAuthStore((s) => s.setLocalAllowed);
  const actions = useAppActions();
  const addAttachment = useUiStore((s) => s.addAttachment);
  const activeThreadId = useUiStore((s) => s.activeThreadId);

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

  if (!authState) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-sm text-muted">
        <Spinner />
        {auth.isError ? (
          <div className="text-center">
            <div className="text-danger">Could not reach the core daemon.</div>
            <div className="mt-1 text-xs">{(auth.error as Error).message}</div>
            <Button className="mt-3" onClick={() => void auth.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          "Connecting to core..."
        )}
      </div>
    );
  }
  if (authState.status !== "signed_in") return <LoginScreen />;
  return (
    <>
      <AppShell onNewChat={actions.newChat} coreStatus={coreStatus} banner={banner} />
      <CommandPalette />
      <SettingsDialog />
      <SketchPad onAttach={(att) => addAttachment(activeThreadId ?? DRAFT_KEY_NEW, att)} />
    </>
  );
}

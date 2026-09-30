import {
  applyThemeId,
  browserHost,
  CoreClient,
  CoreStatusScreen,
  FabdeskApp,
  themeFromPreference,
  useAuthStore,
  useCoreClient,
  useSettings,
  useUiStore,
  type CoreInfo,
  type HostAdapter,
} from "@fabdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { sentryUserFromAuth } from "../shared/sentry-user";
import { disableRendererSentry, setRendererSentryUser } from "./sentry";
import { startWebMcp } from "./webmcp";

const bridge = window.fabdesk;

/** Applies the persisted Appearance theme even on the core-status screen (no CoreProvider yet). */
function ThemeSync() {
  const stored = useUiStore((s) => s.themeId);
  useEffect(() => {
    applyThemeId(stored ?? themeFromPreference(undefined));
    void bridge?.setTheme(stored);
  }, [stored]);
  return null;
}

const host: HostAdapter = bridge
  ? {
      platform: bridge.platform,
      devBuild: bridge.devBuild,
      openExternal: (url) => bridge.openExternal(url),
      openPath: (path) => bridge.openPath(path),
      pickFile: (opts) => bridge.pickFile(opts),
      localAuthAllowed: () => bridge.localAuthAllowed(),
      setLocalAuth: (enabled) => bridge.setLocalAuth(enabled),
      restartCore: () => bridge.restartCore(),
      showAppMenu: (pos) => bridge.showAppMenu(pos),
      onMenu: (cb) => bridge.onMenu(cb),
      openLogs: () => bridge.openLogs(),
      updateStatus: () => bridge.updateStatus(),
      checkForUpdates: () => bridge.checkForUpdates(),
      onUpdateStatus: (cb) => bridge.onUpdateStatus(cb),
      updateDownloadState: () => bridge.updateDownloadState(),
      downloadUpdate: () => bridge.downloadUpdate(),
      cancelUpdateDownload: () => bridge.cancelUpdateDownload(),
      openUpdate: () => bridge.openUpdate(),
      onUpdateDownload: (cb) => bridge.onUpdateDownload(cb),
    }
  : browserHost;

/** Without the Electron bridge (plain browser), read the daemon address from the query string. */
function webCoreInfo(): CoreInfo {
  const q = new URLSearchParams(location.search);
  const url = q.get("core");
  const token = q.get("token");
  return url && token
    ? { url, token, status: { state: "ready", attached: true } }
    : { url: null, token: null, status: { state: "crashed", message: "no core address: open with ?core=http://127.0.0.1:PORT&token=..." } };
}

/** Re-registers WebMCP tools when the client or the write-tools setting changes. */
function WebMcpBridge() {
  const client = useCoreClient();
  const settings = useSettings();
  const writeTools = settings.data?.webmcpWriteTools ?? false;
  useEffect(() => startWebMcp(client), [client, writeTools]);
  return null;
}

/** Mirrors the `errorReporting` setting into main (persisted opt-out) and stops the renderer client when off. */
function ErrorReportingBridge() {
  const settings = useSettings();
  const enabled = settings.data?.errorReporting;
  useEffect(() => {
    if (enabled === undefined) return;
    void bridge?.setErrorReporting(enabled);
    if (!enabled) void disableRendererSentry();
  }, [enabled]);
  // Sentry user = principal id + handle (never email) while signed in; cleared on logout.
  const auth = useAuthStore((s) => s.state);
  const user = sentryUserFromAuth(auth);
  const userKey = user ? `${user.id}\u0000${user.username ?? ""}` : "";
  useEffect(() => {
    setRendererSentryUser(user);
    void bridge?.setSentryUser(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey]);
  return null;
}

export function App() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  useEffect(() => {
    if (!bridge) {
      setInfo(webCoreInfo());
      return;
    }
    let alive = true;
    bridge
      .coreInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch((e: unknown) => setInfo({ url: null, token: null, status: { state: "crashed", message: String(e) } }));
    const off = bridge.onCoreStatus((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const url = info?.url ?? null;
  const token = info?.token ?? null;
  const client = useMemo(() => (url && token ? new CoreClient({ baseUrl: url, token }) : null), [url, token]);
  // The automation API (dev / FABDESK_AUTOMATION=1) reads these; the token itself is never exposed.
  useEffect(() => {
    if (!bridge?.automationEnabled) return;
    window.__fabdeskRuntime = { client, coreInfo: info ? { url: info.url, token: null, status: info.status } : null };
  }, [client, info]);

  if (!client) {
    return (
      <>
        <ThemeSync />
        <CoreStatusScreen
          status={info?.status ?? null}
          onRestart={bridge ? () => void bridge.restartCore() : undefined}
          onOpenLogs={bridge ? () => void bridge.openLogs() : undefined}
        />
      </>
    );
  }
  return (
    <FabdeskApp client={client} host={host} coreStatus={info?.status} onRestartCore={bridge ? () => void bridge.restartCore() : undefined}>
      <ThemeSync />
      <WebMcpBridge />
      <ErrorReportingBridge />
    </FabdeskApp>
  );
}

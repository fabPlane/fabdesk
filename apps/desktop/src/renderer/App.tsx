import {
  browserHost,
  CoreClient,
  CoreStatusScreen,
  FabdeskApp,
  useCoreClient,
  useSettings,
  type CoreInfo,
  type HostAdapter,
} from "@fabdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { disableRendererSentry } from "./sentry";
import { startWebMcp } from "./webmcp";

const bridge = window.fabdesk;

const host: HostAdapter = bridge
  ? {
      platform: bridge.platform,
      openExternal: (url) => bridge.openExternal(url),
      pickFile: (opts) => bridge.pickFile(opts),
      localAuthAllowed: () => bridge.localAuthAllowed(),
      setLocalAuth: (enabled) => bridge.setLocalAuth(enabled),
      restartCore: () => bridge.restartCore(),
      openLogs: () => bridge.openLogs(),
      updateStatus: () => bridge.updateStatus(),
      checkForUpdates: () => bridge.checkForUpdates(),
      onUpdateStatus: (cb) => bridge.onUpdateStatus(cb),
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

  if (!client) {
    return (
      <CoreStatusScreen
        status={info?.status ?? null}
        onRestart={bridge ? () => void bridge.restartCore() : undefined}
        onOpenLogs={bridge ? () => void bridge.openLogs() : undefined}
      />
    );
  }
  return (
    <FabdeskApp client={client} host={host} coreStatus={info?.status} onRestartCore={bridge ? () => void bridge.restartCore() : undefined}>
      <WebMcpBridge />
      <ErrorReportingBridge />
    </FabdeskApp>
  );
}

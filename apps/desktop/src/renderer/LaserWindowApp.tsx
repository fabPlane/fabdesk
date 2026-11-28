/**
 * Root of the Laser Controller window: connects to the same local core as the main window and shows only
 * the laser controller (packages/ui/src/laser/LaserController.tsx).
 */
import { applyThemeId, CoreClient, CoreProvider, CoreStatusScreen, LaserController, themeFromPreference, useUiStore, type CoreInfo } from "@fabdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { host } from "./App";

const bridge = window.fabdesk;

export function LaserWindowApp() {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const themeId = useUiStore((s) => s.themeId);
  useEffect(() => { applyThemeId(themeId ?? themeFromPreference(undefined)); }, [themeId]);
  useEffect(() => {
    document.title = "Laser Controller";
    if (!bridge) return;
    let alive = true;
    bridge.coreInfo().then((i) => { if (alive) setInfo(i); }).catch((e: unknown) => setInfo({ url: null, token: null, status: { state: "crashed", message: String(e) } }));
    const off = bridge.onCoreStatus((i) => { if (alive) setInfo(i); });
    return () => { alive = false; off(); };
  }, []);
  const url = info?.url ?? null;
  const token = info?.token ?? null;
  const client = useMemo(() => (url && token ? new CoreClient({ baseUrl: url, token }) : null), [url, token]);
  if (!client) return <CoreStatusScreen status={info?.status ?? null} onRestart={bridge ? () => void bridge.restartCore() : undefined} onOpenLogs={bridge ? () => void bridge.openLogs() : undefined} />;
  return (
    <CoreProvider client={client} host={host}>
      <LaserController />
    </CoreProvider>
  );
}

/**
 * The browser client's entry point (no Electron bridge): decides what this page is before there
 * is a core to talk to.
 *
 *   /pair?host=…#token=…   the hosted pairing route — claim, save, then connect
 *   /pair                  the Computers page (switch / remove), also the fallback below
 *   ?core=…&token=…        a daemon named on the URL (the Vite dev flow), never saved
 *   otherwise              the active saved computer, or the Computers page when there is none
 *
 * A saved computer is reached with its device token over the desktop's own `DirectTransport`
 * path — `CoreClient` + SSE — exactly as a `?core=` daemon is; the token is just a different
 * bearer. The Electron app never comes through here: it has a bridge and its own `App`.
 */
import { CoreClient } from "@fabdesk/client-core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { browserHost } from "../core/host";
import { applyThemeId, themeFromPreference } from "../hooks/useTheme";
import { ComputersDialog, ComputersScreen } from "../pair/ComputersPanel";
import type { SavedHost } from "../pair/hosts";
import { isPairPath } from "../pair/parse";
import { PairRoute } from "../pair/PairRoute";
import { activeSavedHost, useSavedHosts, watchSavedHosts } from "../pair/store";
import { useUiStore } from "../stores/ui";
import { FabdeskApp } from "./FabdeskApp";

type Target =
  | { kind: "pair" }
  | { kind: "query"; url: string; token: string }
  | { kind: "saved"; host: SavedHost }
  | { kind: "none" };

function targetFromLocation(): Target {
  // A bare /pair (no link) is the Computers page: the list of what this browser has paired with.
  if (isPairPath(location.pathname))
    return location.search || location.hash ? { kind: "pair" } : { kind: "none" };
  const q = new URLSearchParams(location.search);
  const url = q.get("core");
  const token = q.get("token");
  if (url && token) return { kind: "query", url, token };
  const host = activeSavedHost();
  return host ? { kind: "saved", host } : { kind: "none" };
}

/** Applies the persisted Appearance theme on the screens that exist before a CoreProvider does. */
function ThemeBoot() {
  const stored = useUiStore((s) => s.themeId);
  useEffect(() => {
    applyThemeId(stored ?? themeFromPreference(undefined));
  }, [stored]);
  return null;
}

export function BrowserApp({ children }: { children?: ReactNode }) {
  const [target, setTarget] = useState<Target>(targetFromLocation);
  const saved = useSavedHosts((s) => s.saved);
  useEffect(watchSavedHosts, []);

  // Removing the active computer from the dialog (or another tab doing so) drops the client.
  useEffect(() => {
    if (target.kind !== "saved") return;
    if (!saved.hosts.some((h) => h.host === target.host.host)) setTarget(targetFromLocation());
  }, [saved, target]);

  const client = useMemo(() => {
    if (target.kind === "query")
      return new CoreClient({ baseUrl: target.url, token: target.token });
    if (target.kind === "saved")
      return new CoreClient({ baseUrl: target.host.host, token: target.host.deviceToken });
    return null;
  }, [target]);

  const connectTo = (host: SavedHost) => {
    // Leave /pair behind so a reload does not try to claim again; the token is already gone from the URL.
    history.replaceState(null, "", "/");
    setTarget({ kind: "saved", host });
  };

  if (target.kind === "pair") {
    return (
      <>
        <ThemeBoot />
        <PairRoute onPaired={connectTo} />
      </>
    );
  }
  if (!client) {
    return (
      <>
        <ThemeBoot />
        <ComputersScreen onSwitch={connectTo} />
      </>
    );
  }
  return (
    <FabdeskApp client={client} host={browserHost}>
      <ComputersDialog />
      {children}
    </FabdeskApp>
  );
}

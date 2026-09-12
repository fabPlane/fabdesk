/**
 * Holds the screen on while an agent run is live, if Settings says so. A route or render can take
 * minutes, and the point of watching it from the phone is lost if the screen locks halfway.
 */
import { useRunsStore } from "@fabdesk/client-core";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect } from "react";
import { usePrefs } from "./prefs";

const TAG = "fabdesk.live-run";

export function useKeepAwakeWhileRunning(): void {
  const wanted = usePrefs((s) => s.keepAwake);
  const anyLive = useRunsStore((s) => Object.keys(s.runsByThread).length > 0);
  const hold = wanted && anyLive;
  useEffect(() => {
    if (!hold) return;
    // Both calls reject on platforms without the module (web); nothing to do about it here.
    activateKeepAwakeAsync(TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(TAG).catch(() => {});
    };
  }, [hold]);
}

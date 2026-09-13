/**
 * Keeps the connected daemon's push registration in step with this phone (§3.1): on every
 * successful connect and on every prefs change it PUTs the token, and when the switch is off but
 * this daemon still holds a token — it was asleep when the user turned notifications off — it
 * DELETEs. Mounted by `CoreConnection` inside the provider, once per live transport.
 */
import { useCore, useCoreClient } from "@fabdesk/client-core";
import { useEffect, useRef } from "react";
import { fetchDevicePushToken, registerPushWith, unregisterPushWith } from "./push";
import { useNotificationStore } from "./store";

export function PushRegistrar({ connectionId }: { connectionId: string }) {
  const { sseStatus } = useCore();
  const client = useCoreClient();
  const enabled = useNotificationStore((s) => s.enabled);
  const prefs = useNotificationStore((s) => s.prefs);
  const pushToken = useNotificationStore((s) => s.pushToken);
  const registered = useNotificationStore((s) => s.registered[connectionId]);
  // Tokens rotate rarely; one refresh per app session, on the first open stream, is enough.
  const refreshed = useRef(false);

  useEffect(() => {
    if (sseStatus !== "open") return;
    let cancelled = false;
    void (async () => {
      if (!enabled) {
        if (registered !== undefined) await unregisterPushWith(client, connectionId);
        return;
      }
      let token = pushToken;
      if (!refreshed.current) {
        refreshed.current = true;
        const fresh = await fetchDevicePushToken();
        if (cancelled) return;
        if (fresh.token && fresh.token !== token) {
          token = fresh.token;
          useNotificationStore.getState().setPushToken(token);
          return; // the store change re-runs this effect with the new token
        }
      }
      if (token) await registerPushWith(client, connectionId, token, prefs);
    })();
    return () => {
      cancelled = true;
    };
  }, [sseStatus, enabled, prefs, pushToken, registered, client, connectionId]);

  return null;
}

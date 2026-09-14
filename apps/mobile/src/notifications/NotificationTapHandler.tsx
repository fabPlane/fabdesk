/**
 * A tap on a notification (§4.3): read its `data`, switch to the daemon it came from if that is
 * not the active connection, and open the thread (or Jobs). Handles both a tap while the app is
 * running and the one that launched it. Mounted once in the root layout, under `AppShell` so the
 * connections store is the same one the provider reads.
 */
import { router, useRootNavigationState } from "expo-router";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { navigationFor, parseNotificationData } from "../lib/notification-payload";
import { useConnections } from "../transport/connections";
import { configureNotifications } from "./local";

export function NotificationTapHandler() {
  const hydrated = useConnections((s) => s.hydrated);
  // `key` appears once the navigator is mounted; pushing before that is silently dropped.
  const navReady = !!useRootNavigationState()?.key;
  const pending = useRef<Notifications.NotificationResponse | null>(null);
  const handled = useRef(new Set<string>());

  useEffect(() => {
    configureNotifications();
  }, []);

  useEffect(() => {
    const ready = hydrated && navReady;
    const act = (response: Notifications.NotificationResponse) => {
      if (!ready) {
        pending.current = response;
        return;
      }
      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);
      void open(response);
    };
    if (ready && pending.current) {
      const r = pending.current;
      pending.current = null;
      act(r);
    }
    // The response that launched the app, if any. Cleared once acted on so a later resume of
    // the same process does not replay it.
    void Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        if (r) act(r);
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(act);
    return () => sub.remove();
  }, [hydrated, navReady]);

  return null;
}

async function open(response: Notifications.NotificationResponse): Promise<void> {
  void Notifications.clearLastNotificationResponseAsync().catch(() => {});
  const data = parseNotificationData(response.notification.request.content.data);
  const { connections, activeId, setActive } = useConnections.getState();
  const nav = navigationFor(data, connections, activeId);
  if (nav.switchTo) await setActive(nav.switchTo);
  switch (nav.target.kind) {
    case "thread":
      router.push({ pathname: "/thread/[id]", params: { id: nav.target.threadId } });
      return;
    case "jobs":
      router.push("/jobs");
      return;
    case "chats":
      router.navigate("/(tabs)");
      return;
  }
}

/**
 * Push registration (docs/mobile-notifications.md §3.1, §4.1): getting an Expo push token and
 * telling every paired daemon about it. Delivery itself is the daemon's and fabplane.com's job;
 * the phone only registers, re-registers on connect (tokens rotate), and unregisters on disable.
 *
 * The Expo token needs an EAS project id (`extra.eas.projectId` in app.json — roadmap R1). Until
 * that exists `pushProjectId()` is null, the token is never requested, and only the local
 * notifications in `run-notifier.ts` apply.
 */
import { CoreClient } from "@fabdesk/client-core";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  isExpoPushToken,
  pushRegistration,
  type NotificationPrefs,
} from "../lib/notification-payload";
import { readToken, type Connection } from "../transport/connections";
import { registrationFingerprint, useNotificationStore } from "./store";

export function pushProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The platform a §4.1 registration accepts; null on anything that cannot receive push. */
export function pushPlatform(): "ios" | "android" | null {
  return Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
}

export type PushTokenResult =
  | { token: string; reason?: undefined }
  | { token: null; reason: "no-project" | "no-platform" | "unavailable"; detail?: string };

/**
 * Asks Expo for this install's push token. Talks to Expo's servers, so it can fail offline;
 * callers treat a failure as "try again next connect", never as an error to show.
 */
export async function fetchExpoPushToken(): Promise<PushTokenResult> {
  const projectId = pushProjectId();
  if (!projectId) return { token: null, reason: "no-project" };
  if (!pushPlatform()) return { token: null, reason: "no-platform" };
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!isExpoPushToken(data))
      return { token: null, reason: "unavailable", detail: "unexpected token format" };
    return { token: data };
  } catch (e) {
    return {
      token: null,
      reason: "unavailable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * `PUT /v1/devices/me/push` on one daemon and remember what it accepted, so a later prefs change
 * on a phone that is connected elsewhere knows this one is stale. A daemon that predates the
 * route answers 404; that is recorded as "not registered" and is not an error worth surfacing.
 */
export async function registerPushWith(
  client: CoreClient,
  connectionId: string,
  token: string,
  prefs: NotificationPrefs,
): Promise<boolean> {
  const platform = pushPlatform();
  if (!platform) return false;
  const appVersion = Constants.expoConfig?.version;
  try {
    await client.registerPush(
      pushRegistration({ expoPushToken: token, platform, appVersion, prefs }),
    );
    useNotificationStore
      .getState()
      .noteRegistered(connectionId, registrationFingerprint(token, prefs));
    return true;
  } catch {
    useNotificationStore.getState().noteRegistered(connectionId, null);
    return false;
  }
}

export async function unregisterPushWith(
  client: CoreClient,
  connectionId: string,
): Promise<boolean> {
  try {
    await client.unregisterPush();
    useNotificationStore.getState().noteRegistered(connectionId, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort `DELETE` on every paired daemon this phone ever registered with, using each one's
 * last known address. One that is asleep keeps the token until the next connect, when
 * `PushRegistrar` sees the switch is off and deletes it then.
 */
export async function unregisterPushEverywhere(connections: readonly Connection[]): Promise<void> {
  const { registered } = useNotificationStore.getState();
  await Promise.all(
    connections
      .filter((c) => registered[c.id] !== undefined)
      .map(async (c) => {
        const token = await readToken(c.id);
        if (!token) return;
        await unregisterPushWith(new CoreClient({ baseUrl: c.baseUrl, token }), c.id);
      }),
  );
}

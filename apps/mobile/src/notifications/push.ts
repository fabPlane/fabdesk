/**
 * Push registration (docs/mobile-notifications.md §3.1, §4.1): getting the platform's own push
 * token — APNs on iOS, FCM on Android, via `getDevicePushTokenAsync` — and telling every paired
 * daemon about it. Delivery is the daemon's and fabplane.com's job (which talks to APNs/FCM
 * directly); the phone only registers, re-registers on connect (tokens rotate), and unregisters
 * on disable. No Expo project is involved: a release build with the push entitlement (iOS) or
 * `google-services.json` (Android) is all a native token needs.
 */
import { CoreClient } from "@fabdesk/client-core";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { pushRegistration, type NotificationPrefs } from "../lib/notification-payload";
import { readToken, type Connection } from "../transport/connections";
import { registrationFingerprint, useNotificationStore } from "./store";

/** The platform a §4.1 registration accepts; null on anything that cannot receive push. */
export function pushPlatform(): "ios" | "android" | null {
  return Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
}

export type PushTokenResult =
  | { token: string; reason?: undefined }
  | { token: null; reason: "no-platform" | "unavailable"; detail?: string };

/**
 * Asks the OS for this install's native push token (APNs / FCM). The simulator and debug
 * builds without the entitlement fail here; callers treat a failure as "try again next connect",
 * never as an error to show.
 */
export async function fetchDevicePushToken(): Promise<PushTokenResult> {
  if (!pushPlatform()) return { token: null, reason: "no-platform" };
  try {
    const { data } = await Notifications.getDevicePushTokenAsync();
    if (typeof data !== "string" || !data)
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
    await client.registerPush(pushRegistration({ pushToken: token, platform, appVersion, prefs }));
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

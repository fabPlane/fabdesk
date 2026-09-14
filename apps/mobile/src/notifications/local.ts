/**
 * The expo-notifications calls, in one place: presentation policy, the Android channel, the iOS
 * category, the permission prompt, and scheduling one local notification.
 *
 * Nothing here is called on launch except `configureNotifications()`, which only registers
 * policy — the permission prompt is behind the Settings toggle so the first thing a new user
 * sees is not a system dialog.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { NotificationData } from "../lib/notification-payload";

/** Android channel every run notification lands in; the daemon's push uses the same id (§4.2). */
export const RUNS_CHANNEL_ID = "runs";
/** iOS category (§7): no actions yet; approvals from the lock screen come with the relay. */
export const RUN_CATEGORY_ID = "run";

let configured = false;

/**
 * Foreground: show nothing (§3.3 — the thread is on screen or one tap away). This handler is
 * only consulted while the app is active; a notification scheduled from the background is
 * presented by the OS regardless.
 */
export function configureNotifications(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    void Notifications.setNotificationChannelAsync(RUNS_CHANNEL_ID, {
      name: "Runs",
      description: "When an agent run finishes, fails or needs you.",
      importance: Notifications.AndroidImportance.HIGH,
    }).catch(() => {});
  }
  if (Platform.OS === "ios") {
    void Notifications.setNotificationCategoryAsync(RUN_CATEGORY_ID, []).catch(() => {});
  }
}

export async function hasNotificationPermission(): Promise<boolean> {
  try {
    const s = await Notifications.getPermissionsAsync();
    return s.granted || s.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

/** Shows the OS prompt (once; afterwards the OS answers from Settings). True when we may notify. */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const s = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    return s.granted || s.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

/** Fires now. The `data` is the §4.3 payload the tap handler reads back. */
export async function scheduleLocalNotification(input: {
  title: string;
  body: string;
  data: NotificationData;
}): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: input.title,
      body: input.body,
      data: { ...input.data },
      sound: true,
      ...(Platform.OS === "ios" ? { categoryIdentifier: RUN_CATEGORY_ID } : {}),
    },
    trigger: Platform.OS === "android" ? { channelId: RUNS_CHANNEL_ID } : null,
  });
}

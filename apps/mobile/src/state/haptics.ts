/**
 * One call site for haptics so the Settings toggle is honoured everywhere. Fire-and-forget: a
 * device without a Taptic Engine (or a simulator) rejects, and nobody needs to know.
 */
import * as Haptics from "expo-haptics";
import { usePrefs } from "./prefs";

export type HapticKind = "selection" | "tap" | "success" | "warning" | "error";

export function haptic(kind: HapticKind): void {
  if (!usePrefs.getState().haptics) return;
  const run =
    kind === "selection"
      ? Haptics.selectionAsync()
      : kind === "tap"
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        : Haptics.notificationAsync(
            kind === "success"
              ? Haptics.NotificationFeedbackType.Success
              : kind === "warning"
                ? Haptics.NotificationFeedbackType.Warning
                : Haptics.NotificationFeedbackType.Error,
          );
  run.catch(() => {});
}

/**
 * When the app leaves the foreground the event socket has to go, deliberately, before the OS
 * suspends the process: a suspended app's socket is half-open, the daemon still counts the
 * phone as connected, and it neither pushes (docs/mobile-notifications.md §3.2) nor can the
 * app show a local notification. So the phone keeps the socket for a short grace window —
 * long enough for a run that is about to finish to notify locally — and then closes it
 * itself; from then on the daemon pushes through APNs/FCM. Coming back to the foreground
 * reopens the stream.
 */
import type { AppStateLike } from "./reconnect";

/** Slightly under the ~25 s of background execution `fabdesk-background-grace` buys on iOS. */
export const DORMANT_AFTER_MS = 20_000;

export type DormancyAction = "arm" | "wake" | "none";

/**
 * What an app-state change means for the socket: leaving the foreground arms the close timer,
 * returning cancels it (or reopens the stream if it already fired). `inactive` alone — a
 * notification shade pulled down, the app switcher — is not leaving.
 */
export function dormancyAction(prev: AppStateLike | null, next: AppStateLike): DormancyAction {
  if (next === "background" && prev !== "background") return "arm";
  if (next === "active" && prev !== "active") return "wake";
  return "none";
}

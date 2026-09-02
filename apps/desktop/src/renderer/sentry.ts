/**
 * Sentry for the renderer (`@sentry/electron/renderer` wrapping `@sentry/react`). Import this before React mounts.
 *
 * The renderer never holds the DSN: events go to the main process over the IPC the preload exposes and are
 * sent (and scrubbed again) there, inheriting main's `release` and `environment` (built from the same
 * `VITE_SENTRY_*` values). It initializes only when main reports that reporting is on, which the preload learns
 * from the `--fabdesk-error-reporting` argument main passes to the window.
 */
import { init as electronRendererInit } from "@sentry/electron/renderer";
import * as Sentry from "@sentry/react";
import { scrubBreadcrumb, scrubEvent } from "../shared/sentry-scrub";
import type { SentryUser } from "../shared/sentry-user";

export const sentryEnabled = window.fabdesk?.errorReporting === true;

if (sentryEnabled) {
  try {
    electronRendererInit(
      {
        sendDefaultPii: false,
        tracesSampleRate: 0,
        initialScope: { tags: { service: "desktop-renderer", process: "renderer" } },
        beforeSend: (event) => scrubEvent(event),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      },
      Sentry.init,
    );
    // FABDESK_SENTRY_TEST=1: one handled test event; main forwards this console line to its stderr.
    if (window.fabdesk?.sentryTest) {
      const id = Sentry.captureException(new Error("fabdesk sentry test renderer"));
      void Sentry.flush(5000).then((flushed) =>
        console.error(`[sentry] test event process=renderer id=${id} flushed=${String(flushed)}`),
      );
    }
  } catch (e) {
    console.error("[sentry] renderer init failed", e);
  }
}

/** Sentry user (id + handle only, never email); `null` clears it on logout. */
export function setRendererSentryUser(user: SentryUser | null): void {
  if (!Sentry.getClient()) return;
  Sentry.setUser(user);
}

/** Opt-out at runtime: flush and stop the renderer client (re-enabling applies at the next launch). */
export async function disableRendererSentry(): Promise<void> {
  if (!Sentry.getClient()) return;
  await Sentry.close(1000).catch(() => {});
}

export { Sentry };

/**
 * Sentry for the renderer (`@sentry/electron/renderer` wrapping `@sentry/react`). Import this before React mounts.
 *
 * The renderer never holds the DSN: events go to the main process over the IPC the preload exposes and are
 * sent (and scrubbed again) there. It initializes only when main reports that reporting is on, which the
 * preload learns from the `--fabdesk-error-reporting` argument main passes to the window.
 */
import { init as electronRendererInit } from "@sentry/electron/renderer";
import * as Sentry from "@sentry/react";
import { scrubBreadcrumb, scrubEvent } from "../shared/sentry-scrub";

export const sentryEnabled = window.fabdesk?.errorReporting === true;

if (sentryEnabled) {
  try {
    electronRendererInit(
      {
        sendDefaultPii: false,
        tracesSampleRate: 0,
        initialScope: { tags: { service: "desktop-renderer" } },
        beforeSend: (event) => scrubEvent(event),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      },
      Sentry.init,
    );
  } catch (e) {
    console.error("[sentry] renderer init failed", e);
  }
}

/** Opt-out at runtime: flush and stop the renderer client (re-enabling applies at the next launch). */
export async function disableRendererSentry(): Promise<void> {
  if (!Sentry.getClient()) return;
  await Sentry.close(1000).catch(() => {});
}

export { Sentry };

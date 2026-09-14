/**
 * Sentry for the phone (docs/mobile-release.md, docs/sentry.md for the desktop's conventions).
 * Errors only: unhandled JS errors and native crashes via the SDK's own handlers, plus the three
 * transport failures `lib/transport-failures` singles out. No tracing, no session replay, no
 * screenshots, no failed-request capture, no PII — the app talks to the user's own computer and
 * nothing about that conversation belongs in a third party's dashboard.
 *
 * The DSN reaches the bundle as `extra.sentryDsn`, put there by `app.config.ts` from
 * `SENTRY_DSN_MOBILE` at build time; with none set every call below is a no-op, so dev builds and
 * CI report nothing. `release` and `dist` are left to the SDK, which reads the native bundle
 * version and build number — the same values `sentry-cli` names the uploaded source maps with.
 *
 * Importing this module initialises the SDK, so `app/_layout.tsx` imports it first.
 */
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  createFailureDeduper,
  transportFailure,
  type ConnectionSnapshot,
} from "@/lib/transport-failures";
import { useConnection } from "@/transport/CoreConnection";

const extra = Constants.expoConfig?.extra as
  | { sentryDsn?: unknown; sentryEnvironment?: unknown }
  | undefined;
const dsn = typeof extra?.sentryDsn === "string" && extra.sentryDsn ? extra.sentryDsn : null;

export const observabilityEnabled = dsn !== null;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      typeof extra?.sentryEnvironment === "string" ? extra.sentryEnvironment : "development",
    sendDefaultPii: false,
    // Errors only. Each of these is on by default in the RN SDK.
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,
    enableAppStartTracking: false,
    enableNativeFramesTracking: false,
    enableStallTracking: false,
    enableUserInteractionTracing: false,
    enableAutoSessionTracking: false,
    enableCaptureFailedRequests: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    // Breadcrumbs stay on, minus anything that could carry a pairing token or message text.
    beforeBreadcrumb(crumb) {
      if (crumb.category === "xhr" || crumb.category === "fetch" || crumb.category === "console") {
        return null;
      }
      return crumb;
    },
  });
  Sentry.setTag("platform", Platform.OS);
}

/** `daemonVersion` and `coreId` name the computer an event came from; both are set once known. */
export function setCoreTags(tags: { daemonVersion?: string | null; coreId?: string | null }) {
  if (!observabilityEnabled) return;
  if (tags.daemonVersion !== undefined)
    Sentry.setTag("daemonVersion", tags.daemonVersion ?? undefined);
  if (tags.coreId !== undefined) Sentry.setTag("coreId", tags.coreId ?? undefined);
}

/**
 * Mounted once under `AppShell` (so the connection provider is above it). Renders nothing: it
 * mirrors the connection's version/coreId into tags and turns the transitions
 * `transportFailure` cares about into events.
 */
export function Observability(): null {
  const { phase, status, error, health, connection } = useConnection();
  const prev = useRef<ConnectionSnapshot | null>(null);
  const deduper = useRef(createFailureDeduper());

  const daemonVersion = health?.version ?? null;
  const coreId = health?.coreId ?? connection?.coreId ?? null;
  useEffect(() => {
    setCoreTags({ daemonVersion, coreId });
  }, [daemonVersion, coreId]);

  useEffect(() => {
    if (!observabilityEnabled) return;
    const next: ConnectionSnapshot = { phase, status, error, app: AppState.currentState };
    const failure = transportFailure(prev.current, next);
    prev.current = next;
    if (failure && deduper.current.shouldReport(failure, Date.now())) {
      Sentry.captureMessage(failure.message, {
        level: failure.level,
        fingerprint: ["transport", failure.key],
        tags: { transport: failure.key, phase, stream: status },
      });
    }
  }, [phase, status, error]);

  return null;
}

/**
 * Sentry for the Electron main process (`@sentry/electron/main`). See docs/sentry.md.
 *
 * Off unless a DSN is configured: `FABDESK_SENTRY_DSN` at runtime, else `VITE_FABDESK_SENTRY_DSN` baked in
 * at build time. Renderer events are relayed through this process (IPC exposed by src/preload), so the
 * `beforeSend` / `beforeBreadcrumb` scrubbers here cover them as well. The user's `errorReporting` setting
 * (core `/settings`, default on) is mirrored into desktop-prefs.json so an opted-out user never initializes
 * the SDK; turning it off at runtime closes the client, turning it back on applies at the next launch.
 */
import * as Sentry from "@sentry/electron/main";
import { app } from "electron";
import type { CoreInfo } from "../shared/core-info";
import { scrubBreadcrumb, scrubEvent } from "../shared/sentry-scrub";
import { readPrefs, writePrefs } from "./local-mode";

export interface SentryConfig {
  dsn: string | undefined;
  environment: string;
  release: string;
  channel: string;
}

/** Native crash minidumps are raw process memory and may contain prompts or tokens; keep them off. */
const DISABLED_INTEGRATIONS = new Set(["ElectronMinidump"]);

let active = false;
let initialized = false;

export function sentryConfig(env: NodeJS.ProcessEnv = process.env): SentryConfig {
  const runtime = env["FABDESK_SENTRY_DSN"];
  const compiled = import.meta.env.VITE_FABDESK_SENTRY_DSN;
  // An explicitly empty runtime value disables a compiled-in DSN.
  const dsn = runtime !== undefined ? runtime.trim() || undefined : compiled?.trim() || undefined;
  const channel = env["FABDESK_CHANNEL"] === "internal" ? "internal" : "public";
  return {
    dsn,
    environment:
      env["FABDESK_SENTRY_ENVIRONMENT"] || (app.isPackaged ? "production" : "development"),
    release: `fabdesk@${app.getVersion()}`,
    channel,
  };
}

/** Cached copy of the core's `errorReporting` setting (default on). */
export function errorReportingPref(): boolean {
  return readPrefs().errorReporting !== false;
}

/** True while the SDK is initialized and not closed by an opt-out. */
export function sentryActive(): boolean {
  return active;
}

/** Call before `app.whenReady()`: the SDK registers its IPC protocol scheme at init. Never throws. */
export function initSentry(): boolean {
  if (initialized) return active;
  const cfg = sentryConfig();
  if (!cfg.dsn || !errorReportingPref()) return false;
  try {
    Sentry.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      release: cfg.release,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      attachScreenshot: false,
      integrations: (defaults) => defaults.filter((i) => !DISABLED_INTEGRATIONS.has(i.name)),
      initialScope: { tags: { service: "desktop-main", channel: cfg.channel } },
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
    initialized = true;
    active = true;
  } catch (e) {
    console.error("[sentry] init failed; error reporting disabled", e);
  }
  return active;
}

/** Env handed to the core so one DSN/environment configures both processes. Empty when reporting is off. */
export function coreSentryEnv(): Record<string, string> {
  if (!active) return {};
  const cfg = sentryConfig();
  return {
    ...(cfg.dsn ? { FABDESK_SENTRY_DSN: cfg.dsn } : {}),
    FABDESK_SENTRY_ENVIRONMENT: cfg.environment,
  };
}

/** Applies the user's `errorReporting` setting: persists it and closes the SDK when turned off. */
export async function setErrorReporting(enabled: boolean): Promise<void> {
  if (readPrefs().errorReporting !== enabled) writePrefs({ errorReporting: enabled });
  if (!enabled && active) {
    active = false;
    await Sentry.close(2000).catch(() => {});
  }
}

/** Once the core is ready, adopt its persisted `errorReporting` setting (the source of truth). */
export async function syncErrorReportingFromCore(info: CoreInfo): Promise<void> {
  if (!info.url || !info.token) return;
  try {
    const res = await fetch(`${info.url}/settings`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return;
    const s = (await res.json()) as { errorReporting?: unknown };
    if (typeof s.errorReporting === "boolean") await setErrorReporting(s.errorReporting);
  } catch {
    // core unreachable; keep the cached preference
  }
}

export function captureMainException(error: unknown, tags: Record<string, string> = {}): void {
  if (!active) return;
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    Sentry.captureException(error);
  });
}

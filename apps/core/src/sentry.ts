/**
 * Sentry for fabdesk-core (`@sentry/bun`). See docs/sentry.md.
 *
 * Off unless a DSN is configured: `FABDESK_SENTRY_DSN` at runtime (the desktop forwards its own), else the
 * `FABDESK_SENTRY_DSN` compile-time define from scripts/build.ts. The user's `errorReporting` setting
 * (default on) closes the client when off. Captured context is limited to tags (service, channel, job kind,
 * agent id, route pattern); prompts, file contents, tokens and paths are never attached.
 */
import * as Sentry from "@sentry/bun";
import { VERSION, channel } from "./config";

declare const FABDESK_SENTRY_DSN: string | undefined;
declare const FABDESK_COMPILED: boolean | undefined;

const FILTERED = "[Filtered]";
const QUERY_SECRET_RE =
  /([?&#](?:token|access_token|refresh_token|authorization|api_key|apikey)=)[^&#\s"']*/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

let active = false;
let initialized = false;

export function scrubText(text: string): string {
  return text.replace(QUERY_SECRET_RE, `$1${FILTERED}`).replace(BEARER_RE, `$1${FILTERED}`);
}

type Scrubbable = {
  message?: string;
  request?: {
    url?: string;
    data?: unknown;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    query_string?: unknown;
  };
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
};

/** `beforeSend`: no bodies, cookies, auth headers or tokens; drops breadcrumbs for the token stream URLs. */
export function scrubEvent<T extends Scrubbable>(event: T): T {
  if (event.request) {
    const req = { ...event.request };
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.url) req.url = scrubText(req.url);
    if (req.headers)
      req.headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter(([k]) => !SECRET_HEADERS.has(k.toLowerCase()))
          .map(([k, v]) => [k, scrubText(v)]),
      );
    event.request = req;
  }
  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.exception?.values)
    event.exception = {
      ...event.exception,
      values: event.exception.values.map((v) =>
        typeof v.value === "string" ? { ...v, value: scrubText(v.value) } : v,
      ),
    };
  if (event.breadcrumbs)
    event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter((b) => b !== null);
  return event;
}

/** `beforeBreadcrumb`: drops `/events?token=` and `/ws?token=` crumbs, filters tokens elsewhere. */
export function scrubBreadcrumb<T extends { message?: string; data?: Record<string, unknown> }>(
  b: T,
): T | null {
  const url = typeof b.data?.["url"] === "string" ? b.data["url"] : "";
  if (
    /\/(?:events|ws)\?(?:.*&)?token=/i.test(url) ||
    (b.message !== undefined && /\/(?:events|ws)\?(?:.*&)?token=/i.test(b.message))
  )
    return null;
  const out: T = { ...b };
  if (typeof out.message === "string") out.message = scrubText(out.message);
  if (out.data) {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.data)) {
      if (k === "headers" || k === "request_headers" || k === "response_headers") continue;
      data[k] = typeof v === "string" ? scrubText(v) : v;
    }
    out.data = data;
  }
  return out;
}

export function sentryDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runtime = env["FABDESK_SENTRY_DSN"];
  // An explicitly empty runtime value disables a compiled-in DSN.
  if (runtime !== undefined) return runtime.trim() || undefined;
  const compiled = typeof FABDESK_SENTRY_DSN === "string" ? FABDESK_SENTRY_DSN : undefined;
  return compiled?.trim() || undefined;
}

export function sentryEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const compiled = typeof FABDESK_COMPILED === "boolean" && FABDESK_COMPILED;
  return env["FABDESK_SENTRY_ENVIRONMENT"] || (compiled ? "production" : "development");
}

export function sentryActive(): boolean {
  return active;
}

/** No-op (returns false) without a DSN. Safe to call once per process; never throws. */
export function initSentry(opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  if (initialized) return active;
  const env = opts.env ?? process.env;
  const dsn = sentryDsn(env);
  if (!dsn) return false;
  try {
    Sentry.init({
      dsn,
      environment: sentryEnvironment(env),
      release: `fabdesk-core@${VERSION}`,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      initialScope: { tags: { service: "core", channel: channel() } },
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
    initialized = true;
    active = true;
  } catch (e) {
    process.stderr.write(
      `sentry init failed; error reporting disabled: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return active;
}

/** Honors the `errorReporting` setting: closes the client when off (turning it on applies at next start). */
export async function applyErrorReporting(enabled: boolean): Promise<void> {
  if (!enabled && active) {
    active = false;
    await Sentry.close(1000).catch(() => {});
  }
}

export async function closeSentry(timeoutMs = 2000): Promise<void> {
  if (!active) return;
  active = false;
  await Sentry.close(timeoutMs).catch(() => {});
}

/** Captures an exception with string tags only (never prompts, file contents, tokens or paths). */
export function captureCoreException(
  error: unknown,
  tags: Record<string, string | undefined> = {},
): void {
  if (!active) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(tags)) if (v !== undefined) scope.setTag(k, v);
    Sentry.captureException(error);
  });
}

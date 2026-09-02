/**
 * Sentry for fabdesk-core (`@sentry/bun`). See docs/sentry.md.
 *
 * Off unless a DSN is configured: `SENTRY_DESKTOP_DSN` (or legacy `FABDESK_SENTRY_DSN`) at runtime (the desktop
 * forwards its own), else the `FABDESK_SENTRY_DSN` compile-time define from scripts/build.ts. The user's
 * `errorReporting` setting (default on) closes the client when off. Captured context is limited to tags
 * (service, process, channel, job kind, agent id, route pattern) and the user's id + handle; prompts, file
 * contents, tokens and paths are never attached.
 */
import * as Sentry from "@sentry/bun";
import type { AuthState } from "@fabdesk/protocol";
import { VERSION, channel } from "./config";

declare const FABDESK_SENTRY_DSN: string | undefined;
declare const FABDESK_SENTRY_ENVIRONMENT: string | undefined;
declare const FABDESK_SENTRY_RELEASE: string | undefined;
declare const FABDESK_COMPILED: boolean | undefined;

const FILTERED = "[Filtered]";
const QUERY_SECRET_RE =
  /([?&#](?:token|access_token|refresh_token|authorization|api_key|apikey)=)[^&#\s"']*/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
/** Absolute paths to project files (they sit under the user's home): keep only the file name. */
const PROJECT_FILE_RE =
  /(?<![\w:./\\-])(?:[A-Za-z]:)?[\\/](?:[^\s"'`<>]*[\\/])?(fabdesk\.json|circuit(?:\.routed)?\.(?:tsx|json))\b/g;
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);
/** `extra` keys that could carry prompts, file contents or credentials are removed outright. */
const SECRET_EXTRA_KEY_RE =
  /prompt|circuit|source|content|file|path|body|token|secret|password|cookie|auth|env/i;

let active = false;
let initialized = false;

export function scrubText(text: string): string {
  return text
    .replace(QUERY_SECRET_RE, `$1${FILTERED}`)
    .replace(BEARER_RE, `$1${FILTERED}`)
    .replace(PROJECT_FILE_RE, "[project]/$1");
}

type Scrubbable = {
  message?: string;
  extra?: Record<string, unknown>;
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

/** `beforeSend`: no bodies, cookies, auth headers, tokens or project paths; drops breadcrumbs for the token stream URLs. */
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
  if (event.extra) {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.extra))
      if (!SECRET_EXTRA_KEY_RE.test(k)) extra[k] = typeof v === "string" ? scrubText(v) : v;
    event.extra = extra;
  }
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

/** First defined runtime value wins; an explicitly empty runtime value disables the compiled-in fallback. */
function pick(
  runtime: Array<string | undefined>,
  compiled: Array<string | undefined>,
): string | undefined {
  const rt = runtime.find((v) => v !== undefined);
  if (rt !== undefined) return rt.trim() || undefined;
  return compiled.find((v) => v !== undefined && v.trim() !== "")?.trim();
}

const compiledDsn = (): string | undefined =>
  typeof FABDESK_SENTRY_DSN === "string" ? FABDESK_SENTRY_DSN : undefined;
const compiledEnvironment = (): string | undefined =>
  typeof FABDESK_SENTRY_ENVIRONMENT === "string" ? FABDESK_SENTRY_ENVIRONMENT : undefined;
const compiledRelease = (): string | undefined =>
  typeof FABDESK_SENTRY_RELEASE === "string" ? FABDESK_SENTRY_RELEASE : undefined;

export function sentryDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return pick([env["SENTRY_DESKTOP_DSN"], env["FABDESK_SENTRY_DSN"]], [compiledDsn()]);
}

export function sentryEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const compiled = typeof FABDESK_COMPILED === "boolean" && FABDESK_COMPILED;
  return (
    pick([env["SENTRY_ENVIRONMENT"], env["FABDESK_SENTRY_ENVIRONMENT"]], [compiledEnvironment()]) ??
    (compiled ? "production" : "development")
  );
}

/** `fabdesk-core@<version>+<git-sha>` (sha from scripts/build.ts; `dev` when running from source). */
export function sentryRelease(env: NodeJS.ProcessEnv = process.env): string {
  return (
    pick([env["SENTRY_RELEASE"], env["FABDESK_SENTRY_RELEASE"]], [compiledRelease()]) ??
    `fabdesk-core@${VERSION}+dev`
  );
}

export function sentryActive(): boolean {
  return active;
}

/** `FABDESK_SENTRY_TEST=1`: capture one handled test exception at startup (docs/sentry.md). */
export function sentryTestRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["FABDESK_SENTRY_TEST"] === "1";
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
      release: sentryRelease(env),
      tracesSampleRate: 0,
      sendDefaultPii: false,
      initialScope: { tags: { service: "core", process: "core", channel: channel() } },
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

export interface SentryUser {
  id: string;
  username?: string;
}

/** id + handle only, never email; `local:dev` in local mode; `null` unless signed in. */
export function sentryUserFromAuth(
  state: Pick<AuthState, "mode" | "status" | "principal"> | null | undefined,
): SentryUser | null {
  if (!state || state.status !== "signed_in") return null;
  if (state.mode === "local") return { id: "local:dev", username: "local" };
  const p = state.principal;
  if (!p) return null;
  return { id: p.subject, ...(p.handle ? { username: p.handle } : {}) };
}

/** Global scope so the user applies to every event regardless of the request/async context it came from. */
export function setSentryUser(user: SentryUser | null): void {
  if (!initialized) return;
  Sentry.getGlobalScope().setUser(user);
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

/** Sends the core test event when `FABDESK_SENTRY_TEST=1`; prints the event id to stderr. */
export async function runSentryTest(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!active || !sentryTestRequested(env)) return;
  const id = Sentry.captureException(new Error("fabdesk sentry test core"));
  const flushed = await Sentry.flush(5000).catch(() => false);
  process.stderr.write(
    `[sentry] test event process=core id=${id} flushed=${String(flushed)} release=${sentryRelease(env)} environment=${sentryEnvironment(env)}\n`,
  );
}
